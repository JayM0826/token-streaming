import {
  baselineReadableKey,
  type BaselineReadableKeyInput
} from "@/server/cryptographic-key-lifecycle-service";
import { apiRoute, jsonResponse, readJson } from "@/server/http";
import { requireMaintenanceAuthorization } from "@/server/maintenance-service";

export async function POST(request: Request): Promise<Response> {
  return apiRoute(async (requestId) => {
    await requireMaintenanceAuthorization(request);
    const input = await readJson<BaselineReadableKeyInput>(request, 4_096);
    return jsonResponse({ ...(await baselineReadableKey(input)), requestId });
  });
}
