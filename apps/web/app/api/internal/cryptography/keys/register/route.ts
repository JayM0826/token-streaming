import {
  registerStagedKey,
  type RegisterStagedKeyInput
} from "@/server/cryptographic-key-lifecycle-service";
import { apiRoute, jsonResponse, readJson } from "@/server/http";
import { requireMaintenanceAuthorization } from "@/server/maintenance-service";

export async function POST(request: Request): Promise<Response> {
  return apiRoute(async (requestId) => {
    await requireMaintenanceAuthorization(request);
    const input = await readJson<RegisterStagedKeyInput>(request, 4_096);
    return jsonResponse({ ...(await registerStagedKey(input)), requestId });
  });
}
