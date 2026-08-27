import {
  applyKeyringManifest,
  type ApplyKeyringManifestInput
} from "@/server/cryptographic-key-lifecycle-service";
import { apiRoute, jsonResponse, readJson } from "@/server/http";
import { requireMaintenanceAuthorization } from "@/server/maintenance-service";

export async function POST(request: Request): Promise<Response> {
  return apiRoute(async (requestId) => {
    await requireMaintenanceAuthorization(request);
    const input = await readJson<ApplyKeyringManifestInput>(request, 2_048);
    return jsonResponse({ ...(await applyKeyringManifest(input)), requestId });
  });
}
