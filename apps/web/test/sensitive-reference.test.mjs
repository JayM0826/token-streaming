import assert from "node:assert/strict";
import test from "node:test";

import { isLikelySecretEvidenceReference } from "../server/sensitive-reference.ts";

test("evidence references reject common secret and high-entropy credential shapes", () => {
  const providerKeyShape = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-");
  const sourceControlKeyShape = `github_${"pat"}_abcdefghijklmnopqrstuvwxyz0123456789`;
  assert.equal(isLikelySecretEvidenceReference(providerKeyShape), true);
  assert.equal(isLikelySecretEvidenceReference(sourceControlKeyShape), true);
  assert.equal(isLikelySecretEvidenceReference(
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature12345678"
  ), true);
  assert.equal(isLikelySecretEvidenceReference("AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABCDEFG"), true);
});

test("evidence-domain identifiers remain usable without storing the evidence itself", () => {
  assert.equal(isLikelySecretEvidenceReference("contract-2026-001"), false);
  assert.equal(isLikelySecretEvidenceReference("license:provider:enterprise-42"), false);
  assert.equal(isLikelySecretEvidenceReference(
    "evidence-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABCDEFG"
  ), false);
});
