import assert from "node:assert/strict";
import test from "node:test";

import {
  createSupplierAgentProfile,
  validateSupplierAgentProfile,
  validateSupplierAgentProfileInput
} from "../dist/profile.js";

function profileInput(overrides = {}) {
  return {
    providerId: "provider-test",
    allowedModels: ["model-exact-2026-08-25"],
    allowedDataClasses: ["P0"],
    publicGatewayEndpoint: "https://node.example.com/v3/inference",
    controlPlaneBaseUrl: "https://market.example.com",
    gatewayPort: 8789,
    upstreamProtocol: "responses",
    upstreamBaseUrl: "https://api.provider.example/v1",
    upstreamHostAllowlist: ["provider.example"],
    limits: {
      requestsPerMinute: 30,
      tokensPerMinute: 100_000,
      concurrency: 2,
      maxOutputTokens: 4_096,
      maxInputBytes: 262_144,
      maxArtifactBytes: 256 * 1024 * 1024,
      artifactSegmentBytes: 131_072
    },
    ...overrides
  };
}

test("supplier profile keeps exact model, public endpoint, and capacity boundaries", () => {
  const profile = createSupplierAgentProfile(profileInput(), undefined, "2026-08-25T00:00:00.000Z");
  assert.equal(profile.profileVersion, 2);
  assert.deepEqual(profile.allowedModels, ["model-exact-2026-08-25"]);
  assert.equal(profile.publicGatewayEndpoint, "https://node.example.com/v3/inference");
  assert.equal(profile.createdAt, profile.updatedAt);
});

test("supplier profile rejects private, wildcard, widened, and unknown configuration", () => {
  assert.throws(() => validateSupplierAgentProfileInput(profileInput({ publicGatewayEndpoint: "http://127.0.0.1:8789/v3/inference" })));
  assert.throws(() => validateSupplierAgentProfileInput(profileInput({ allowedModels: ["model-*"] })));
  assert.throws(() => validateSupplierAgentProfileInput(profileInput({ upstreamHostAllowlist: ["other.example"] })));
  assert.throws(() => validateSupplierAgentProfileInput(profileInput({ controlPlaneBaseUrl: "http://localhost:3000" })));
  assert.throws(() => validateSupplierAgentProfileInput(profileInput({ limits: { ...profileInput().limits, artifactSegmentBytes: 300_000 } })));
  assert.throws(() => validateSupplierAgentProfileInput({ ...profileInput(), unexpected: true }));
});

test("legacy v1 profiles migrate to the outbound artifact worker without widening unsafe small inputs", () => {
  const legacy = profileInput();
  delete legacy.controlPlaneBaseUrl;
  delete legacy.limits.maxArtifactBytes;
  delete legacy.limits.artifactSegmentBytes;
  legacy.limits.maxInputBytes = 65_536;
  const migrated = validateSupplierAgentProfile({
    profileVersion: 1,
    ...legacy,
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z"
  });
  assert.equal(migrated.profileVersion, 2);
  assert.equal(migrated.controlPlaneBaseUrl, "https://gongsuanyun-market.wenzaiyin.chatgpt.site");
  assert.equal(migrated.limits.maxArtifactBytes, 256 * 1024 * 1024);
  assert.equal(migrated.limits.artifactSegmentBytes, 61_440);

  legacy.limits.maxInputBytes = 16_384;
  const safelyDisabled = validateSupplierAgentProfile({
    profileVersion: 1,
    ...legacy,
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z"
  });
  assert.equal(safelyDisabled.limits.maxArtifactBytes, 0);
});
