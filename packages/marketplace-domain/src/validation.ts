import type { CapacityLimits, MarketplaceCommandContext } from "@token-streaming/protocol";
import { MarketplaceDomainError } from "./errors.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const COUNTRY_PATTERN = /^[A-Z]{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const FORBIDDEN_FIELD_FRAGMENTS = [
  "apikey",
  "password",
  "cookie",
  "cookies",
  "sessioncookie",
  "accesstoken",
  "refreshtoken",
  "bearertoken",
  "clientsecret",
  "authorizationheader",
  "rawcredential",
  "credential",
  "privatekey",
  "sessiontoken",
  "idtoken",
  "secret"
] as const;

export function assertSafeInput(value: unknown): void {
  const seen = new Set<object>();
  const pending: Array<{ value: unknown; path: string; depth: number }> = [{ value, path: "$", depth: 0 }];
  let visited = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || current.value === null || current.value === undefined) continue;
    if (typeof current.value === "number" && !Number.isFinite(current.value)) {
      throw new MarketplaceDomainError("INVALID_ARGUMENT", `Marketplace input contains a non-finite number at ${current.path}.`);
    }
    if (["bigint", "function", "symbol"].includes(typeof current.value)) {
      throw new MarketplaceDomainError("INVALID_ARGUMENT", `Marketplace input contains a non-serializable value at ${current.path}.`);
    }
    if (typeof current.value !== "object") continue;
    if (seen.has(current.value)) {
      throw new MarketplaceDomainError("INVALID_ARGUMENT", `Marketplace input contains a cyclic or repeated object at ${current.path}.`);
    }
    seen.add(current.value);
    visited += 1;

    if (visited > 1_000 || current.depth > 12) {
      throw new MarketplaceDomainError("INVALID_ARGUMENT", "Marketplace input exceeds structural limits.");
    }

    if (!Array.isArray(current.value)) {
      const prototype = Object.getPrototypeOf(current.value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new MarketplaceDomainError("INVALID_ARGUMENT", `Marketplace input must contain only plain objects at ${current.path}.`);
      }
    }

    for (const [key, child] of Object.entries(current.value)) {
      const normalizedKey = key.replace(/[-_]/g, "").toLowerCase();
      if (FORBIDDEN_FIELD_FRAGMENTS.some((fragment) => normalizedKey.includes(fragment))) {
        throw new MarketplaceDomainError(
          "CREDENTIAL_MATERIAL_REJECTED",
          `Credential material is not accepted at ${current.path}.${key}.`,
          { field: key }
        );
      }
      pending.push({ value: child, path: `${current.path}.${key}`, depth: current.depth + 1 });
    }
  }
}

export function assertContext(context: MarketplaceCommandContext): void {
  assertSafeInput(context);
  assertExactKeys(context, "context", ["tenantId", "actorId", "commandId", "eventId", "occurredAt"]);
  assertIdentifier(context.tenantId, "tenantId");
  assertIdentifier(context.actorId, "actorId");
  assertIdentifier(context.commandId, "commandId");
  assertIdentifier(context.eventId, "eventId");
  assertTimestamp(context.occurredAt, "occurredAt");
}

export function assertPlainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MarketplaceDomainError("INVALID_ARGUMENT", `${label} must be an object.`, { label });
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new MarketplaceDomainError("INVALID_ARGUMENT", `${label} must be a plain object.`, { label });
  }
}

export function assertExactKeys(value: unknown, label: string, allowedKeys: readonly string[]): asserts value is Record<string, unknown> {
  assertPlainRecord(value, label);
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new MarketplaceDomainError("INVALID_ARGUMENT", `${label} contains an unsupported field.`, { label, field: key });
    }
  }
}

export function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new MarketplaceDomainError("INVALID_ARGUMENT", `${label} must be a stable 3-128 character identifier.`, { label });
  }
}

export function assertText(value: unknown, label: string, maximumLength: number): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximumLength) {
    throw new MarketplaceDomainError("INVALID_ARGUMENT", `${label} must contain 1-${maximumLength} characters.`, { label });
  }
}

export function assertAllowedValue<TValue extends string>(
  value: unknown,
  label: string,
  allowed: readonly TValue[]
): asserts value is TValue {
  if (typeof value !== "string" || !allowed.includes(value as TValue)) {
    throw new MarketplaceDomainError("INVALID_ARGUMENT", `${label} must be one of: ${allowed.join(", ")}.`, { label });
  }
}

export function assertCountryCode(value: unknown, label: string, allowWildcard = false): asserts value is string {
  if (typeof value === "string" && ((allowWildcard && value === "*") || COUNTRY_PATTERN.test(value))) return;
  throw new MarketplaceDomainError("INVALID_ARGUMENT", `${label} must be an uppercase ISO 3166-1 alpha-2 code${allowWildcard ? " or *" : ""}.`, {
    label
  });
}

export function assertCurrency(value: unknown): asserts value is string {
  if (typeof value !== "string" || !CURRENCY_PATTERN.test(value)) {
    throw new MarketplaceDomainError("INVALID_ARGUMENT", "currency must be an uppercase ISO 4217 code.");
  }
}

export function assertTimestamp(value: unknown, label: string): number {
  if (typeof value !== "string" || !value.endsWith("Z")) {
    throw new MarketplaceDomainError("INVALID_ARGUMENT", `${label} must be an ISO-8601 UTC timestamp.`, { label });
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new MarketplaceDomainError("INVALID_ARGUMENT", `${label} must be an ISO-8601 UTC timestamp.`, { label });
  }
  return timestamp;
}

export function assertTenant(tenantId: string, context: MarketplaceCommandContext): void {
  if (tenantId !== context.tenantId) {
    throw new MarketplaceDomainError("TENANT_MISMATCH", "The command tenant does not own this supplier.", {
      expectedTenantId: tenantId,
      actualTenantId: context.tenantId
    });
  }
}

export function assertCommandNotBefore(aggregateUpdatedAt: string, context: MarketplaceCommandContext): void {
  if (assertTimestamp(context.occurredAt, "occurredAt") < assertTimestamp(aggregateUpdatedAt, "aggregateUpdatedAt")) {
    throw new MarketplaceDomainError("INVALID_ARGUMENT", "Command timestamp cannot precede the aggregate timestamp.");
  }
}

export function assertPositiveSafeInteger(value: unknown, label: string, maximum: number): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new MarketplaceDomainError("INVALID_ARGUMENT", `${label} must be a positive safe integer no greater than ${maximum}.`, {
      label
    });
  }
}

export function assertPositiveDecimalInteger(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,29}$/.test(value)) {
    throw new MarketplaceDomainError("INVALID_ARGUMENT", `${label} must be a positive integer string of at most 30 digits.`, {
      label
    });
  }
}

export function assertUniqueStrings(
  values: unknown,
  label: string,
  validate: (value: string) => void
): asserts values is string[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > 100) {
    throw new MarketplaceDomainError("INVALID_ARGUMENT", `${label} must contain 1-100 entries.`, { label });
  }
  const unique = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") {
      throw new MarketplaceDomainError("INVALID_ARGUMENT", `${label} must contain only strings.`, { label });
    }
    validate(value);
    if (unique.has(value)) {
      throw new MarketplaceDomainError("DUPLICATE_RECORD", `${label} contains duplicate value ${value}.`, { label, value });
    }
    unique.add(value);
  }
}

export function assertCapacityLimits(value: unknown, label: string): asserts value is CapacityLimits {
  assertExactKeys(value, label, ["requestsPerMinute", "tokensPerMinute", "concurrency", "maxOutputTokens"]);
  assertPositiveSafeInteger(value.requestsPerMinute, `${label}.requestsPerMinute`, 1_000_000);
  assertPositiveSafeInteger(value.tokensPerMinute, `${label}.tokensPerMinute`, 10_000_000_000);
  assertPositiveSafeInteger(value.concurrency, `${label}.concurrency`, 100_000);
  assertPositiveSafeInteger(value.maxOutputTokens, `${label}.maxOutputTokens`, 10_000_000);
}

export function isActiveAt(validFrom: string, validUntil: string, instant: string): boolean {
  const at = assertTimestamp(instant, "instant");
  return assertTimestamp(validFrom, "validFrom") <= at && at < assertTimestamp(validUntil, "validUntil");
}
