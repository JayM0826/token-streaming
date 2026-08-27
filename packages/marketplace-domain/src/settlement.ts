import { MarketplaceDomainError } from "./errors.js";

export interface SettlementQuote {
  totalTokens: number;
  priceMicrosPerMillionTokens: string;
  platformFeeBps: number;
}

export interface SettlementAmounts {
  buyerChargeMicros: string;
  supplierCreditMicros: string;
  platformFeeMicros: string;
}

export function calculateSettlement(quote: SettlementQuote): SettlementAmounts {
  if (!Number.isSafeInteger(quote.totalTokens) || quote.totalTokens <= 0) {
    throw new MarketplaceDomainError("INVALID_ARGUMENT", "totalTokens must be a positive safe integer.");
  }
  if (!/^[1-9][0-9]*$/.test(quote.priceMicrosPerMillionTokens)) {
    throw new MarketplaceDomainError(
      "INVALID_ARGUMENT",
      "priceMicrosPerMillionTokens must be a positive decimal integer."
    );
  }
  if (!Number.isSafeInteger(quote.platformFeeBps) || quote.platformFeeBps < 0 || quote.platformFeeBps > 5_000) {
    throw new MarketplaceDomainError("INVALID_ARGUMENT", "platformFeeBps must be an integer from 0 to 5000.");
  }

  const tokens = BigInt(quote.totalTokens);
  const unitPrice = BigInt(quote.priceMicrosPerMillionTokens);
  const buyerCharge = divideRoundingUp(tokens * unitPrice, 1_000_000n);
  const platformFee = (buyerCharge * BigInt(quote.platformFeeBps)) / 10_000n;
  const supplierCredit = buyerCharge - platformFee;

  return {
    buyerChargeMicros: buyerCharge.toString(),
    supplierCreditMicros: supplierCredit.toString(),
    platformFeeMicros: platformFee.toString()
  };
}

export function estimateMaximumChargeMicros(input: {
  estimatedInputTokens: number;
  maxOutputTokens: number;
  priceMicrosPerMillionTokens: string;
}): string {
  if (!Number.isSafeInteger(input.estimatedInputTokens) || input.estimatedInputTokens < 0) {
    throw new MarketplaceDomainError("INVALID_ARGUMENT", "estimatedInputTokens must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens <= 0) {
    throw new MarketplaceDomainError("INVALID_ARGUMENT", "maxOutputTokens must be a positive safe integer.");
  }
  return calculateSettlement({
    totalTokens: Math.max(1, input.estimatedInputTokens + input.maxOutputTokens),
    priceMicrosPerMillionTokens: input.priceMicrosPerMillionTokens,
    platformFeeBps: 0
  }).buyerChargeMicros;
}

export function estimateArtifactMaximumChargeMicros(input: {
  maxTotalTokens: number;
  priceMicrosPerMillionTokens: string;
}): string {
  if (!Number.isSafeInteger(input.maxTotalTokens) || input.maxTotalTokens <= 0 || input.maxTotalTokens > 100_000_000) {
    throw new MarketplaceDomainError("INVALID_ARGUMENT", "maxTotalTokens must be an integer from 1 to 100000000.");
  }
  return calculateSettlement({
    totalTokens: input.maxTotalTokens,
    priceMicrosPerMillionTokens: input.priceMicrosPerMillionTokens,
    platformFeeBps: 0
  }).buyerChargeMicros;
}

function divideRoundingUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}
