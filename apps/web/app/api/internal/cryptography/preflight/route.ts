import { runCryptographicPreflight } from "@/server/cryptographic-preflight-service";
import { apiRoute, jsonResponse } from "@/server/http";
import { requireCryptographicPreflightAuthorization } from "@/server/maintenance-service";

export async function POST(request: Request): Promise<Response> {
  return apiRoute(async (requestId) => {
    await requireCryptographicPreflightAuthorization(request);
    return jsonResponse({ ...(await runCryptographicPreflight()), requestId });
  });
}
