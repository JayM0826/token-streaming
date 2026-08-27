import assert from "node:assert/strict";
import test from "node:test";

import {
  MarketplaceDomainError,
  assertSupplierProcessingAcknowledged,
  calculateMarketplacePrivacyRetentionMilliseconds,
  parseMarketplacePrivacyMode
} from "../dist/index.js";

const policy = {
  standardOutputRetentionHours: 24,
  standardArtifactRetentionHours: 48,
  strictOutputRetentionMinutes: 60,
  strictArtifactRetentionMinutes: 60
};

test("privacy mode is closed to the two protocol-defined values", () => {
  assert.equal(parseMarketplacePrivacyMode("strict"), "strict");
  assert.equal(parseMarketplacePrivacyMode("standard"), "standard");
  assertDomainError(() => parseMarketplacePrivacyMode("forever"), "INVALID_ARGUMENT");
  assertDomainError(() => parseMarketplacePrivacyMode(undefined), "INVALID_ARGUMENT");
});

test("supplier plaintext processing requires an explicit true acknowledgement", () => {
  assert.doesNotThrow(() => assertSupplierProcessingAcknowledged(true));
  for (const value of [false, undefined, "true", 1]) {
    assertDomainError(
      () => assertSupplierProcessingAcknowledged(value),
      "PRIVACY_ACKNOWLEDGEMENT_REQUIRED"
    );
  }
});

test("strict and standard retention are calculated in one headless policy", () => {
  assert.deepEqual(calculateMarketplacePrivacyRetentionMilliseconds("strict", policy), {
    output: 60 * 60_000,
    artifact: 60 * 60_000
  });
  assert.deepEqual(calculateMarketplacePrivacyRetentionMilliseconds("standard", policy), {
    output: 24 * 60 * 60_000,
    artifact: 48 * 60 * 60_000
  });
  assertDomainError(
    () => calculateMarketplacePrivacyRetentionMilliseconds("strict", { ...policy, strictOutputRetentionMinutes: 0 }),
    "INVALID_ARGUMENT"
  );
});

function assertDomainError(operation, code) {
  assert.throws(operation, (error) => error instanceof MarketplaceDomainError && error.code === code);
}
