import { uploadArtifactChunk } from "@/server/artifact-service";
import { apiRoute, assertSameOrigin, jsonResponse } from "@/server/http";
import { requireIdentity } from "@/server/security";

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ artifactId: string; partNumber: string }> }
): Promise<Response> {
  return apiRoute(async (requestId) => {
    assertSameOrigin(request);
    const identity = await requireIdentity();
    const { artifactId, partNumber } = await params;
    return jsonResponse(await uploadArtifactChunk(identity, artifactId, partNumber, request, requestId));
  });
}
