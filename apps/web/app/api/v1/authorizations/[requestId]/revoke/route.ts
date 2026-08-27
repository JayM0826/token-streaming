import type { RevokeAuthorizationRequest } from "@token-streaming/protocol";

import { apiRoute, assertSameOrigin, jsonResponse, readJson } from "@/server/http";
import { revokeAuthorization } from "@/server/marketplace-service";
import { requireIdentity } from "@/server/security";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ requestId: string }> }
): Promise<Response> {
  return apiRoute(async () => {
    assertSameOrigin(request);
    const identity = await requireIdentity();
    const body = await readJson<RevokeAuthorizationRequest>(request);
    const { requestId } = await params;
    return jsonResponse(await revokeAuthorization(identity, requestId, body));
  });
}
