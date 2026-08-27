import assert from "node:assert/strict";
import test from "node:test";

import { decryptSupplierAgentVault, encryptSupplierAgentVault } from "../dist/vault.js";

const secrets = {
  gatewayToken: "gateway-token-abcdefghijklmnopqrstuvwxyz-123456",
  upstreamApiKey: "upstream-secret-abcdefghijklmnopqrstuvwxyz"
};

const profile = {
  profileVersion: 2,
  providerId: "provider-local-test",
  allowedModels: ["model-a"],
  allowedDataClasses: ["P0"],
  publicGatewayEndpoint: "https://supplier.example/v3/inference",
  controlPlaneBaseUrl: "https://market.example",
  gatewayPort: 8091,
  upstreamProtocol: "responses",
  upstreamBaseUrl: "https://api.provider.example/v1",
  upstreamHostAllowlist: ["provider.example"],
  limits: {
    requestsPerMinute: 60,
    tokensPerMinute: 100000,
    concurrency: 2,
    maxOutputTokens: 4096,
    maxInputBytes: 100000,
    maxArtifactBytes: 0,
    artifactSegmentBytes: 1
  },
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:00:00.000Z"
};

test("supplier credentials round-trip through the encrypted local vault", async () => {
  const vault = await encryptSupplierAgentVault(secrets, "correct horse battery staple", profile);
  assert.equal(vault.vaultVersion, 2);
  assert.equal(vault.cipher, "aes-256-gcm");
  assert.equal(vault.kdf, "scrypt-v1");
  assert.equal(JSON.stringify(vault).includes(secrets.gatewayToken), false);
  assert.equal(JSON.stringify(vault).includes(secrets.upstreamApiKey), false);
  assert.deepEqual(await decryptSupplierAgentVault(vault, "correct horse battery staple", profile), secrets);
});

test("wrong passphrases and tampered vaults fail closed", async () => {
  const vault = await encryptSupplierAgentVault(secrets, "correct horse battery staple", profile);
  await assert.rejects(
    decryptSupplierAgentVault(vault, "incorrect password value", profile),
    (error) => error?.code === "VAULT_UNLOCK_FAILED"
  );
  const replacement = vault.ciphertext[0] === "A" ? "B" : "A";
  const tampered = { ...vault, ciphertext: `${replacement}${vault.ciphertext.slice(1)}` };
  await assert.rejects(
    decryptSupplierAgentVault(tampered, "correct horse battery staple", profile),
    (error) => error?.code === "VAULT_UNLOCK_FAILED"
  );
});

test("the vault is bound to the complete validated supplier profile", async () => {
  const vault = await encryptSupplierAgentVault(secrets, "correct horse battery staple", profile);
  const tamperedProfile = {
    ...profile,
    upstreamBaseUrl: "https://attacker.example/v1",
    upstreamHostAllowlist: ["attacker.example"]
  };
  await assert.rejects(
    decryptSupplierAgentVault(vault, "correct horse battery staple", tamperedProfile),
    (error) => error?.code === "VAULT_UNLOCK_FAILED"
  );
});
