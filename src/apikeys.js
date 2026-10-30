/** API keys: generation, hashing, bearer authentication. */
import { randomToken, sha256Hex } from "./crypto.js";
import { nowIso } from "./http.js";

const KEY_PREFIX = "pb_live_";

export async function createApiKey(env, userId, name, expiresInDays = 0) {
  const raw = KEY_PREFIX + randomToken(24); // 48 hex chars after prefix
  const hash = await sha256Hex(raw);
  const displayPrefix = raw.slice(0, KEY_PREFIX.length + 6);
  const keyName = String(name || "").trim().slice(0, 60) || "default";
  // v1.21: optional expiry. Computed in SQLite so both sides agree on the format.
  const days = Math.min(3650, Math.max(0, parseInt(expiresInDays, 10) || 0));
  const res = days > 0
    ? await env.DB.prepare(
        "INSERT INTO api_keys (user_id, name, key_hash, key_prefix, expires_at) VALUES (?, ?, ?, ?, datetime('now', ?))",
      )
        .bind(userId, keyName, hash, displayPrefix, `+${days} days`)
        .run()
    : await env.DB.prepare(
        "INSERT INTO api_keys (user_id, name, key_hash, key_prefix) VALUES (?, ?, ?, ?)",
      )
        .bind(userId, keyName, hash, displayPrefix)
        .run();
  const row = await env.DB.prepare("SELECT expires_at FROM api_keys WHERE id = ?")
    .bind(res.meta.last_row_id)
    .first();
  return {
    id: res.meta.last_row_id,
    key: raw,
    prefix: displayPrefix,
    name: keyName,
    expires_at: row?.expires_at || null,
  };
}

export async function listApiKeys(env, userId) {
  const { results } = await env.DB.prepare(
    `SELECT id, name, key_prefix, created_at, last_used_at, expires_at, revoked,
            CASE WHEN expires_at IS NOT NULL AND julianday(expires_at) <= julianday('now')
                 THEN 1 ELSE 0 END AS expired
     FROM api_keys WHERE user_id = ? AND revoked = 0 ORDER BY id DESC`,
  )
    .bind(userId)
    .all();
  return results || [];
}

export async function revokeApiKey(env, userId, keyId) {
  const res = await env.DB.prepare(
    "UPDATE api_keys SET revoked = 1 WHERE id = ? AND user_id = ?",
  )
    .bind(Number(keyId), userId)
    .run();
  return (res.meta?.changes || 0) > 0;
}

/**
 * Authenticate a request via `Authorization: Bearer pb_live_...`.
 * Returns the owning user row (public fields) or null.
 */
export async function authenticateApiKey(env, request, ctx) {
  const auth = request.headers.get("authorization") || "";
  const m = /^Bearer\s+(pb_live_[0-9a-f]+)$/i.exec(auth);
  if (!m) return null;
  const raw = m[1];
  const hash = await sha256Hex(raw);
  const row = await env.DB.prepare(
    `SELECT k.id AS key_id, u.id, u.email, u.display_name, u.role, u.status,
            u.quota_bytes, u.used_bytes, u.created_at, u.last_login_at
     FROM api_keys k JOIN users u ON u.id = k.user_id
     WHERE k.key_hash = ? AND k.revoked = 0
       AND (k.expires_at IS NULL OR julianday(k.expires_at) > julianday('now'))`,
  )
    .bind(hash)
    .first();
  if (!row || row.status !== "active") return null;
  if (ctx?.waitUntil) {
    ctx.waitUntil(
      env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?")
        .bind(nowIso(), row.key_id)
        .run()
        .catch(() => {}),
    );
  }
  return row;
}
