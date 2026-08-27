import {
  MARKETPLACE_SCHEMA_VERSION,
  type MarketplaceCommandContext,
  type ProviderAuthorization,
  type ProviderAuthorizationInput,
  type ProviderAuthorizationRecordedEvent,
  type ProviderAuthorizationRevokedEvent,
  type SupplierActivatedEvent,
  type SupplierEvent,
  type SupplierKind,
  type SupplierRegisteredEvent,
  type SupplierRegistrationInput,
  type SupplierState,
  type SupplierSuspendedEvent,
  type SupplierVerificationInput,
  type SupplierVerificationKind,
  type SupplierVerificationRecordedEvent
} from "@token-streaming/protocol";
import { MarketplaceDomainError } from "./errors.js";
import {
  assertAllowedValue,
  assertCapacityLimits,
  assertCommandNotBefore,
  assertContext,
  assertCountryCode,
  assertExactKeys,
  assertIdentifier,
  assertSafeInput,
  assertTenant,
  assertText,
  assertTimestamp,
  assertUniqueStrings,
  isActiveAt
} from "./validation.js";

const REQUIRED_VERIFICATIONS: Readonly<Record<SupplierKind, readonly SupplierVerificationKind[]>> = {
  individual: ["identity", "tax", "payout"],
  organization: ["business", "beneficial-ownership", "tax", "payout"]
};

export function requiredVerificationKinds(kind: SupplierKind): readonly SupplierVerificationKind[] {
  return REQUIRED_VERIFICATIONS[kind];
}

export function registerSupplier(
  input: SupplierRegistrationInput,
  context: MarketplaceCommandContext
): SupplierRegisteredEvent {
  assertSafeInput(input);
  assertExactKeys(input, "supplierRegistration", [
    "supplierId",
    "kind",
    "legalName",
    "displayName",
    "countryCode",
    "taxResidenceCountryCode"
  ]);
  assertContext(context);
  assertIdentifier(input.supplierId, "supplierId");
  assertText(input.legalName, "legalName", 200);
  assertText(input.displayName, "displayName", 120);
  assertCountryCode(input.countryCode, "countryCode");
  assertCountryCode(input.taxResidenceCountryCode, "taxResidenceCountryCode");
  if (input.kind !== "individual" && input.kind !== "organization") {
    throw new MarketplaceDomainError("INVALID_ARGUMENT", "kind must be individual or organization.");
  }

  return {
    schemaVersion: MARKETPLACE_SCHEMA_VERSION,
    eventId: context.eventId,
    tenantId: context.tenantId,
    actorId: context.actorId,
    causationId: context.commandId,
    aggregateType: "supplier",
    aggregateId: input.supplierId,
    aggregateVersion: 1,
    occurredAt: context.occurredAt,
    type: "supplier.registered",
    payload: { ...input }
  };
}

export function recordSupplierVerification(
  state: SupplierState,
  input: SupplierVerificationInput,
  context: MarketplaceCommandContext
): SupplierVerificationRecordedEvent {
  assertSafeInput(input);
  assertExactKeys(input, "supplierVerification", [
    "verificationId",
    "kind",
    "status",
    "evidenceRef",
    "completedAt",
    "expiresAt"
  ]);
  assertStateContext(state, context);
  assertSupplierWritable(state);
  assertIdentifier(input.verificationId, "verificationId");
  assertIdentifier(input.evidenceRef, "evidenceRef");
  assertAllowedValue(input.kind, "verification.kind", ["identity", "business", "beneficial-ownership", "tax", "payout"]);
  assertAllowedValue(input.status, "verification.status", ["verified", "rejected"]);
  const completedAt = assertTimestamp(input.completedAt, "completedAt");
  const occurredAt = assertTimestamp(context.occurredAt, "occurredAt");
  if (completedAt > occurredAt) {
    throw new MarketplaceDomainError("INVALID_ARGUMENT", "completedAt cannot be later than the event timestamp.");
  }
  if (input.expiresAt && assertTimestamp(input.expiresAt, "expiresAt") <= completedAt) {
    throw new MarketplaceDomainError("INVALID_ARGUMENT", "expiresAt must be later than completedAt.");
  }
  const reusedId = state.verifications.find(
    (verification) => verification.verificationId === input.verificationId && verification.kind !== input.kind
  );
  if (reusedId) {
    throw new MarketplaceDomainError("DUPLICATE_RECORD", "verificationId is already used for another verification kind.", {
      verificationId: input.verificationId
    });
  }

  return supplierEvent(state, context, "supplier.verification-recorded", { ...input });
}

export function recordProviderAuthorization(
  state: SupplierState,
  input: ProviderAuthorizationInput,
  context: MarketplaceCommandContext
): ProviderAuthorizationRecordedEvent {
  assertSafeInput(input);
  assertExactKeys(input, "providerAuthorization", [
    "authorizationId",
    "providerId",
    "sourceType",
    "authorizedUse",
    "meteringMode",
    "evidenceRef",
    "modelPatterns",
    "regionCodes",
    "allowedDataClasses",
    "capacityCeiling",
    "validFrom",
    "validUntil",
    "status"
  ]);
  assertStateContext(state, context);
  assertSupplierWritable(state);
  assertIdentifier(input.authorizationId, "authorizationId");
  assertIdentifier(input.providerId, "providerId");
  assertIdentifier(input.evidenceRef, "evidenceRef");
  assertAllowedValue(input.sourceType, "sourceType", ["api-project", "commercial-account", "subscription-plan", "self-hosted-license"]);
  assertAllowedValue(input.authorizedUse, "authorizedUse", ["managed-inference", "inference-resale"]);
  assertAllowedValue(input.meteringMode, "meteringMode", ["provider-report", "signed-receipt", "dedicated-counter"]);
  assertAllowedValue(input.status, "authorization.status", ["pending", "active", "suspended"]);
  const validFrom = assertTimestamp(input.validFrom, "validFrom");
  const validUntil = assertTimestamp(input.validUntil, "validUntil");
  if (validUntil <= validFrom) {
    throw new MarketplaceDomainError("INVALID_ARGUMENT", "validUntil must be later than validFrom.");
  }
  assertUniqueStrings(input.modelPatterns, "modelPatterns", validateModelPattern);
  assertUniqueStrings(input.regionCodes, "regionCodes", (value) => assertCountryCode(value, "regionCode", true));
  assertUniqueStrings(input.allowedDataClasses, "allowedDataClasses", (value) =>
    assertAllowedValue(value, "allowedDataClass", ["P0", "P1", "P2", "P3"])
  );
  if (input.allowedDataClasses.includes("P2") || input.allowedDataClasses.includes("P3")) {
    throw new MarketplaceDomainError(
      "UNSUPPORTED_DATA_CLASS",
      "P2 and P3 authorizations require a future dedicated compliance policy."
    );
  }
  assertCapacityLimits(input.capacityCeiling, "capacityCeiling");
  if (state.authorizations.some((authorization) => authorization.authorizationId === input.authorizationId)) {
    throw new MarketplaceDomainError("DUPLICATE_RECORD", "authorizationId already exists.", {
      authorizationId: input.authorizationId
    });
  }

  return supplierEvent(state, context, "supplier.provider-authorization-recorded", {
    ...input,
    modelPatterns: [...input.modelPatterns],
    regionCodes: [...input.regionCodes],
    allowedDataClasses: [...input.allowedDataClasses],
    capacityCeiling: { ...input.capacityCeiling }
  });
}

export function revokeProviderAuthorization(
  state: SupplierState,
  input: { authorizationId: string; reasonCode: string },
  context: MarketplaceCommandContext
): ProviderAuthorizationRevokedEvent {
  assertSafeInput(input);
  assertExactKeys(input, "providerAuthorizationRevocation", ["authorizationId", "reasonCode"]);
  assertStateContext(state, context);
  assertIdentifier(input.authorizationId, "authorizationId");
  assertIdentifier(input.reasonCode, "reasonCode");
  const authorization = state.authorizations.find((candidate) => candidate.authorizationId === input.authorizationId);
  if (!authorization || authorization.status === "revoked") {
    throw new MarketplaceDomainError("AUTHORIZATION_REQUIRED", "An existing non-revoked authorization is required.", {
      authorizationId: input.authorizationId
    });
  }
  return supplierEvent(state, context, "supplier.provider-authorization-revoked", { ...input });
}

export function activateSupplier(state: SupplierState, context: MarketplaceCommandContext): SupplierActivatedEvent {
  assertStateContext(state, context);
  if (state.status !== "pending-verification") {
    throw new MarketplaceDomainError("INVALID_SUPPLIER_STATE", "Only a pending supplier can be activated.", {
      status: state.status
    });
  }

  const missing = missingRequiredVerificationKinds(state, context.occurredAt);
  if (missing.length > 0) {
    throw new MarketplaceDomainError("VERIFICATION_INCOMPLETE", "Supplier verification is incomplete.", {
      supplierKind: state.kind,
      missing
    });
  }
  if (!state.authorizations.some((authorization) => isAuthorizationActive(authorization, context.occurredAt))) {
    throw new MarketplaceDomainError("AUTHORIZATION_REQUIRED", "At least one active, metered provider authorization is required.");
  }

  return supplierEvent(state, context, "supplier.activated", { activatedAt: context.occurredAt });
}

export function suspendSupplier(
  state: SupplierState,
  input: { reasonCode: string },
  context: MarketplaceCommandContext
): SupplierSuspendedEvent {
  assertSafeInput(input);
  assertExactKeys(input, "supplierSuspension", ["reasonCode"]);
  assertStateContext(state, context);
  assertIdentifier(input.reasonCode, "reasonCode");
  if (state.status === "suspended" || state.status === "rejected") {
    throw new MarketplaceDomainError("INVALID_SUPPLIER_STATE", "Supplier cannot be suspended from its current state.", {
      status: state.status
    });
  }
  return supplierEvent(state, context, "supplier.suspended", { ...input });
}

export function rehydrateSupplier(events: readonly SupplierEvent[]): SupplierState | undefined {
  let state: SupplierState | undefined;
  const eventIds = new Set<string>();
  const causationIds = new Set<string>();
  let previousOccurredAt: number | undefined;

  for (const event of events) {
    if (!event || typeof event !== "object" || event.schemaVersion !== MARKETPLACE_SCHEMA_VERSION || event.aggregateType !== "supplier") {
      throw invalidHistory("Unsupported supplier event envelope.");
    }
    assertHistoryIdentifier(event.eventId, "eventId");
    assertHistoryIdentifier(event.tenantId, "tenantId");
    assertHistoryIdentifier(event.actorId, "actorId");
    assertHistoryIdentifier(event.causationId, "causationId");
    assertHistoryIdentifier(event.aggregateId, "aggregateId");
    if (!Number.isSafeInteger(event.aggregateVersion) || event.aggregateVersion <= 0) {
      throw invalidHistory("Supplier aggregate versions must be positive safe integers.");
    }
    const occurredAt = historyTimestamp(event.occurredAt, "occurredAt");
    if (previousOccurredAt !== undefined && occurredAt < previousOccurredAt) {
      throw invalidHistory("Supplier event timestamps cannot move backwards.");
    }
    previousOccurredAt = occurredAt;
    if (eventIds.has(event.eventId)) throw invalidHistory("Duplicate eventId in supplier history.");
    eventIds.add(event.eventId);
    if (causationIds.has(event.causationId)) throw invalidHistory("Duplicate causationId in supplier history.");
    causationIds.add(event.causationId);
    const expectedVersion = (state?.version ?? 0) + 1;
    if (event.aggregateVersion !== expectedVersion) {
      throw invalidHistory(`Expected supplier aggregate version ${expectedVersion}, received ${event.aggregateVersion}.`);
    }
    if (!state && event.type !== "supplier.registered") {
      throw invalidHistory("The first supplier event must be supplier.registered.");
    }
    if (event.type === "supplier.registered" && event.aggregateId !== event.payload.supplierId) {
      throw invalidHistory("Registered supplier payload does not match its aggregateId.");
    }
    if (state && (event.aggregateId !== state.supplierId || event.tenantId !== state.tenantId)) {
      throw invalidHistory("Supplier history crosses aggregate or tenant boundaries.");
    }
    state = applySupplierEvent(state, event);
  }

  return state;
}

export function isAuthorizationActive(authorization: ProviderAuthorization, instant: string): boolean {
  return authorization.status === "active" && isActiveAt(authorization.validFrom, authorization.validUntil, instant);
}

export function missingRequiredVerificationKinds(
  state: SupplierState,
  instant: string
): readonly SupplierVerificationKind[] {
  return requiredVerificationKinds(state.kind).filter((kind) => !hasCurrentVerification(state, kind, instant));
}

function applySupplierEvent(state: SupplierState | undefined, event: SupplierEvent): SupplierState {
  if (event.type === "supplier.registered") {
    if (state) throw invalidHistory("Supplier cannot be registered twice.");
    return {
      supplierId: event.payload.supplierId,
      tenantId: event.tenantId,
      kind: event.payload.kind,
      legalName: event.payload.legalName,
      displayName: event.payload.displayName,
      countryCode: event.payload.countryCode,
      taxResidenceCountryCode: event.payload.taxResidenceCountryCode,
      status: "pending-verification",
      verifications: [],
      authorizations: [],
      version: event.aggregateVersion,
      createdAt: event.occurredAt,
      updatedAt: event.occurredAt
    };
  }
  if (!state) throw invalidHistory("Supplier state is missing.");

  if (event.type === "supplier.verification-recorded") {
    if (state.status === "suspended" || state.status === "rejected") {
      throw invalidHistory("A non-writable supplier contains a verification event.");
    }
    const reusedId = state.verifications.find(
      (verification) => verification.verificationId === event.payload.verificationId && verification.kind !== event.payload.kind
    );
    if (reusedId) throw invalidHistory("A verificationId is reused across verification kinds.");
    const verifications = state.verifications.filter((verification) => verification.kind !== event.payload.kind);
    return advance(state, event, { verifications: [...verifications, { ...event.payload }] });
  }
  if (event.type === "supplier.provider-authorization-recorded") {
    if (state.status === "suspended" || state.status === "rejected") {
      throw invalidHistory("A non-writable supplier contains an authorization event.");
    }
    if (state.authorizations.some((authorization) => authorization.authorizationId === event.payload.authorizationId)) {
      throw invalidHistory("A provider authorization is recorded more than once.");
    }
    return advance(state, event, {
      authorizations: [
        ...state.authorizations,
        {
          ...event.payload,
          modelPatterns: [...event.payload.modelPatterns],
          regionCodes: [...event.payload.regionCodes],
          allowedDataClasses: [...event.payload.allowedDataClasses],
          capacityCeiling: { ...event.payload.capacityCeiling }
        }
      ]
    });
  }
  if (event.type === "supplier.provider-authorization-revoked") {
    const authorization = state.authorizations.find(
      (candidate) => candidate.authorizationId === event.payload.authorizationId
    );
    if (!authorization || authorization.status === "revoked") {
      throw invalidHistory("A revocation event requires an existing non-revoked authorization.");
    }
    return advance(state, event, {
      authorizations: state.authorizations.map((authorization) =>
        authorization.authorizationId === event.payload.authorizationId ? { ...authorization, status: "revoked" } : authorization
      )
    });
  }
  if (event.type === "supplier.activated") {
    if (
      state.status !== "pending-verification" ||
      event.payload.activatedAt !== event.occurredAt ||
      missingRequiredVerificationKinds(state, event.occurredAt).length > 0 ||
      !state.authorizations.some((authorization) => isAuthorizationActive(authorization, event.occurredAt))
    ) {
      throw invalidHistory("Supplier activation invariants are not satisfied.");
    }
    return advance(state, event, { status: "active" });
  }
  if (event.type === "supplier.suspended") {
    if (state.status === "suspended" || state.status === "rejected") {
      throw invalidHistory("Supplier suspension transition is invalid.");
    }
    return advance(state, event, { status: "suspended" });
  }
  throw invalidHistory("Unsupported supplier event type.");
}

type SupplierEventFor<TType extends SupplierEvent["type"]> = Extract<SupplierEvent, { type: TType }>;

function supplierEvent<TType extends SupplierEvent["type"]>(
  state: SupplierState,
  context: MarketplaceCommandContext,
  type: TType,
  payload: SupplierEventFor<TType>["payload"]
): SupplierEventFor<TType> {
  return {
    schemaVersion: MARKETPLACE_SCHEMA_VERSION,
    eventId: context.eventId,
    tenantId: context.tenantId,
    actorId: context.actorId,
    causationId: context.commandId,
    aggregateType: "supplier",
    aggregateId: state.supplierId,
    aggregateVersion: state.version + 1,
    occurredAt: context.occurredAt,
    type,
    payload
  } as unknown as SupplierEventFor<TType>;
}

function advance(
  state: SupplierState,
  event: SupplierEvent,
  changes: Partial<Pick<SupplierState, "status" | "verifications" | "authorizations">>
): SupplierState {
  return { ...state, ...changes, version: event.aggregateVersion, updatedAt: event.occurredAt };
}

function assertSupplierWritable(state: SupplierState): void {
  if (state.status === "suspended" || state.status === "rejected") {
    throw new MarketplaceDomainError("INVALID_SUPPLIER_STATE", "Supplier is not writable in its current state.", {
      status: state.status
    });
  }
}

function assertStateContext(state: SupplierState, context: MarketplaceCommandContext): void {
  assertContext(context);
  assertTenant(state.tenantId, context);
  assertCommandNotBefore(state.updatedAt, context);
}

function hasCurrentVerification(state: SupplierState, kind: SupplierVerificationKind, instant: string): boolean {
  const verification = state.verifications.find((candidate) => candidate.kind === kind && candidate.status === "verified");
  if (!verification) return false;
  return !verification.expiresAt || assertTimestamp(verification.expiresAt, "expiresAt") > assertTimestamp(instant, "instant");
}

function validateModelPattern(value: string): void {
  assertText(value, "modelPattern", 120);
  const wildcardIndex = value.indexOf("*");
  if (wildcardIndex >= 0 && wildcardIndex !== value.length - 1) {
    throw new MarketplaceDomainError("INVALID_ARGUMENT", "A model wildcard is allowed only as the final character.");
  }
}

function invalidHistory(message: string): MarketplaceDomainError {
  return new MarketplaceDomainError("INVALID_EVENT_HISTORY", message);
}

function assertHistoryIdentifier(value: unknown, label: string): void {
  try {
    assertIdentifier(value, label);
  } catch {
    throw invalidHistory(`Supplier event ${label} is invalid.`);
  }
}

function historyTimestamp(value: unknown, label: string): number {
  if (typeof value !== "string" || !value.endsWith("Z")) {
    throw invalidHistory(`Supplier event ${label} is invalid.`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw invalidHistory(`Supplier event ${label} is invalid.`);
  return timestamp;
}
