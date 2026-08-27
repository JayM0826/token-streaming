import type { CreateArtifactTaskRequest } from "@token-streaming/protocol";

import { createArtifactTask } from "@/server/artifact-service";
import { ApiError, apiRoute, assertSameOrigin, jsonResponse, readJson } from "@/server/http";
import { requireIdentity } from "@/server/security";

export async function POST(request: Request): Promise<Response> {
  return apiRoute(async (requestId) => {
    assertSameOrigin(request);
    const identity = await requireIdentity();
    const idempotencyKey = request.headers.get("idempotency-key");
    if (!idempotencyKey) throw new ApiError("INVALID_REQUEST", "缺少 Idempotency-Key 请求头。", 400);
    const body = await readJson<CreateArtifactTaskRequest>(request);
    return jsonResponse(await createArtifactTask(identity, body, idempotencyKey, requestId), { status: 202 });
  });
}
