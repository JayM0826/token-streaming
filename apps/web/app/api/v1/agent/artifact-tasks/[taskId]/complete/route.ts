import type { SupplierArtifactTaskCompleteRequest } from "@token-streaming/protocol";

import { readSignedAgentJson } from "@/server/agent-auth";
import { completeArtifactTask } from "@/server/artifact-worker-service";
import { ApiError, apiRoute, jsonResponse } from "@/server/http";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ taskId: string }> }
): Promise<Response> {
  return apiRoute(async () => {
    const { taskId } = await params;
    const { body, identity } = await readSignedAgentJson<SupplierArtifactTaskCompleteRequest>(request, 512_000);
    if (body.task_id !== taskId) throw new ApiError("INVALID_REQUEST", "任务路径与请求体不一致。", 400);
    return jsonResponse(await completeArtifactTask(identity, body));
  });
}
