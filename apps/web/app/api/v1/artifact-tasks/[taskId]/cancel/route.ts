import type { CancelArtifactTaskRequest } from "@token-streaming/protocol";

import { cancelArtifactTask } from "@/server/artifact-service";
import { apiRoute, assertSameOrigin, jsonResponse, readJson } from "@/server/http";
import { requireIdentity } from "@/server/security";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ taskId: string }> }
): Promise<Response> {
  return apiRoute(async (requestId) => {
    assertSameOrigin(request);
    const identity = await requireIdentity();
    const { taskId } = await params;
    const body = await readJson<CancelArtifactTaskRequest>(request, 8_192);
    return jsonResponse(await cancelArtifactTask(identity, taskId, body, requestId), { status: 202 });
  });
}
