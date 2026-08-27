import type { SupplierGatewayInferenceRequest } from "@token-streaming/protocol";
import type { SupplierNodeConfig, UpstreamProtocol } from "./config.js";
import { SupplierNodeError } from "./errors.js";
import type { SupplierProviderAdapter, SupplierProviderResult } from "./provider-adapter.js";

interface OpenAICompatibleAdapterOptions {
  providerId: string;
  protocol: UpstreamProtocol;
  baseUrl: URL;
  apiKey: string;
  timeoutMs: number;
  maximumResponseBytes: number;
  fetch?: typeof fetch;
}

export class OpenAICompatibleAdapter implements SupplierProviderAdapter {
  readonly providerId: string;
  private readonly protocol: UpstreamProtocol;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maximumResponseBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAICompatibleAdapterOptions) {
    this.providerId = options.providerId;
    this.protocol = options.protocol;
    this.baseUrl = options.baseUrl.toString().replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs;
    this.maximumResponseBytes = options.maximumResponseBytes;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async invoke(
    request: SupplierGatewayInferenceRequest,
    signal: AbortSignal
  ): Promise<SupplierProviderResult> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/${this.protocol === "responses" ? "responses" : "chat/completions"}`,
        {
          method: "POST",
          redirect: "error",
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json",
            "idempotency-key": request.request_id
          },
          body: JSON.stringify(this.protocol === "responses" ? toResponsesBody(request) : toChatBody(request)),
          signal: AbortSignal.any([signal, timeoutSignal])
        }
      );
    } catch (error) {
      if (isAbortError(error) || signal.aborted || timeoutSignal.aborted) {
        throw new SupplierNodeError("UPSTREAM_TIMEOUT", "上游模型请求超时。", 504, true);
      }
      throw new SupplierNodeError("UPSTREAM_UNAVAILABLE", "无法连接上游模型服务。", 502, true);
    }

    const raw = await readBoundedText(response, this.maximumResponseBytes);
    if (!response.ok) throw mapUpstreamHttpError(response.status);
    const body = parseJsonRecord(raw);
    const result = this.protocol === "responses"
      ? mapResponsesResult(body, response.headers)
      : mapChatResult(body, response.headers);
    if (result.servedModel !== request.model) {
      throw new SupplierNodeError(
        "UPSTREAM_MODEL_MISMATCH",
        "上游实际返回模型与购买的精确模型不一致。",
        502
      );
    }
    return result;
  }
}

export function createConfiguredProviderAdapter(config: SupplierNodeConfig): SupplierProviderAdapter {
  return new OpenAICompatibleAdapter({
    providerId: config.providerId,
    protocol: config.upstream.protocol,
    baseUrl: config.upstream.baseUrl,
    apiKey: config.upstream.apiKey,
    timeoutMs: config.upstream.timeoutMs,
    maximumResponseBytes: config.upstream.maximumResponseBytes
  });
}

function toResponsesBody(request: SupplierGatewayInferenceRequest): Record<string, unknown> {
  return {
    model: request.model,
    input: request.input,
    max_output_tokens: request.max_output_tokens,
    stream: false,
    store: false
  };
}

function toChatBody(request: SupplierGatewayInferenceRequest): Record<string, unknown> {
  return {
    model: request.model,
    messages: [{ role: "user", content: request.input }],
    max_completion_tokens: request.max_output_tokens,
    stream: false,
    store: false
  };
}

function mapResponsesResult(body: Record<string, unknown>, headers: Headers): SupplierProviderResult {
  const usage = record(body.usage);
  const inputTokens = safeInteger(usage.input_tokens, false);
  const outputTokens = safeInteger(usage.output_tokens, true);
  const output = responseOutputText(body);
  return normalizedResult(body.id, body.model, headers, output, inputTokens, outputTokens, usage.total_tokens);
}

function mapChatResult(body: Record<string, unknown>, headers: Headers): SupplierProviderResult {
  const usage = record(body.usage);
  const choice = Array.isArray(body.choices) ? record(body.choices[0]) : {};
  const message = record(choice.message);
  const content = message.content;
  const output = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((item) => record(item).text).filter((text): text is string => typeof text === "string").join("\n")
      : "";
  const inputTokens = safeInteger(usage.prompt_tokens, false);
  const outputTokens = safeInteger(usage.completion_tokens, true);
  return normalizedResult(body.id, body.model, headers, output, inputTokens, outputTokens, usage.total_tokens);
}

function normalizedResult(
  bodyRequestId: unknown,
  bodyModel: unknown,
  headers: Headers,
  output: string,
  inputTokens: number,
  outputTokens: number,
  declaredTotal: unknown
): SupplierProviderResult {
  if (!output || output.length > 200_000) {
    throw new SupplierNodeError("UPSTREAM_RESPONSE_INVALID", "上游模型输出为空或超过节点限制。", 502);
  }
  const providerRequestId = boundedString(bodyRequestId, 256) ?? boundedString(headers.get("x-request-id"), 256);
  if (!providerRequestId) {
    throw new SupplierNodeError("UPSTREAM_RESPONSE_INVALID", "上游响应缺少请求标识。", 502);
  }
  const servedModel = boundedString(bodyModel, 200);
  if (!servedModel) {
    throw new SupplierNodeError("UPSTREAM_RESPONSE_INVALID", "上游响应缺少实际模型标识。", 502);
  }
  const totalTokens = declaredTotal === undefined
    ? inputTokens + outputTokens
    : safeInteger(declaredTotal, false);
  if (totalTokens !== inputTokens + outputTokens) {
    throw new SupplierNodeError("UPSTREAM_RESPONSE_INVALID", "上游用量字段不一致。", 502);
  }
  const receiptRef = boundedString(headers.get("x-request-id"), 256);
  return {
    output,
    providerRequestId,
    servedModel,
    ...(receiptRef ? { receiptRef } : {}),
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens
    }
  };
}

function responseOutputText(body: Record<string, unknown>): string {
  if (typeof body.output_text === "string") return body.output_text;
  if (!Array.isArray(body.output)) return "";
  return body.output
    .flatMap((item) => {
      const content = record(item).content;
      return Array.isArray(content) ? content : [];
    })
    .map((item) => record(item).text)
    .filter((text): text is string => typeof text === "string")
    .join("\n")
    .trim();
}

async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new SupplierNodeError("UPSTREAM_RESPONSE_INVALID", "上游响应超过节点大小限制。", 502);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new SupplierNodeError("UPSTREAM_RESPONSE_INVALID", "上游响应超过节点大小限制。", 502);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function parseJsonRecord(raw: string): Record<string, unknown> {
  try {
    return record(JSON.parse(raw));
  } catch {
    throw new SupplierNodeError("UPSTREAM_RESPONSE_INVALID", "上游响应不是有效 JSON。", 502);
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeInteger(value: unknown, allowZero: boolean): number {
  if (!Number.isSafeInteger(value) || (value as number) < (allowZero ? 0 : 1)) {
    throw new SupplierNodeError("UPSTREAM_RESPONSE_INVALID", "上游响应包含无效用量。", 502);
  }
  return value as number;
}

function boundedString(value: unknown, maximumLength: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength ? value : null;
}

function mapUpstreamHttpError(status: number): SupplierNodeError {
  if (status === 401 || status === 403) {
    return new SupplierNodeError("UPSTREAM_AUTH_FAILED", "上游模型凭据无效或权限不足。", 502);
  }
  if (status === 429) {
    return new SupplierNodeError("UPSTREAM_RATE_LIMITED", "上游模型容量暂时不足。", 503, true);
  }
  return new SupplierNodeError("UPSTREAM_UNAVAILABLE", `上游模型返回 HTTP ${status}。`, 502, status >= 500);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
