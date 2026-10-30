/** Invite codes (v1.2): registration is invite-only.
 *  Admins create and distribute codes; redemption is an atomic conditional
 *  UPDATE so concurrent registrations can't oversubscribe a single-use code. */

// Unambiguous alphabet (no I/O/0/1); 16 chars = 80 bits of entropy.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_CHARS = 16;

export class InviteError extends Error {
  constructor(code) {
    super(code);
    this.name = "InviteError";
    this.code = code; // invite_required | invalid_invite | invite_exhausted | invite_expired
  }
}

/** Canonical display form: XXXX-XXXX-XXXX-XXXX */
function formatCode(raw) {
  const groups = [];
  for (let i = 0; i < raw.length; i += 4) groups.push(raw.slice(i, i + 4));
  return groups.join("-");
}

export function generateCode() {
  const bytes = new Uint8Array(CODE_CHARS);
  crypto.getRandomValues(bytes);
  let raw = "";
  for (const b of bytes) raw += ALPHABET[b % ALPHABET.length];
  return formatCode(raw);
}

/** Normalize user input: uppercase, strip spaces/dashes, re-canonicalize. */
export function normalizeCode(input) {
  const raw = String(input || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (!raw) return "";
  if (raw.length !== CODE_CHARS) return raw; // let the lookup fail on wrong length
  return formatCode(raw);
}

/** Admin: create a code. Returns the canonical code string (shown once). */
export async function createInvite(env, adminId, { note = "", maxUses = 1, expiresInDays = null } = {}) {
  const uses = Math.min(100, Math.max(1, parseInt(maxUses, 10) || 1));
  let expiresAt = null;
  const days = parseInt(expiresInDays, 10);
  if (Number.isFinite(days) && days > 0) {
    expiresAt = new Date(Date.now() + Math.min(365, days) * 86400_000).toISOString();
  }
  const code = generateCode();
  await env.DB.prepare(
    `INSERT INTO invite_codes (code, created_by, note, max_uses, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(code, adminId, String(note || "").slice(0, 120), uses, expiresAt)
    .run();
  return { code, max_uses: uses, expires_at: expiresAt };
}

/** Prepared form of the invite listing, so callers can batch it with other queries. */
export function inviteListStatement(env, limit = 200) {
  return env.DB.prepare(
    `SELECT i.*, u.email AS creator_email
     FROM invite_codes i JOIN users u ON u.id = i.created_by
     ORDER BY i.id DESC LIMIT ?`,
  ).bind(Math.min(500, Math.max(1, parseInt(limit, 10) || 200)));
}

/** Admin: list all codes, newest first, with creator email. */
export async function listInvites(env, limit = 200) {
  const { results } = await inviteListStatement(env, limit).all();
  return results || [];
}

/** Admin: revoke a code (soft disable; row kept for audit). */
export async function revokeInvite(env, id) {
  const res = await env.DB.prepare("UPDATE invite_codes SET revoked = 1 WHERE id = ? AND revoked = 0")
    .bind(Number(id))
    .run();
  return (res.meta?.changes || 0) > 0;
}

/** Derive display status for a code row. */
export function inviteStatus(row) {
  if (row.revoked) return "revoked";
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return "expired";
  if (row.used_count >= row.max_uses) return "used_up";
  return "active";
}

/**
 * Atomically consume one use of a code and bind it to the new user.
 * Throws InviteError with a stable code on failure.
 */
export async function redeemInvite(env, code, userId) {
  const canonical = normalizeCode(code);
  if (!canonical) throw new InviteError("invite_required");

  const row = await env.DB.prepare("SELECT * FROM invite_codes WHERE code = ?")
    .bind(canonical)
    .first();
  if (!row) throw new InviteError("invalid_invite");
  if (row.revoked) throw new InviteError("invalid_invite");
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    throw new InviteError("invite_expired");
  }
  if (row.used_count >= row.max_uses) throw new InviteError("invite_exhausted");

  // Authoritative guard: only increments when still usable.
  const upd = await env.DB.prepare(
    `UPDATE invite_codes
       SET used_count = used_count + 1, used_at = datetime('now')
     WHERE code = ? AND revoked = 0 AND used_count < max_uses
       AND (expires_at IS NULL OR expires_at > datetime('now'))`,
  )
    .bind(canonical)
    .run();
  if ((upd.meta?.changes || 0) !== 1) {
    // Lost a race (or state changed between SELECT and UPDATE).
    throw new InviteError("invalid_invite");
  }
  await env.DB.prepare("UPDATE invite_codes SET used_by = ? WHERE code = ?")
    .bind(userId, canonical)
    .run();
}
