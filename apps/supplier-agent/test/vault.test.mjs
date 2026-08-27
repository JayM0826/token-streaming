import assert from "node:assert/strict";
import test from "node:test";

import { decryptSupplierAgentVault, encryptSupplierAgentVault } from "../dist/vault.js";

const secrets = {
  gatewayToken: "gateway-token-abcdefghijklmnopqrstuvwxyz-123456",
  upstreamApiKey: "upstream-secret-abcdefghijklmnopqrstuvwxyz"
};

test("supplier credentials round-trip through the encrypted local vault", async () => {
  const vault = await encryptSupplierAgentVault(secrets, "correct horse battery staple");
  assert.equal(vault.cipher, "aes-256-gcm");
  assert.equal(vault.kdf, "scrypt-v1");
  assert.equal(JSON.stringify(vault).includes(secrets.gatewayToken), false);
  assert.equal(JSON.stringify(vault).includes(secrets.upstreamApiKey), false);
  assert.deepEqual(await decryptSupplierAgentVault(vault, "correct horse battery staple"), secrets);
});

test("wrong passphrases and tampered vaults fail closed", async () => {
  const vault = await encryptSupplierAgentVault(secrets, "correct horse battery staple");
  await assert.rejects(
    decryptSupplierAgentVault(vault, "incorrect password value"),
    (error) => error?.code === "VAULT_UNLOCK_FAILED"
  );
  const replacement = vault.ciphertext[0] === "A" ? "B" : "A";
  const tampered = { ...vault, ciphertext: `${replacement}${vault.ciphertext.slice(1)}` };
  await assert.rejects(
    decryptSupplierAgentVault(tampered, "correct horse battery staple"),
    (error) => error?.code === "VAULT_UNLOCK_FAILED"
  );
});
