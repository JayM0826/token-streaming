import type { SupplierGatewayInferenceRequest, SupplierGatewayUsage } from "@token-streaming/protocol";

export interface SupplierProviderResult {
  output: string;
  providerRequestId: string;
  servedModel: string;
  receiptRef?: string;
  usage: SupplierGatewayUsage;
}

export interface SupplierProviderAdapter {
  readonly providerId: string;
  invoke(request: SupplierGatewayInferenceRequest, signal: AbortSignal): Promise<SupplierProviderResult>;
}
