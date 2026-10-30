/** Authentication: register / login / logout / session middleware.
 *  Sessions are opaque random tokens; only SHA-256 hashes hit D1. */
import {
  hashPassword,
  randomToken,
  sha256Hex,
  verifyPassword,
} from "./crypto.js";
import {
  clearSessionCookie,
  getClientIp,
  isValidEmail,
  json,
  nowIso,
  parseCookies,
  sessionCookie,
} from "./http.js";
import { InviteError, redeemInvite } from "./invites.js";
import { getSettingBytes } from "./settings.js";

export const SESSION_COOKIE = "picbed_session";
const SESSION_TTL_SECONDS = 30 * 24 * 3600; // 30 days
const MIN_PASSWORD_LEN = 8;

function publicUser(u) {
  if (!u) return null;
  const {
    password_hash,
    password_salt,
    ...rest
  } = u;
  return rest;
}

export async function register(env, { email, password, displayName, inviteCode }) {
  if (!isValidEmail(email)) return { error: "invalid_email" };
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LEN) {
    return { error: "password_too_short", min: MIN_PASSWORD_LEN };
  }
  email = String(email).toLowerCase().trim();
  const name = String(displayName || "").trim().slice(0, 60) || email.split("@")[0];

  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
    .bind(email)
    .first();
  if (existing) return { error: "email_taken" };

  // v2.37.0: bootstrap self-healing. If the system has 0 registered users,
  // the first registrant automatically becomes an admin and does NOT require an invite code.
  const userCountRow = await env.DB.prepare("SELECT COUNT(*) AS c FROM users").first();
  const isFirstUser = Number(userCountRow?.c || 0) === 0;

  const admins = (env.ADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const role = isFirstUser || admins.includes(email) ? "admin" : "user";

  const salt = randomToken(16);
  const hash = await hashPassword(password, salt);
  // Per-user quota at registration = global default (v1.4; admins can tune
  // it per user afterwards; existing users keep their current quota).
  const quota = await getSettingBytes(env, "default_quota_bytes");
  const res = await env.DB.prepare(
    `INSERT INTO users (email, password_hash, password_salt, display_name, role, quota_bytes)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(email, hash, salt, name, role, quota)
    .run();
  const userId = res.meta.last_row_id;

  // Invite-only registration (v1.2): consume the code after the user row
  // exists; if the code is unusable, compensate by removing the new user.
  // v2.37.0: first user is exempt from invite code.
  if (!isFirstUser) {
    try {
      await redeemInvite(env, inviteCode, userId);
    } catch (e) {
      if (e instanceof InviteError) {
        await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
        return { error: e.code };
      }
      throw e;
    }
  }

  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(userId)
    .first();
  return { user: publicUser(user) };
}

export async function login(env, { email, password, request }) {
  if (!isValidEmail(email)) return { error: "invalid_credentials" };
  email = String(email).toLowerCase().trim();
  const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?")
    .bind(email)
    .first();
  // Same error either way: no user enumeration.
  if (!user || user.status !== "active") return { error: "invalid_credentials" };
  const ok = await verifyPassword(String(password || ""), user.password_salt, user.password_hash);
  if (!ok) return { error: "invalid_credentials" };

  await env.DB.prepare("UPDATE users SET last_login_at = ? WHERE id = ?")
    .bind(nowIso(), user.id)
    .run();

  const token = await createSession(env, user.id, request);
  return { user: publicUser(user), token };
}

export async function createSession(env, userId, request) {
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO sessions (user_id, token_hash, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      userId,
      tokenHash,
      expiresAt,
      getClientIp(request),
      (request.headers.get("user-agent") || "").slice(0, 300),
    )
    .run();
  return token;
}

export async function getSessionUser(env, request) {
  const cookies = parseCookies(request);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT s.id AS session_id, s.expires_at,
            u.id, u.email, u.display_name, u.role, u.status,
            u.quota_bytes, u.used_bytes, u.created_at, u.last_login_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?`,
  )
    .bind(tokenHash)
    .first();
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
    return null;
  }
  if (row.status !== "active") return null;

  // Sliding renewal + touch.
  const fresh = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  await env.DB.prepare(
    "UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE token_hash = ?",
  )
    .bind(fresh, nowIso(), tokenHash)
    .run();

  return row;
}

export async function logout(env, request) {
  const cookies = parseCookies(request);
  const token = cookies[SESSION_COOKIE];
  if (token) {
    const tokenHash = await sha256Hex(token);
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
  }
}

export function withSessionCookie(response, token) {
  const headers = new Headers(response.headers);
  headers.append("set-cookie", sessionCookie(token, SESSION_TTL_SECONDS));
  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

export function withoutSessionCookie(response) {
  const headers = new Headers(response.headers);
  headers.append("set-cookie", clearSessionCookie());
  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

/** Fixed-window rate limiter over D1. Returns {allowed, retryAfter}. */
export async function rateLimit(env, bucket, limit, windowSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSeconds);
  const key = `${bucket}:${windowStart}`;
  await env.DB.prepare(
    `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT (bucket, window_start) DO UPDATE SET count = count + 1`,
  )
    .bind(key, windowStart)
    .run();
  const row = await env.DB.prepare(
    "SELECT count FROM rate_limits WHERE bucket = ? AND window_start = ?",
  )
    .bind(key, windowStart)
    .first();
  const count = row?.count || 0;
  if (count > limit) {
    return { allowed: false, retryAfter: windowStart + windowSeconds - now };
  }
  return { allowed: true, remaining: Math.max(0, limit - count) };
}

/** JSON 401 helper. */
export function unauthorized(message = "authentication required") {
  return json({ error: "unauthorized", message }, 401);
}
