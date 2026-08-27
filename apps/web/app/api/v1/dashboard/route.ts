import { apiRoute, jsonResponse } from "@/server/http";
import { getDashboard } from "@/server/marketplace-service";
import { requireIdentity } from "@/server/security";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return apiRoute(async () => jsonResponse(await getDashboard(await requireIdentity())));
}
