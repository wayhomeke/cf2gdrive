/** Share links (v1.13): time-limited tokens that grant read access to an
 *  image without making it public. Tokens are opaque, revocable, and may
 *  carry an expiry. Served by GET /s/<token>. */

const TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const TOKEN_LEN = 22;

/** URL-safe random token (128 bits of entropy). */
export function generateToken() {
  const arr = new Uint8Array(TOKEN_LEN);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => TOKEN_ALPHABET[b & 63]).join("");
}

/** Normalize a requested expiry: {days: n>=1} | {never: true} | null(invalid). */
export function parseExpiry(body) {
  if (body?.never === true) return { never: true };
  const d = Number(body?.expires_in_days);
  if (!Number.isInteger(d) || d < 1 || d > 3650) return null;
  return { days: d };
}

function expiryIso(expiry) {
  if (expiry.never) return null;
  return new Date(Date.now() + expiry.days * 86400000).toISOString();
}

/** Create a share link for an image the caller owns. */
export async function createShare(env, userId, imageId, expiry) {
  const token = generateToken();
  const expiresAt = expiryIso(expiry);
  const res = await env.DB.prepare(
    `INSERT INTO share_links (image_id, token, created_by, expires_at)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(imageId, token, userId, expiresAt)
    .run();
  const row = await env.DB.prepare("SELECT * FROM share_links WHERE id = ?")
    .bind(res.meta.last_row_id)
    .first();
  return row;
}

/** Active (non-revoked) shares for one image, newest first. */
export async function listSharesForImage(env, imageId) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM share_links WHERE image_id = ? AND revoked = 0 ORDER BY id DESC",
  )
    .bind(imageId)
    .all();
  return results || [];
}

/** All active shares of a user (joins image name for the management page). */
export async function listSharesForUser(env, userId) {
  const { results } = await env.DB.prepare(
    `SELECT s.*, i.public_id AS image_public_id, i.original_name, i.mime_type, i.size_bytes, i.deleted AS image_deleted
     FROM share_links s JOIN images i ON i.id = s.image_id
     WHERE s.created_by = ? AND s.revoked = 0
     ORDER BY s.id DESC LIMIT 200`,
  )
    .bind(userId)
    .all();
  return results || [];
}

/** Revoke a share the caller owns (by share id). Returns false when missing. */
export async function revokeShare(env, userId, shareId) {
  const row = await env.DB.prepare("SELECT * FROM share_links WHERE id = ?")
    .bind(Number(shareId))
    .first();
  if (!row || row.created_by !== userId || row.revoked) return false;
  await env.DB.prepare("UPDATE share_links SET revoked = 1 WHERE id = ?")
    .bind(row.id)
    .run();
  return true;
}

/**
 * Resolve a token to {share, image} when it grants access right now.
 * Returns {error: 'not_found'|'expired'|'revoked'|'gone'} otherwise.
 */
export async function resolveShare(env, token) {
  const share = await env.DB.prepare("SELECT * FROM share_links WHERE token = ?")
    .bind(String(token || ""))
    .first();
  if (!share) return { error: "not_found" };
  if (share.revoked) return { error: "revoked" };
  if (share.expires_at && new Date(share.expires_at).getTime() <= Date.now()) {
    return { error: "expired" };
  }
  const image = await env.DB.prepare("SELECT * FROM images WHERE id = ?")
    .bind(share.image_id)
    .first();
  if (!image || image.deleted) return { error: "gone" };
  return { share, image };
}

/** Human-readable remaining time for a share row. */
export function shareExpiryText(share) {
  if (!share.expires_at) return "永久有效";
  const ms = new Date(share.expires_at).getTime() - Date.now();
  if (ms <= 0) return "已过期";
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  if (d >= 1) return `${d} 天${h ? ` ${h} 小时` : ""}后过期`;
  return `${h} 小时后过期`;
}
