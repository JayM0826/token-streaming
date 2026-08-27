import type { SupplierGatewayErrorCode } from "@token-streaming/protocol";

export class SupplierNodeError extends Error {
  readonly code: SupplierGatewayErrorCode;
  readonly status: number;
  readonly retryable: boolean;

  constructor(code: SupplierGatewayErrorCode, message: string, status: number, retryable = false) {
    super(message);
    this.name = "SupplierNodeError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export function normalizeSupplierNodeError(error: unknown): SupplierNodeError {
  if (error instanceof SupplierNodeError) return error;
  return new SupplierNodeError("INTERNAL_ERROR", "供应节点发生内部错误。", 500, true);
}
