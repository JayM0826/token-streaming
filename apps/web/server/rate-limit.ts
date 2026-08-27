import { ensureSchema, getD1 } from "@/db";
import { ApiError } from "./http";
import type { RequestIdentity } from "./security";

export async function enforceTenantRateLimit(
  identity: RequestIdentity,
  action: string,
  maximumRequests: number,
  windowMilliseconds: number,
  nowMilliseconds = Date.now()
): Promise<void> {
  return enforceScopeRateLimit(identity.tenantId, action, maximumRequests, windowMilliseconds, nowMilliseconds);
}

export async function enforceScopeRateLimit(
  scopeKey: string,
  action: string,
  maximumRequests: number,
  windowMilliseconds: number,
  nowMilliseconds = Date.now()
): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/.test(scopeKey)) throw new Error("Invalid rate-limit scope.");
  if (!/^[a-z][a-z0-9.-]{2,63}$/.test(action)) throw new Error("Invalid rate-limit action.");
  if (!Number.isSafeInteger(maximumRequests) || maximumRequests < 1) throw new Error("Invalid rate-limit maximum.");
  if (!Number.isSafeInteger(windowMilliseconds) || windowMilliseconds < 1_000) throw new Error("Invalid rate-limit window.");
  await ensureSchema();
  const db = getD1();
  const bucketStart = Math.floor(nowMilliseconds / windowMilliseconds) * windowMilliseconds;
  const windowStartedAt = new Date(bucketStart).toISOString();
  const expiresAt = new Date(bucketStart + windowMilliseconds * 2).toISOString();
  await db.batch([
    db.prepare(
      `INSERT INTO api_rate_limits (scope_key, action, window_started_at, request_count, expires_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT (scope_key, action, window_started_at)
       DO UPDATE SET request_count = request_count + 1, expires_at = excluded.expires_at`
    ).bind(scopeKey, action, windowStartedAt, expiresAt),
    db.prepare(
      `DELETE FROM api_rate_limits WHERE rowid IN (
         SELECT rowid FROM api_rate_limits WHERE expires_at <= ? ORDER BY expires_at ASC LIMIT 100
       )`
    ).bind(new Date(nowMilliseconds).toISOString())
  ]);
  const bucket = await db.prepare(
    `SELECT request_count FROM api_rate_limits
     WHERE scope_key = ? AND action = ? AND window_started_at = ?`
  ).bind(scopeKey, action, windowStartedAt).first<{ request_count: number }>();
  if ((bucket?.request_count ?? maximumRequests + 1) > maximumRequests) {
    throw new ApiError("RATE_LIMITED", "操作过于频繁，请稍后重试。", 429, true);
  }
}
