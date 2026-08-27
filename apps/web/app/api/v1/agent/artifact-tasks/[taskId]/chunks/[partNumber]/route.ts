import { authenticateAgentRequest } from "@/server/agent-auth";
import { readArtifactTaskChunk } from "@/server/artifact-worker-service";
import { ApiError, apiRoute } from "@/server/http";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ taskId: string; partNumber: string }> }
): Promise<Response> {
  return apiRoute(async () => {
    const { taskId, partNumber } = await params;
    const identity = await authenticateAgentRequest(request, "");
    if (identity.signedJobId !== `${taskId}:chunk:${partNumber}`) {
      throw new ApiError("AUTHENTICATION_REQUIRED", "文件分块请求标识与签名不一致。", 401);
    }
    return readArtifactTaskChunk(identity, taskId, partNumber, request.headers.get("x-gongsuanyun-lease-token"));
  });
}
