import { apiRoute, jsonResponse } from "@/server/http";
import {
  requireMaintenanceAuthorization,
  runMarketplaceMaintenance
} from "@/server/maintenance-service";

export async function POST(request: Request): Promise<Response> {
  return apiRoute(async (requestId) => {
    await requireMaintenanceAuthorization(request);
    return jsonResponse({ ...(await runMarketplaceMaintenance()), requestId });
  });
}
