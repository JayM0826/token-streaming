import assert from "node:assert/strict";
import test from "node:test";
import {
  MarketplaceDomainError,
  activateSupplier,
  publishCapacityOffer,
  recordProviderAuthorization,
  recordSupplierVerification,
  registerSupplier,
  rehydrateCapacityOffer,
  rehydrateSupplier,
  requiredVerificationKinds,
  revokeProviderAuthorization,
  suspendSupplier
} from "../dist/index.js";

test("individual suppliers can activate subscription capacity and publish an offer", () => {
  const history = [];
  append(history, registerSupplier(individualRegistration(), context("tenant_individual", 0)));
  append(history, verification(history, "identity", 1));
  append(history, verification(history, "tax", 2));
  append(history, verification(history, "payout", 3));
  append(
    history,
    recordProviderAuthorization(current(history), subscriptionAuthorization(), context("tenant_individual", 4))
  );
  append(history, activateSupplier(current(history), context("tenant_individual", 5)));

  const supplier = current(history);
  const published = publishCapacityOffer(supplier, offerInput(), context("tenant_individual", 6));
  const offer = rehydrateCapacityOffer([published]);

  assert.equal(supplier.kind, "individual");
  assert.equal(supplier.status, "active");
  assert.equal(supplier.authorizations[0]?.sourceType, "subscription-plan");
  assert.equal(offer?.supplierId, supplier.supplierId);
  assert.equal(offer?.sourceType, "subscription-plan");
  assert.equal(offer?.status, "active");
  assert.deepEqual(requiredVerificationKinds("individual"), ["identity", "tax", "payout"]);
});

test("organizations use the same aggregate with explicit KYB requirements", () => {
  const history = [];
  append(
    history,
    registerSupplier(
      {
        supplierId: "supplier_organization",
        kind: "organization",
        legalName: "Example Compute Ltd",
        displayName: "Example Compute",
        countryCode: "SG",
        taxResidenceCountryCode: "SG"
      },
      context("tenant_organization", 0)
    )
  );
  for (const [index, kind] of ["business", "tax", "payout"].entries()) {
    append(
      history,
      recordSupplierVerification(
        current(history),
        verificationInput(kind, index + 1),
        context("tenant_organization", index + 1)
      )
    );
  }
  append(
    history,
    recordProviderAuthorization(
      current(history),
      { ...subscriptionAuthorization(), authorizationId: "authorization_org", sourceType: "api-project" },
      context("tenant_organization", 4)
    )
  );

  assertDomainError(
    () => activateSupplier(current(history), context("tenant_organization", 5)),
    "VERIFICATION_INCOMPLETE"
  );
  append(
    history,
    recordSupplierVerification(
      current(history),
      verificationInput("beneficial-ownership", 6),
      context("tenant_organization", 6)
    )
  );
  append(history, activateSupplier(current(history), context("tenant_organization", 7)));

  assert.equal(current(history).status, "active");
  assert.deepEqual(requiredVerificationKinds("organization"), ["business", "beneficial-ownership", "tax", "payout"]);
});

test("onboarding rejects raw credentials and reusable login state", () => {
  assertDomainError(
    () =>
      registerSupplier(
        { ...individualRegistration(), openaiApiKey: "must-not-enter-domain" },
        context("tenant_individual", 0)
      ),
    "CREDENTIAL_MATERIAL_REJECTED"
  );

  const history = [registerSupplier(individualRegistration(), context("tenant_individual", 1))];
  assertDomainError(
    () =>
      recordProviderAuthorization(
        current(history),
        { ...subscriptionAuthorization(), nested: { cookies: "must-not-enter-domain" } },
        context("tenant_individual", 2)
      ),
    "CREDENTIAL_MATERIAL_REJECTED"
  );
  assertDomainError(
    () => registerSupplier({ ...individualRegistration(), unsupportedProfile: "extra" }, context("tenant_individual", 3)),
    "INVALID_ARGUMENT"
  );
});

test("supplier commands enforce tenant ownership", () => {
  const history = [registerSupplier(individualRegistration(), context("tenant_individual", 0))];
  assertDomainError(
    () =>
      recordSupplierVerification(
        current(history),
        verificationInput("identity", 1),
        context("tenant_attacker", 1)
      ),
    "TENANT_MISMATCH"
  );
});

test("supplier commands reject stale time and unsupported sensitive authorization", () => {
  const staleHistory = [registerSupplier(individualRegistration(), context("tenant_individual", 2))];
  assertDomainError(
    () =>
      recordSupplierVerification(
        current(staleHistory),
        verificationInput("identity", 1),
        context("tenant_individual", 1)
      ),
    "INVALID_ARGUMENT"
  );

  const history = [registerSupplier(individualRegistration(), context("tenant_individual", 0))];
  assertDomainError(
    () =>
      recordProviderAuthorization(
        current(history),
        { ...subscriptionAuthorization(), allowedDataClasses: ["P0", "P2"] },
        context("tenant_individual", 1)
      ),
    "UNSUPPORTED_DATA_CLASS"
  );
});

test("capacity offers cannot exceed provider authorization scope", () => {
  const supplier = activeIndividualSupplier();
  assertDomainError(
    () => publishCapacityOffer(supplier, { ...offerInput(), model: "different-model" }, context("tenant_individual", 6)),
    "AUTHORIZATION_SCOPE_MISMATCH"
  );
  assertDomainError(
    () => publishCapacityOffer(supplier, { ...offerInput(), regionCode: "DE" }, context("tenant_individual", 6)),
    "AUTHORIZATION_SCOPE_MISMATCH"
  );
  assertDomainError(
    () => publishCapacityOffer(supplier, { ...offerInput(), dataClasses: ["P3"] }, context("tenant_individual", 6)),
    "UNSUPPORTED_DATA_CLASS"
  );
  assertDomainError(
    () =>
      publishCapacityOffer(
        supplier,
        { ...offerInput(), limits: { ...offerInput().limits, concurrency: 5 } },
        context("tenant_individual", 6)
      ),
    "AUTHORIZATION_SCOPE_MISMATCH"
  );
  const publicOnlySupplier = activeIndividualSupplier({ allowedDataClasses: ["P0"] });
  assertDomainError(
    () => publishCapacityOffer(publicOnlySupplier, offerInput(), context("tenant_individual", 6)),
    "AUTHORIZATION_SCOPE_MISMATCH"
  );
  assertDomainError(
    () => publishCapacityOffer(supplier, { ...offerInput(), rates: [null] }, context("tenant_individual", 6)),
    "INVALID_ARGUMENT"
  );
});

test("expired or rejected KYC fails closed before a new offer", () => {
  const expiringHistory = buildActiveIndividualHistory();
  append(
    expiringHistory,
    recordSupplierVerification(
      current(expiringHistory),
      {
        ...verificationInput("identity", 6),
        verificationId: "verification_identity_expiring",
        expiresAt: timestamp(7)
      },
      context("tenant_individual", 6)
    )
  );
  assertDomainError(
    () => publishCapacityOffer(current(expiringHistory), offerInput(), context("tenant_individual", 8)),
    "VERIFICATION_INCOMPLETE"
  );

  const history = buildActiveIndividualHistory();
  append(
    history,
    recordSupplierVerification(
      current(history),
      {
        ...verificationInput("identity", 7),
        verificationId: "verification_identity_recheck",
        status: "rejected"
      },
      context("tenant_individual", 7)
    )
  );

  assertDomainError(
    () => publishCapacityOffer(current(history), offerInput(), context("tenant_individual", 8)),
    "VERIFICATION_INCOMPLETE"
  );
});

test("authorization revocation and supplier suspension fail closed", () => {
  const history = buildActiveIndividualHistory();
  append(
    history,
    revokeProviderAuthorization(
      current(history),
      { authorizationId: "authorization_personal", reasonCode: "provider_revoked" },
      context("tenant_individual", 6)
    )
  );
  assertDomainError(
    () => publishCapacityOffer(current(history), offerInput(), context("tenant_individual", 7)),
    "AUTHORIZATION_REQUIRED"
  );

  append(history, suspendSupplier(current(history), { reasonCode: "risk_review" }, context("tenant_individual", 8)));
  assert.equal(current(history).status, "suspended");
  assertDomainError(
    () => publishCapacityOffer(current(history), offerInput(), context("tenant_individual", 9)),
    "INVALID_SUPPLIER_STATE"
  );
});

test("supplier rehydration rejects duplicate or non-contiguous events", () => {
  const registered = registerSupplier(individualRegistration(), context("tenant_individual", 0));
  const broken = { ...registered, aggregateVersion: 2 };
  const verified = recordSupplierVerification(
    rehydrateSupplier([registered]),
    verificationInput("identity", 1),
    context("tenant_individual", 1)
  );
  const duplicateCommand = {
    ...verified,
    eventId: "event_tenant_individual_retry",
    causationId: registered.causationId
  };
  assertDomainError(() => rehydrateSupplier([broken]), "INVALID_EVENT_HISTORY");
  assertDomainError(() => rehydrateSupplier([registered, registered]), "INVALID_EVENT_HISTORY");
  assertDomainError(() => rehydrateSupplier([registered, duplicateCommand]), "INVALID_EVENT_HISTORY");
});

function buildActiveIndividualHistory(authorizationOverrides = {}) {
  const history = [];
  append(history, registerSupplier(individualRegistration(), context("tenant_individual", 0)));
  append(history, verification(history, "identity", 1));
  append(history, verification(history, "tax", 2));
  append(history, verification(history, "payout", 3));
  append(
    history,
    recordProviderAuthorization(
      current(history),
      { ...subscriptionAuthorization(), ...authorizationOverrides },
      context("tenant_individual", 4)
    )
  );
  append(history, activateSupplier(current(history), context("tenant_individual", 5)));
  return history;
}

function activeIndividualSupplier(authorizationOverrides = {}) {
  return current(buildActiveIndividualHistory(authorizationOverrides));
}

function individualRegistration() {
  return {
    supplierId: "supplier_individual",
    kind: "individual",
    legalName: "Individual Supplier",
    displayName: "Personal Compute",
    countryCode: "US",
    taxResidenceCountryCode: "US"
  };
}

function verification(history, kind, second) {
  return recordSupplierVerification(current(history), verificationInput(kind, second), context("tenant_individual", second));
}

function verificationInput(kind, second) {
  return {
    verificationId: `verification_${kind.replace(/-/g, "_")}`,
    kind,
    status: "verified",
    evidenceRef: `evidence_${kind.replace(/-/g, "_")}`,
    completedAt: timestamp(second),
    expiresAt: "2027-08-24T00:00:00.000Z"
  };
}

function subscriptionAuthorization() {
  return {
    authorizationId: "authorization_personal",
    providerId: "provider_example",
    sourceType: "subscription-plan",
    authorizedUse: "inference-resale",
    meteringMode: "provider-report",
    evidenceRef: "evidence_provider_authorization",
    modelPatterns: ["model-family-*"],
    regionCodes: ["US"],
    allowedDataClasses: ["P0", "P1"],
    capacityCeiling: {
      requestsPerMinute: 60,
      tokensPerMinute: 1_000_000,
      concurrency: 4,
      maxOutputTokens: 32_000
    },
    validFrom: timestamp(4),
    validUntil: "2026-09-24T00:00:00.000Z",
    status: "active"
  };
}

function offerInput() {
  return {
    offerId: "offer_personal_001",
    authorizationId: "authorization_personal",
    providerId: "provider_example",
    model: "model-family-pro",
    serviceTier: "fast",
    regionCode: "US",
    dataClasses: ["P0", "P1"],
    limits: {
      requestsPerMinute: 60,
      tokensPerMinute: 1_000_000,
      concurrency: 4,
      maxOutputTokens: 32_000
    },
    currency: "USD",
    rates: [
      { unit: "input-token", amountMicros: "2" },
      { unit: "output-token", amountMicros: "12" }
    ],
    validFrom: timestamp(6),
    validUntil: "2026-08-25T00:00:00.000Z"
  };
}

function context(tenantId, second) {
  return {
    tenantId,
    actorId: "actor_marketplace_test",
    commandId: `command_${tenantId}_${second}`,
    eventId: `event_${tenantId}_${second}`,
    occurredAt: timestamp(second)
  };
}

function timestamp(second) {
  return `2026-08-24T00:00:${String(second).padStart(2, "0")}.000Z`;
}

function append(history, event) {
  history.push(event);
  return current(history);
}

function current(history) {
  const state = rehydrateSupplier(history);
  assert.ok(state);
  return state;
}

function assertDomainError(operation, code) {
  assert.throws(operation, (error) => error instanceof MarketplaceDomainError && error.code === code);
}
