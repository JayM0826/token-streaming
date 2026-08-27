import type { RotateAuthorizationCredentialRequest } from "@token-streaming/protocol";

import { apiRoute, assertSameOrigin, jsonResponse, readJson } from "@/server/http";
import { rotateAuthorizationCredential } from "@/server/marketplace-service";
import { requireIdentity } from "@/server/security";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ requestId: string }> }
): Promise<Response> {
  return apiRoute(async () => {
    assertSameOrigin(request);
    const identity = await requireIdentity();
    const body = await readJson<RotateAuthorizationCredentialRequest>(request);
    const { requestId } = await params;
    return jsonResponse(await rotateAuthorizationCredential(identity, requestId, body));
  });
}
