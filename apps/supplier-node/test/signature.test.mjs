import assert from "node:assert/strict";
import test from "node:test";
import {
  NonceReplayGuard,
  createGatewaySignature,
  sha256Hex,
  verifySignedGatewayCall
} from "../dist/signature.js";

const token = "gateway-token-abcdefghijklmnopqrstuvwxyz-123456";
const rawBody = JSON.stringify({ request_id: "job-12345678" });

test("signed gateway calls authenticate and reject nonce replay", () => {
  const now = 1_800_000_000_000;
  const call = signedCall("nonce-abcdefghijklmnop", now);
  const guard = new NonceReplayGuard();
  assert.deepEqual(verifySignedGatewayCall(call, token, guard, now), {
    jobId: "job-12345678",
    bodySha256: sha256Hex(rawBody)
  });
  assert.throws(
    () => verifySignedGatewayCall(call, token, guard, now),
    (error) => error.code === "REPLAY_DETECTED"
  );
});

test("signed gateway calls reject stale timestamps and invalid signatures", () => {
  const now = 1_800_000_000_000;
  assert.throws(
    () => verifySignedGatewayCall(signedCall("nonce-stale-abcdefghijk", now - 600_000), token, new NonceReplayGuard(), now),
    (error) => error.code === "REQUEST_EXPIRED"
  );
  const call = signedCall("nonce-invalid-abcdefgh", now);
  call.signature = "0".repeat(64);
  assert.throws(
    () => verifySignedGatewayCall(call, token, new NonceReplayGuard(), now),
    (error) => error.code === "SIGNATURE_INVALID"
  );
});

function signedCall(nonce, timestampMs) {
  const timestamp = String(timestampMs);
  const bodySha256 = sha256Hex(rawBody);
  return {
    authorization: `Bearer ${token}`,
    timestamp,
    nonce,
    jobId: "job-12345678",
    signature: createGatewaySignature(token, { timestamp, nonce, jobId: "job-12345678", bodySha256 }),
    rawBody
  };
}
