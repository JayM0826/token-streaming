import assert from "node:assert/strict";
import test from "node:test";

import {
  MarketplaceDomainError,
  calculateSettlement,
  estimateArtifactMaximumChargeMicros,
  estimateMaximumChargeMicros
} from "../dist/index.js";

test("settlement is balanced and deterministic in integer micros", () => {
  const result = calculateSettlement({
    totalTokens: 1_250,
    priceMicrosPerMillionTokens: "8400000",
    platformFeeBps: 1200
  });

  assert.deepEqual(result, {
    buyerChargeMicros: "10500",
    supplierCreditMicros: "9240",
    platformFeeMicros: "1260"
  });
  assert.equal(
    BigInt(result.buyerChargeMicros),
    BigInt(result.supplierCreditMicros) + BigInt(result.platformFeeMicros)
  );
});

test("settlement rounds the buyer charge up to one micro", () => {
  const result = calculateSettlement({
    totalTokens: 1,
    priceMicrosPerMillionTokens: "1",
    platformFeeBps: 1200
  });
  assert.equal(result.buyerChargeMicros, "1");
  assert.equal(result.supplierCreditMicros, "1");
  assert.equal(result.platformFeeMicros, "0");
});

test("maximum charge includes estimated input and requested output", () => {
  assert.equal(
    estimateMaximumChargeMicros({
      estimatedInputTokens: 500,
      maxOutputTokens: 1_500,
      priceMicrosPerMillionTokens: "8400000"
    }),
    "16800"
  );
});

test("artifact maximum charge reserves the explicit full-task token budget", () => {
  assert.equal(
    estimateArtifactMaximumChargeMicros({
      maxTotalTokens: 200_000,
      priceMicrosPerMillionTokens: "8400000"
    }),
    "1680000"
  );
});

test("settlement rejects unsafe inputs", () => {
  assert.throws(
    () => calculateSettlement({ totalTokens: 0, priceMicrosPerMillionTokens: "8400000", platformFeeBps: 1200 }),
    (error) => error instanceof MarketplaceDomainError && error.code === "INVALID_ARGUMENT"
  );
  assert.throws(
    () => calculateSettlement({ totalTokens: 1, priceMicrosPerMillionTokens: "8.4", platformFeeBps: 1200 }),
    (error) => error instanceof MarketplaceDomainError && error.code === "INVALID_ARGUMENT"
  );
});
