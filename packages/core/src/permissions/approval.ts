import type { ApprovalRequest, ApprovalResponse } from "@token-streaming/protocol";

export interface ApprovalHost {
  requestApproval(request: ApprovalRequest): Promise<ApprovalResponse>;
}

export class DenyApprovalHost implements ApprovalHost {
  async requestApproval(request: ApprovalRequest): Promise<ApprovalResponse> {
    return {
      requestId: request.id,
      approved: false,
      mode: "deny",
      reason: "No approval host allowed this action."
    };
  }
}

export class AllowApprovalHost implements ApprovalHost {
  async requestApproval(request: ApprovalRequest): Promise<ApprovalResponse> {
    return {
      requestId: request.id,
      approved: true,
      mode: "allow",
      reason: "Action approved by host policy."
    };
  }
}
