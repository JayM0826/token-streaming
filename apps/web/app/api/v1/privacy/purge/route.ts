import type { PurgeMarketplaceContentRequest } from "@token-streaming/protocol";

import { apiRoute, assertSameOrigin, jsonResponse, readJson } from "@/server/http";
import { purgeMarketplaceContent } from "@/server/privacy-service";
import { requireIdentity } from "@/server/security";

export async function POST(request: Request): Promise<Response> {
  return apiRoute(async (requestId) => {
    assertSameOrigin(request);
    const identity = await requireIdentity();
    const input = await readJson<PurgeMarketplaceContentRequest>(request, 8_192);
    return jsonResponse(await purgeMarketplaceContent(identity, input, requestId));
  });
}
