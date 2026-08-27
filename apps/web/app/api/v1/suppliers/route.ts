import type { RegisterSupplierRequest } from "@token-streaming/protocol";

import { apiRoute, assertSameOrigin, jsonResponse, readJson } from "@/server/http";
import { registerSupplierProfile } from "@/server/marketplace-service";
import { requireIdentity } from "@/server/security";

export async function POST(request: Request): Promise<Response> {
  return apiRoute(async () => {
    assertSameOrigin(request);
    const identity = await requireIdentity();
    const body = await readJson<RegisterSupplierRequest>(request);
    return jsonResponse(await registerSupplierProfile(identity, body), { status: 201 });
  });
}
