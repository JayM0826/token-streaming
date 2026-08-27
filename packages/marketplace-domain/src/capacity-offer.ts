import {
  MARKETPLACE_SCHEMA_VERSION,
  type CapacityOfferInput,
  type CapacityOfferPublishedEvent,
  type CapacityOfferState,
  type MarketplaceCommandContext,
  type ProviderAuthorization,
  type SupplierState
} from "@token-streaming/protocol";
import { MarketplaceDomainError } from "./errors.js";
import { isAuthorizationActive, missingRequiredVerificationKinds } from "./supplier.js";
import {
  assertAllowedValue,
  assertCapacityLimits,
  assertCommandNotBefore,
  assertContext,
  assertCountryCode,
  assertCurrency,
  assertExactKeys,
  assertIdentifier,
  assertPositiveDecimalInteger,
  assertSafeInput,
  assertTenant,
  assertText,
  assertTimestamp,
  assertUniqueStrings
} from "./validation.js";

export function publishCapacityOffer(
  supplier: SupplierState,
  input: CapacityOfferInput,
  context: MarketplaceCommandContext
): CapacityOfferPublishedEvent {
  assertSafeInput(input);
  assertExactKeys(input, "capacityOffer", [
    "offerId",
    "authorizationId",
    "providerId",
    "model",
    "serviceTier",
    "regionCode",
    "dataClasses",
    "limits",
    "currency",
    "rates",
    "validFrom",
    "validUntil"
  ]);
  assertContext(context);
  assertTenant(supplier.tenantId, context);
  assertCommandNotBefore(supplier.updatedAt, context);
  if (supplier.status !== "active") {
    throw new MarketplaceDomainError("INVALID_SUPPLIER_STATE", "Only an active supplier can publish capacity.", {
      status: supplier.status
    });
  }
  const missingVerifications = missingRequiredVerificationKinds(supplier, context.occurredAt);
  if (missingVerifications.length > 0) {
    throw new MarketplaceDomainError("VERIFICATION_INCOMPLETE", "Supplier verification is no longer current.", {
      supplierKind: supplier.kind,
      missing: missingVerifications
    });
  }

  assertIdentifier(input.offerId, "offerId");
  assertIdentifier(input.authorizationId, "authorizationId");
  assertIdentifier(input.providerId, "providerId");
  assertText(input.model, "model", 120);
  if (input.serviceTier !== undefined) assertText(input.serviceTier, "serviceTier", 80);
  assertCountryCode(input.regionCode, "regionCode");
  assertCurrency(input.currency);
  assertUniqueStrings(input.dataClasses, "dataClasses", (value) =>
    assertAllowedValue(value, "dataClass", ["P0", "P1", "P2", "P3"])
  );
  if (input.dataClasses.includes("P2") || input.dataClasses.includes("P3")) {
    throw new MarketplaceDomainError(
      "UNSUPPORTED_DATA_CLASS",
      "P2 and P3 capacity offers require a future dedicated compliance policy."
    );
  }
  assertCapacityLimits(input.limits, "limits");
  assertRates(input);

  const validFrom = assertTimestamp(input.validFrom, "validFrom");
  const validUntil = assertTimestamp(input.validUntil, "validUntil");
  const occurredAt = assertTimestamp(context.occurredAt, "occurredAt");
  if (validUntil <= validFrom || validUntil <= occurredAt) {
    throw new MarketplaceDomainError("INVALID_ARGUMENT", "Offer validity must end after both its start and publication time.");
  }

  const authorization = supplier.authorizations.find((candidate) => candidate.authorizationId === input.authorizationId);
  assertAuthorizationScope(authorization, input, context.occurredAt);
  if (
    assertTimestamp(input.validFrom, "validFrom") < assertTimestamp(authorization.validFrom, "authorization.validFrom") ||
    assertTimestamp(input.validUntil, "validUntil") > assertTimestamp(authorization.validUntil, "authorization.validUntil")
  ) {
    throw new MarketplaceDomainError("AUTHORIZATION_SCOPE_MISMATCH", "Offer validity exceeds the provider authorization window.");
  }

  return {
    schemaVersion: MARKETPLACE_SCHEMA_VERSION,
    eventId: context.eventId,
    tenantId: context.tenantId,
    actorId: context.actorId,
    causationId: context.commandId,
    aggregateType: "capacity-offer",
    aggregateId: input.offerId,
    aggregateVersion: 1,
    occurredAt: context.occurredAt,
    type: "capacity-offer.published",
    payload: {
      ...input,
      supplierId: supplier.supplierId,
      sourceType: authorization.sourceType,
      dataClasses: [...input.dataClasses],
      limits: { ...input.limits },
      rates: input.rates.map((rate) => ({ ...rate }))
    }
  };
}

export function rehydrateCapacityOffer(events: readonly CapacityOfferPublishedEvent[]): CapacityOfferState | undefined {
  if (events.length === 0) return undefined;
  if (events.length !== 1) {
    throw new MarketplaceDomainError("INVALID_EVENT_HISTORY", "Only the initial capacity-offer event is supported in this slice.");
  }
  const event = events[0];
  if (
    !event ||
    event.schemaVersion !== MARKETPLACE_SCHEMA_VERSION ||
    event.aggregateType !== "capacity-offer" ||
    event.aggregateVersion !== 1 ||
    event.aggregateId !== event.payload.offerId
  ) {
    throw new MarketplaceDomainError("INVALID_EVENT_HISTORY", "Invalid capacity-offer event envelope.");
  }
  return {
    ...event.payload,
    dataClasses: [...event.payload.dataClasses],
    limits: { ...event.payload.limits },
    rates: event.payload.rates.map((rate) => ({ ...rate })),
    tenantId: event.tenantId,
    status: "active",
    version: event.aggregateVersion,
    publishedAt: event.occurredAt
  };
}

function assertAuthorizationScope(
  authorization: ProviderAuthorization | undefined,
  input: CapacityOfferInput,
  instant: string
): asserts authorization is ProviderAuthorization {
  if (!authorization || !isAuthorizationActive(authorization, instant)) {
    throw new MarketplaceDomainError("AUTHORIZATION_REQUIRED", "An active provider authorization is required.", {
      authorizationId: input.authorizationId
    });
  }
  const providerMatches = authorization.providerId === input.providerId;
  const modelMatches = authorization.modelPatterns.some((pattern) => matchesPattern(input.model, pattern));
  const regionMatches = authorization.regionCodes.includes("*") || authorization.regionCodes.includes(input.regionCode);
  const dataClassesMatch = input.dataClasses.every((dataClass) => authorization.allowedDataClasses.includes(dataClass));
  const capacityMatches = isWithinCapacityCeiling(input.limits, authorization.capacityCeiling);
  if (!providerMatches || !modelMatches || !regionMatches || !dataClassesMatch || !capacityMatches) {
    throw new MarketplaceDomainError(
      "AUTHORIZATION_SCOPE_MISMATCH",
      "Offer is outside the authorized provider, model, region, data-class, or capacity scope.",
      {
      providerMatches,
      modelMatches,
      regionMatches,
      dataClassesMatch,
      capacityMatches
      }
    );
  }
}

function isWithinCapacityCeiling(
  requested: CapacityOfferInput["limits"],
  ceiling: ProviderAuthorization["capacityCeiling"]
): boolean {
  return (
    requested.requestsPerMinute <= ceiling.requestsPerMinute &&
    requested.tokensPerMinute <= ceiling.tokensPerMinute &&
    requested.concurrency <= ceiling.concurrency &&
    requested.maxOutputTokens <= ceiling.maxOutputTokens
  );
}

function assertRates(input: CapacityOfferInput): void {
  if (!Array.isArray(input.rates) || input.rates.length === 0 || input.rates.length > 100) {
    throw new MarketplaceDomainError("INVALID_ARGUMENT", "rates must contain 1-100 components.");
  }
  const units = new Set<string>();
  for (const rate of input.rates) {
    assertExactKeys(rate, "rate", ["unit", "amountMicros"]);
    assertText(rate.unit, "rate.unit", 80);
    assertPositiveDecimalInteger(rate.amountMicros, "rate.amountMicros");
    if (units.has(rate.unit)) {
      throw new MarketplaceDomainError("DUPLICATE_RECORD", `Duplicate rate unit ${rate.unit}.`, { unit: rate.unit });
    }
    units.add(rate.unit);
  }
}

function matchesPattern(value: string, pattern: string): boolean {
  if (pattern === "*") return true;
  return pattern.endsWith("*") ? value.startsWith(pattern.slice(0, -1)) : value === pattern;
}
