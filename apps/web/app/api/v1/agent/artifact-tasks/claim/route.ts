import type { SupplierArtifactWorkerClaimRequest } from "@token-streaming/protocol";

import { readSignedAgentJson } from "@/server/agent-auth";
import { claimArtifactTask } from "@/server/artifact-worker-service";
import { apiRoute, jsonResponse } from "@/server/http";

export async function POST(request: Request): Promise<Response> {
  return apiRoute(async () => {
    const { body, identity } = await readSignedAgentJson<SupplierArtifactWorkerClaimRequest>(request);
    return jsonResponse(await claimArtifactTask(identity, body));
  });
}
