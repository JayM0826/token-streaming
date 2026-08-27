import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { SupplierAgentController } from "./controller.js";
import { renderSupplierAgentUi } from "./ui.js";
import { SupplierAgentError, type SupplierAgentSetupInput } from "./types.js";

export interface SupplierAgentManagementServer {
  server: Server;
  url: string;
  launchUrl: string;
}

export async function startSupplierAgentManagementServer(
  controller: SupplierAgentController,
  port: number,
  onShutdown: () => void
): Promise<SupplierAgentManagementServer> {
  const sessionToken = randomBytes(32).toString("base64url");
  let bootstrapToken: string | undefined = randomBytes(32).toString("base64url");
  const url = `http://127.0.0.1:${port}`;
  const passphraseAttempts = new PassphraseAttemptGate();
  const server = createServer(async (request, response) => {
    try {
      validateHost(request, port);
      const parsed = new URL(request.url ?? "/", url);
      if (request.method === "GET" && parsed.pathname === "/" && !parsed.search) {
        return sendHtml(response, renderSupplierAgentUi(randomBytes(18).toString("base64url")));
      }
      if (request.method === "POST" && parsed.pathname === "/api/bootstrap" && !parsed.search) {
        requireOrigin(request, url);
        const body = await readJson(request);
        assertExactBody(body, ["bootstrapToken"]);
        const candidate = (body as { bootstrapToken?: unknown }).bootstrapToken;
        if (typeof candidate !== "string" || !bootstrapToken || !safeSecretEqual(candidate, bootstrapToken)) {
          throw new SupplierAgentError("SESSION_INVALID", "本地管理启动凭据无效。" );
        }
        bootstrapToken = undefined;
        return sendSession(response, sessionToken);
      }
      requireSession(request, sessionToken);
      if (request.method === "GET" && parsed.pathname === "/api/status" && !parsed.search) {
        return sendJson(response, 200, controller.status());
      }
      if (request.method !== "POST" || parsed.search) return sendError(response, 404, "INVALID_REQUEST", "本地管理接口不存在。");
      requireOrigin(request, url);
      const body = await readJson(request);
      if (parsed.pathname === "/api/setup") {
        return sendJson(response, 200, await controller.setup(body as SupplierAgentSetupInput));
      }
      if (parsed.pathname === "/api/unlock") {
        assertExactBody(body, ["passphrase"]);
        await passphraseAttempts.run(() => controller.unlock((body as { passphrase: string }).passphrase));
        return sendJson(response, 200, { ok: true });
      }
      if (parsed.pathname === "/api/lock") {
        assertExactBody(body, []);
        await controller.lock();
        return sendJson(response, 200, { ok: true });
      }
      if (parsed.pathname === "/api/connection") {
        assertExactBody(body, ["passphrase"]);
        return sendJson(response, 200, await passphraseAttempts.run(
          () => controller.connectionDetails((body as { passphrase: string }).passphrase)
        ));
      }
      if (parsed.pathname === "/api/shutdown") {
        assertExactBody(body, []);
        sendJson(response, 200, { ok: true });
        setImmediate(onShutdown);
        return;
      }
      return sendError(response, 404, "INVALID_REQUEST", "本地管理接口不存在。");
    } catch (error) {
      if (error instanceof SupplierAgentError) {
        const status = error.code === "SESSION_INVALID" ? 401 : error.code === "ORIGIN_REJECTED" ? 403 : error.code === "RATE_LIMITED" ? 429 : error.code === "ALREADY_CONFIGURED" ? 409 : 400;
        return sendError(response, status, error.code, error.message);
      }
      const message = error instanceof Error && error.message === "PAYLOAD_TOO_LARGE" ? "请求体超过本地管理限制。" : "本地供应客户端发生内部错误。";
      return sendError(response, error instanceof Error && error.message === "PAYLOAD_TOO_LARGE" ? 413 : 500, "INTERNAL_ERROR", message);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return { server, url, launchUrl: `${url}/#bootstrap=${bootstrapToken}` };
}

export class PassphraseAttemptGate {
  private failedAttempts = 0;
  private windowStartedAt = 0;
  private blockedUntil = 0;
  private inFlight = 0;

  constructor(
    private readonly maximumFailures = 5,
    private readonly windowMilliseconds = 60_000,
    private readonly blockMilliseconds = 30_000,
    private readonly now = () => Date.now()
  ) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.now();
    if (current < this.blockedUntil) {
      throw new SupplierAgentError("RATE_LIMITED", "口令验证失败次数过多，请稍后重试。");
    }
    if (current - this.windowStartedAt >= this.windowMilliseconds) this.reset(current);
    if (this.inFlight > 0) {
      throw new SupplierAgentError("RATE_LIMITED", "已有口令验证正在进行，请稍后重试。");
    }
    this.inFlight += 1;
    try {
      const result = await operation();
      this.reset(this.now());
      return result;
    } catch (error) {
      if (error instanceof SupplierAgentError && error.code === "VAULT_UNLOCK_FAILED") {
        this.failedAttempts += 1;
        if (this.failedAttempts >= this.maximumFailures) this.blockedUntil = this.now() + this.blockMilliseconds;
      }
      throw error;
    } finally {
      this.inFlight -= 1;
    }
  }

  private reset(now: number): void {
    this.failedAttempts = 0;
    this.windowStartedAt = now;
    this.blockedUntil = 0;
  }
}

function validateHost(request: IncomingMessage, port: number): void {
  const host = request.headers.host;
  if (host !== `127.0.0.1:${port}`) throw new SupplierAgentError("SESSION_INVALID", "本地管理 Host 无效。");
}

function requireSession(request: IncomingMessage, expected: string): void {
  const received = readSessionCookie(request.headers.cookie);
  if (!received) throw new SupplierAgentError("SESSION_INVALID", "本地管理会话无效。");
  if (!safeSecretEqual(received, expected)) throw new SupplierAgentError("SESSION_INVALID", "本地管理会话无效。");
}

function safeSecretEqual(received: string, expected: string): boolean {
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function readSessionCookie(header: string | undefined): string | undefined {
  if (!header || header.length > 8_192) return undefined;
  const values = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("gongsuanyun_agent_session="))
    .map((part) => part.slice("gongsuanyun_agent_session=".length));
  return values.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(values[0] ?? "") ? values[0] : undefined;
}

function requireOrigin(request: IncomingMessage, expected: string): void {
  if (request.headers.origin !== expected) throw new SupplierAgentError("ORIGIN_REJECTED", "本地管理请求来源无效。");
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new SupplierAgentError("INVALID_INPUT", "Content-Type 必须是 application/json。");
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 64 * 1024) throw new Error("PAYLOAD_TOO_LARGE");
    chunks.push(buffer);
  }
  try {
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? JSON.parse(raw) as unknown : {};
  } catch {
    throw new SupplierAgentError("INVALID_INPUT", "请求正文不是有效 JSON。");
  }
}

function assertExactBody(value: unknown, keys: readonly string[]): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new SupplierAgentError("INVALID_INPUT", "请求正文必须是对象。");
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) throw new SupplierAgentError("INVALID_INPUT", "请求字段无效。");
  if (keys.includes("passphrase") && typeof (value as { passphrase?: unknown }).passphrase !== "string") {
    throw new SupplierAgentError("INVALID_INPUT", "passphrase 必须是字符串。");
  }
}

function sendHtml(response: ServerResponse, html: string): void {
  const nonce = html.match(/nonce="([A-Za-z0-9_-]+)"/)?.[1];
  response.writeHead(200, securityHeaders({
    "content-type": "text/html; charset=utf-8",
    "content-length": String(Buffer.byteLength(html)),
    "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
  }));
  response.end(html);
}

function sendSession(response: ServerResponse, sessionToken: string): void {
  const encoded = JSON.stringify({ ok: true });
  response.writeHead(200, securityHeaders({
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(encoded)),
    "set-cookie": `gongsuanyun_agent_session=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`
  }));
  response.end(encoded);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, securityHeaders({ "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(encoded)) }));
  response.end(encoded);
}

function sendError(response: ServerResponse, status: number, code: string, message: string): void {
  sendJson(response, status, { ok: false, error: { code, message } });
}

function securityHeaders(extra: Record<string, string>): Record<string, string> {
  return {
    "cache-control": "no-store",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-embedder-policy": "require-corp",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    ...extra
  };
}
