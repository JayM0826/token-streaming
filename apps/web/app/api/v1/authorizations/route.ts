import type { CreateAuthorizationRequest } from "@token-streaming/protocol";

import { apiRoute, assertSameOrigin, jsonResponse, readJson } from "@/server/http";
import { submitAuthorizationRequest } from "@/server/marketplace-service";
import { requireIdentity } from "@/server/security";

export async function POST(request: Request): Promise<Response> {
  return apiRoute(async () => {
    assertSameOrigin(request);
    const identity = await requireIdentity();
    const body = await readJson<CreateAuthorizationRequest>(request);
    return jsonResponse(await submitAuthorizationRequest(identity, body), { status: 201 });
  });
}
