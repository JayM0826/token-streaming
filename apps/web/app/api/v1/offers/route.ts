import type { CreateCapacityOfferRequest } from "@token-streaming/protocol";

import { apiRoute, assertSameOrigin, jsonResponse, readJson } from "@/server/http";
import { createCapacityOffer } from "@/server/marketplace-service";
import { requireIdentity } from "@/server/security";

export async function POST(request: Request): Promise<Response> {
  return apiRoute(async () => {
    assertSameOrigin(request);
    const identity = await requireIdentity();
    const body = await readJson<CreateCapacityOfferRequest>(request);
    return jsonResponse(await createCapacityOffer(identity, body), { status: 201 });
  });
}
