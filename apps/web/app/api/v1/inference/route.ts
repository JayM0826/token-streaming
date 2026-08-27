import type { RunInferenceRequest } from "@token-streaming/protocol";

import { ApiError, apiRoute, assertSameOrigin, jsonResponse, readJson } from "@/server/http";
import { runInference } from "@/server/marketplace-service";
import { requireIdentity } from "@/server/security";

export async function POST(request: Request): Promise<Response> {
  return apiRoute(async (requestId) => {
    assertSameOrigin(request);
    const identity = await requireIdentity();
    const idempotencyKey = request.headers.get("idempotency-key");
    if (!idempotencyKey) throw new ApiError("INVALID_REQUEST", "缺少 Idempotency-Key 请求头。", 400);
    const body = await readJson<RunInferenceRequest>(request);
    return jsonResponse(await runInference(identity, body, idempotencyKey, requestId));
  });
}
