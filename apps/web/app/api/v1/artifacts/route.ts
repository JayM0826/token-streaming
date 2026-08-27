import type { CreateArtifactUploadRequest } from "@token-streaming/protocol";

import { createArtifactUpload } from "@/server/artifact-service";
import { apiRoute, assertSameOrigin, jsonResponse, readJson } from "@/server/http";
import { requireIdentity } from "@/server/security";

export async function POST(request: Request): Promise<Response> {
  return apiRoute(async (requestId) => {
    assertSameOrigin(request);
    const identity = await requireIdentity();
    const body = await readJson<CreateArtifactUploadRequest>(request);
    return jsonResponse(await createArtifactUpload(identity, body, requestId), { status: 201 });
  });
}
