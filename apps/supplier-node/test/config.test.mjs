import assert from "node:assert/strict";
import test from "node:test";
import { loadSupplierNodeConfig } from "../dist/config.js";

test("supplier node configuration is explicit and keeps secrets out of diagnostics", () => {
  const config = loadSupplierNodeConfig(validEnv());
  assert.equal(config.bindHost, "127.0.0.1");
  assert.equal(config.upstream.baseUrl.hostname, "api.provider.example");
  assert.deepEqual(config.allowedModels, ["model-a", "model-b"]);
  assert.deepEqual(config.allowedDataClasses, ["P0", "P1"]);
});

test("supplier node rejects private upstreams, missing host authorization, and short gateway tokens", () => {
  assert.throws(
    () => loadSupplierNodeConfig(validEnv({ SUPPLIER_NODE_UPSTREAM_BASE_URL: "http://localhost:9000/v1" })),
    /public HTTPS URL/
  );
  assert.throws(
    () => loadSupplierNodeConfig(validEnv({ SUPPLIER_NODE_UPSTREAM_HOST_ALLOWLIST: "other.example" })),
    /not in SUPPLIER_NODE_UPSTREAM_HOST_ALLOWLIST/
  );
  assert.throws(
    () => loadSupplierNodeConfig(validEnv({ SUPPLIER_NODE_GATEWAY_TOKEN: "too-short" })),
    /32 to 4096/
  );
  assert.throws(
    () => loadSupplierNodeConfig(validEnv({ SUPPLIER_NODE_ALLOWED_MODELS: "model-*" })),
    /exact 1-120 character model names/
  );
});

function validEnv(overrides = {}) {
  return {
    SUPPLIER_NODE_GATEWAY_TOKEN: "gateway-token-abcdefghijklmnopqrstuvwxyz-123456",
    SUPPLIER_NODE_UPSTREAM_API_KEY: "upstream-secret-value",
    SUPPLIER_NODE_PROVIDER_ID: "provider-test",
    SUPPLIER_NODE_ALLOWED_MODELS: "model-a,model-b",
    SUPPLIER_NODE_ALLOWED_DATA_CLASSES: "P0,P1",
    SUPPLIER_NODE_UPSTREAM_PROTOCOL: "responses",
    SUPPLIER_NODE_UPSTREAM_BASE_URL: "https://api.provider.example/v1",
    SUPPLIER_NODE_UPSTREAM_HOST_ALLOWLIST: "api.provider.example",
    ...overrides
  };
}
