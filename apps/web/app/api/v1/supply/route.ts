import type { SetSupplyRequest } from "@token-streaming/protocol";

import { apiRoute, assertSameOrigin, jsonResponse, readJson } from "@/server/http";
import { setSupplyState } from "@/server/marketplace-service";
import { requireIdentity } from "@/server/security";

export async function PUT(request: Request): Promise<Response> {
  return apiRoute(async () => {
    assertSameOrigin(request);
    const identity = await requireIdentity();
    const body = await readJson<SetSupplyRequest>(request);
    return jsonResponse(await setSupplyState(identity, body));
  });
}
