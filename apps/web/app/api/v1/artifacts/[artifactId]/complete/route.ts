import type { CompleteArtifactUploadRequest } from "@token-streaming/protocol";

import { completeArtifactUpload } from "@/server/artifact-service";
import { apiRoute, assertSameOrigin, jsonResponse, readJson } from "@/server/http";
import { requireIdentity } from "@/server/security";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ artifactId: string }> }
): Promise<Response> {
  return apiRoute(async (requestId) => {
    assertSameOrigin(request);
    const identity = await requireIdentity();
    const { artifactId } = await params;
    const body = await readJson<CompleteArtifactUploadRequest>(request, 32_000);
    return jsonResponse(await completeArtifactUpload(identity, artifactId, body, requestId));
  });
}
