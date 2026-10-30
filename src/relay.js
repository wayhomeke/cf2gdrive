/**
 * 文件中转 (file relay) — v1.26.
 *
 * A feature that is deliberately unrelated to the gallery: its own table, its
 * own page (/files), its own URL prefix (/f/<id>), its own delete/trash and
 * (from v1.33) its own quota. Nothing here reads or writes `images`.
 *
 *   /<DRIVE_FOLDER_ID>/<user folder>/<8-char id>.<ext>     (v1.27 layout)
 *   /f/<autoincrement id>                                  (public URL)
 *
 * v1.26 only accepts the same raster image types as the gallery. Opening the
 * type whitelist to arbitrary files needs `Content-Disposition: attachment`
 * on every non-image response, which lands in v1.32 — until then a permissive
 * sniff would turn /f/<id> into an HTML/SVG execution surface.
 */
import { deleteFile, downloadFile, uploadFile } from "./drive.js";
import { detectImageType, sanitizeFilename } from "./images.js";
import { nowIso, securityHeaders } from "./http.js";
import { resolveUserFolder, userStoragePath } from "./folder.js";
import { newStorageName } from "./shard.js";
import { getSettingInt } from "./settings.js";

export class RelayError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "RelayError";
    this.status = status;
    this.code = code;
  }
}

export const RELAY_MAX_MB = 20;

const KNOWN_MIME = {
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  "7z": "application/x-7z-compressed",
  rar: "application/vnd.rar",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  json: "application/json",
  csv: "text/csv; charset=utf-8",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  apk: "application/vnd.android.package-archive",
  exe: "application/x-msdownload",
  dmg: "application/x-apple-diskimage",
};

/**
 * Detect file type for relay.
 * Distinguishes safe raster images (can serve inline) from arbitrary binaries
 * (which must be served with Content-Disposition: attachment to prevent XSS).
 */
export function detectRelayType(buffer, originalName = "") {
  // 1. Safe raster image check
  const imgSig = detectImageType(buffer);
  if (imgSig) {
    return {
      ext: imgSig.ext,
      mime: imgSig.mime,
      isImage: true,
      isInline: true,
    };
  }

  // 2. Arbitrary files: infer extension and MIME from filename
  const cleanName = String(originalName || "").trim().toLowerCase();
  const match = cleanName.match(/\.([a-z0-9]{1,8})$/);
  const ext = match ? match[1] : "bin";
  const mime = KNOWN_MIME[ext] || "application/octet-stream";

  return {
    ext,
    mime,
    isImage: false,
    isInline: false, // forces Content-Disposition: attachment
  };
}
const FETCH_TIMEOUT_MS = 12000;
const MAX_REDIRECTS = 3;
const PRIVATE_HOST_RE =
  /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.|0\.|::1$|fc00:|fe80:)/i;

function isPrivateHost(h) {
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan") || h.endsWith(".home.arpa")) {
    return true;
  }
  if (PRIVATE_HOST_RE.test(h)) return true;
  if (h.startsWith("::1") || h.startsWith("fe80:") || /^f[cd][0-9a-f]{2}:/.test(h)) return true;
  return false;
}

async function readCapped(body, maxBytes) {
  if (!body) throw new RelayError(502, "fetch_failed", "empty response body");
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new RelayError(413, "too_large", "remote file exceeds size limit");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out.buffer;
}

/**
 * Fetch a remote file over http/https with SSRF protection for relay upload.
 */
export async function fetchRemoteRelayFile(rawUrl, maxBytes) {
  let current;
  try {
    current = new URL(String(rawUrl || ""));
  } catch {
    throw new RelayError(400, "bad_url", "invalid url");
  }
  if (current.protocol !== "http:" && current.protocol !== "https:") {
    throw new RelayError(400, "bad_url", "only http/https urls are allowed");
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (isPrivateHost(current.hostname)) {
      throw new RelayError(400, "bad_url", "private or local addresses are blocked");
    }
    const resp = await fetch(current.toString(), {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "user-agent": "cf2gdrive/relay" },
    });
    if (resp.status >= 300 && resp.status < 400 && resp.headers.get("location")) {
      try {
        current = new URL(resp.headers.get("location"), current);
      } catch {
        throw new RelayError(400, "bad_url", "malformed redirect");
      }
      continue;
    }
    if (!resp.ok) {
      throw new RelayError(502, "fetch_failed", `upstream returned HTTP ${resp.status}`);
    }
    const buffer = await readCapped(resp.body, maxBytes);
    const name = decodeURIComponent(current.pathname.split("/").pop() || "") || "relay-file";
    return { buffer, name };
  }
  throw new RelayError(502, "fetch_failed", "too many redirects");
}

/**
 * Upload one relay file.
 * @param env Worker env
 * @param user authenticated user row
 * @param input {buffer: ArrayBuffer, originalName: string, visibility?: 'private'|'public'}
 * @returns relay row with { url }
 */
export async function uploadRelayFile(env, user, input) {
  // v2.28.0: the cap is now tunable (env > D1 setting > built-in default).
  const cfgMb = await getSettingInt(env, "relay_max_mb", 1, 200).catch(() => 0);
  const maxBytes = (Number(env.RELAY_MAX_MB) || cfgMb || RELAY_MAX_MB) * 1024 * 1024;
  if (!input.buffer || input.buffer.byteLength === 0) {
    throw new RelayError(400, "empty_file", "empty file");
  }
  if (input.buffer.byteLength > maxBytes) {
    throw new RelayError(413, "too_large", `file exceeds ${maxBytes} bytes`);
  }

  const typeInfo = detectRelayType(input.buffer, input.originalName);

  // v1.33: Dedicated relay quota (completely independent from the gallery's quota).
  const currentRelayUsed = Number(user.relay_used_bytes || 0);
  const currentRelayQuota = Number(user.relay_quota_bytes || 2147483648);
  if (currentRelayUsed + input.buffer.byteLength > currentRelayQuota) {
    throw new RelayError(413, "quota_exceeded", "relay storage quota exceeded");
  }

  const visibility = input.visibility === "public" ? "public" : "private";
  const originalName = sanitizeFilename(input.originalName || `file.${typeInfo.ext}`);

  const folder = await resolveUserFolder(env, user.id, user.email);
  const storageName = newStorageName(typeInfo.ext);
  const path = userStoragePath(folder.folder, storageName);

  // v2.13.0: digest the exact bytes we are about to store. This becomes the
  // authoritative checksum clients can verify a download against.
  const sha256 = await sha256Hex(input.buffer);

  // v2.18.0: when the client declares a checksum, verify the received bytes
  // before spending a Drive upload on them. A mismatch means the transfer was
  // corrupted in flight, so reject instead of persisting unusable data.
  if (input.clientSha256) {
    const declared = String(input.clientSha256)
      .trim()
      .toLowerCase()
      .replace(/^sha256:/, "");
    if (declared && declared !== sha256) {
      throw new RelayError(
        409,
        "checksum_mismatch",
        "uploaded bytes do not match the declared checksum",
      );
    }
  }

  let meta = null;
  try {
    meta = await uploadFile(env, {
      name: storageName,
      mime: typeInfo.mime,
      bytes: new Uint8Array(input.buffer),
      parents: [folder.driveFolderId],
    });

    const res = await env.DB.prepare(
      `INSERT INTO relay_files (user_id, drive_file_id, name, original_name, mime_type, size_bytes, visibility, folder, storage_path, content_sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        user.id,
        meta.id,
        storageName,
        originalName,
        typeInfo.mime,
        input.buffer.byteLength,
        visibility,
        folder.folder,
        path,
        sha256,
      )
      .run();

    await env.DB.prepare("UPDATE users SET relay_used_bytes = relay_used_bytes + ? WHERE id = ?")
      .bind(input.buffer.byteLength, user.id)
      .run();

    const row = await env.DB.prepare("SELECT * FROM relay_files WHERE id = ?")
      .bind(res.meta.last_row_id)
      .first();
    return { ...row, url: `/f/${row.id}` };
  } catch (e) {
    if (meta?.id) {
      try {
        await deleteFile(env, meta.id);
      } catch {
        // orphan cleanup is best-effort
      }
    }
    throw e;
  }
}

/** One relay file by id (no ownership check). */
export async function getRelayFile(env, id) {
  return env.DB.prepare("SELECT * FROM relay_files WHERE id = ?").bind(Number(id)).first();
}

/** Relay file owned by the acting user; deleted rows included when raw=true. */
export async function loadOwnRelayFile(env, userId, id, raw = false) {
  const row = await getRelayFile(env, id);
  if (!row || row.user_id !== userId) return null;
  if (!raw && row.deleted) return null;
  return row;
}

/** JSON shape returned by every relay endpoint. */
export function relayJson(row) {
  return {
    id: row.id,
    url: `/f/${row.id}`,
    name: row.original_name,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    visibility: row.visibility,
    views: row.views,
    folder: row.folder,
    storage_path: row.storage_path,
    created_at: row.created_at,
    deleted: row.deleted ? 1 : 0,
  };
}

/** Escape SQLite LIKE wildcard characters. */
function escapeLike(s) {
  return String(s || "").replace(/[%_\\]/g, "\\$&");
}

/** Paged listing for one user with search, sort, and visibility filter. */
export async function listRelayFiles(
  env,
  userId,
  { page = 1, perPage = 24, filter = "live", q = "", sort = "created_desc", visibility = "all" } = {},
) {
  const safePage = Math.max(1, Number(page) || 1);
  const safePer = Math.min(100, Math.max(1, Number(perPage) || 24));
  const where = ["user_id = ?", filter === "trash" ? "deleted = 1" : "deleted = 0"];
  const binds = [userId];

  if (visibility === "public" || visibility === "private") {
    where.push("visibility = ?");
    binds.push(visibility);
  }

  if (q && q.trim()) {
    where.push("original_name LIKE ? ESCAPE '\\'");
    binds.push(`%${escapeLike(q.trim().slice(0, 100))}%`);
  }

  let order = "id DESC";
  switch (sort) {
    case "created_asc":
      order = "id ASC";
      break;
    case "size_desc":
      order = "size_bytes DESC, id DESC";
      break;
    case "size_asc":
      order = "size_bytes ASC, id ASC";
      break;
    case "views_desc":
      order = "views DESC, id DESC";
      break;
    default:
      order = "id DESC";
  }

  const clause = `WHERE ${where.join(" AND ")}`;
  const totalRow = await env.DB.prepare(`SELECT COUNT(*) c FROM relay_files ${clause}`)
    .bind(...binds)
    .first();
  const total = totalRow?.c || 0;
  const totalPages = Math.max(1, Math.ceil(total / safePer));
  const safePageClamped = Math.min(safePage, totalPages);
  const { results } = await env.DB.prepare(
    `SELECT * FROM relay_files ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`,
  )
    .bind(...binds, safePer, (safePageClamped - 1) * safePer)
    .all();
  return { rows: results || [], page: safePageClamped, perPage: safePer, totalPages, total };
}

/** Soft delete: moves the row to the relay trash and credits the relay quota. */
export async function softDeleteRelayFile(env, user, row) {
  await env.DB.prepare("UPDATE relay_files SET deleted = 1, deleted_at = ? WHERE id = ?")
    .bind(nowIso(), row.id)
    .run();
  await env.DB.prepare("UPDATE users SET relay_used_bytes = MAX(0, relay_used_bytes - ?) WHERE id = ?")
    .bind(row.size_bytes, user.id)
    .run();
}

/** Restore from the relay trash, re-checking the relay quota first. */
export async function restoreRelayFile(env, user, row) {
  const currentRelayUsed = Number(user.relay_used_bytes || 0);
  const currentRelayQuota = Number(user.relay_quota_bytes || 2147483648);
  if (currentRelayUsed + row.size_bytes > currentRelayQuota) {
    throw new RelayError(413, "quota_exceeded", "restore would exceed the relay storage quota");
  }
  await env.DB.prepare("UPDATE relay_files SET deleted = 0, deleted_at = NULL WHERE id = ?")
    .bind(row.id)
    .run();
  await env.DB.prepare("UPDATE users SET relay_used_bytes = relay_used_bytes + ? WHERE id = ?")
    .bind(row.size_bytes, user.id)
    .run();
}

/** Permanent delete: Drive object + row. */
export async function purgeRelayFile(env, row) {
  try {
    await deleteFile(env, row.drive_file_id);
  } catch {
    // a missing Drive object must not block metadata cleanup
  }
  await env.DB.prepare("DELETE FROM relay_files WHERE id = ?").bind(row.id).run();
}

/** Rename (display name only; the stored Drive name is untouched). */
export async function renameRelayFile(env, row, rawName) {
  const name = String(rawName || "").trim();
  if (!name || name.length > 120) throw new RelayError(400, "bad_name", "name must be 1..120 chars");
  const safe = name.replace(/[\x00-\x1f\x7f]/g, "").replace(/[\\/]/g, "_").slice(0, 120);
  await env.DB.prepare("UPDATE relay_files SET original_name = ? WHERE id = ?")
    .bind(safe, row.id)
    .run();
  return safe;
}

/**
 * Serve a relay file at /f/<id>.
 * Ownership gate mirrors serve.js: deleted -> 410, private -> 403, public ->
 * cacheable. Counts a view per successful anonymous/public hit.
 */
/** Hex SHA-256 of the given bytes — the integrity anchor for relay payloads. */
export async function sha256Hex(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Parse a single-range `bytes=` header against a known payload size.
 * Returns {start, end} inclusive, or null when the range is absent/invalid.
 * v2.12.0: clients can then be told 416 instead of silently getting a full body.
 */
export function parseRangeHeader(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return null;
  const first = m[1];
  const last = m[2];
  if (first === "" && last === "") return null;
  let start;
  let end;
  if (first === "") {
    const suffix = Number(last);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(first);
    end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return null;
  return { start, end };
}

/** Format RFC 5987 / RFC 6266 Content-Disposition header with UTF-8 fallback. */
export function formatContentDisposition(type, filename) {
  const safeAscii = (filename || "file").replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "");
  const encoded = encodeURIComponent(filename || "file").replace(/['()]/g, escape).replace(/\*/g, "%2A");
  return `${type}; filename="${safeAscii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Serve a relay file at /f/<id>.
 * Ownership gate mirrors serve.js: deleted -> 410, private -> 403, public ->
 * cacheable. Counts a view per successful anonymous/public hit.
 */
export async function serveRelayFile(env, row, request, sessionUserId, ctx) {
  const { Response } = globalThis;
  const deny = (status, body) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...securityHeaders() },
    });

  if (!row) return deny(404, { error: "not_found" });
  if (row.deleted) return deny(410, "gone");
  if (row.visibility !== "public" && row.user_id !== sessionUserId) {
    return deny(403, { error: "forbidden" });
  }

  const url = new URL(request.url);
  const forceDownload = url.searchParams.get("download") === "1";

  const etag = `W/"f${row.id}-${row.size_bytes}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag, ...securityHeaders() } });
  }

  const rangeHeader = request.headers.get("range");

  // v2.12.0: reject unsatisfiable ranges explicitly instead of falling back to a
  // full 200 body, so broken downloaders stop retrying the whole file.
  if (rangeHeader && !parseRangeHeader(rangeHeader, row.size_bytes)) {
    const h = new Headers(securityHeaders());
    h.set("content-range", `bytes */${row.size_bytes}`);
    h.set("content-type", "application/json");
    return new Response(JSON.stringify({ error: "range_not_satisfiable" }), {
      status: 416,
      headers: h,
    });
  }

  const upstream = await downloadFile(env, row.drive_file_id, rangeHeader);
  if (upstream.status === 404) return deny(404, { error: "not_found" });

  // v2.11.0 (hardened): Cloudflare strips Content-Length from opaque streams,
  // which is precisely why truncated downloads used to look complete.
  const BUFFER_LIMIT = 32 * 1024 * 1024;
  let payload = null;
  if (!rangeHeader && row.size_bytes > 0 && row.size_bytes <= BUFFER_LIMIT) {
    payload = await upstream.arrayBuffer();
    if (payload.byteLength !== row.size_bytes) {
      return deny(502, {
        error: "upstream_incomplete",
        message: `stored file is ${payload.byteLength} bytes, expected ${row.size_bytes}`,
      });
    }
  }

  const headers = new Headers(upstream.headers);
  headers.set("content-type", row.mime_type || "application/octet-stream");
  headers.set("etag", etag);
  headers.set("x-content-type-options", "nosniff");
  headers.set("accept-ranges", "bytes");

  // v2.14.0: expose the stored digest so a client can cheaply verify a download
  // (HEAD first, then compare) without re-hashing server-side on every read.
  if (row.content_sha256) {
    headers.set("x-checksum-sha256", `sha256:${row.content_sha256}`);
  }

  // v2.11.0: advertise the exact payload length for full responses. Without it a
  // truncated transfer looks like a complete one to the client (curl and browsers
  // both accept the short body silently). Range responses keep their own headers.
  if (payload) {
    headers.set("content-length", String(payload.byteLength));
  } else if (!rangeHeader && row.size_bytes > 0) {
    headers.set("content-length", String(row.size_bytes));
  }

  const isSafeRaster = !forceDownload && /^(image\/(jpeg|png|gif|webp|avif))$/i.test(row.mime_type);
  if (isSafeRaster) {
    headers.set("content-disposition", "inline");
  } else {
    headers.set("content-disposition", formatContentDisposition("attachment", row.original_name));
  }

  headers.set(
    "cache-control",
    row.visibility === "public" ? "public, max-age=86400" : "private, no-store",
  );
  for (const [k, v] of Object.entries(securityHeaders())) headers.set(k, v);

  if (ctx?.waitUntil && row.visibility === "public") {
    ctx.waitUntil(
      env.DB.prepare("UPDATE relay_files SET views = views + 1 WHERE id = ?").bind(row.id).run(),
    );
  }
  return new Response(payload ?? upstream.body, { status: upstream.status, headers });
}

/* ---------------- relay share links (v1.31) ---------------- */

const TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const TOKEN_LEN = 22;

function generateRelayToken() {
  const arr = new Uint8Array(TOKEN_LEN);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => TOKEN_ALPHABET[b & 63]).join("");
}

export async function createRelayShare(env, userId, fileId, days = 7) {
  const token = generateRelayToken();
  const expiresAt = days === 0 ? null : new Date(Date.now() + days * 86400000).toISOString();
  const res = await env.DB.prepare(
    `INSERT INTO relay_shares (relay_file_id, token, created_by, expires_at)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(fileId, token, userId, expiresAt)
    .run();
  return {
    id: res.meta.last_row_id,
    token,
    url: `/f/s/${token}`,
    expires_at: expiresAt,
  };
}

export async function listRelayShares(env, fileId) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM relay_shares WHERE relay_file_id = ? AND revoked = 0 ORDER BY id DESC",
  )
    .bind(fileId)
    .all();
  return (results || []).map((r) => ({
    id: r.id,
    token: r.token,
    url: `/f/s/${r.token}`,
    expires_at: r.expires_at,
    views: r.views,
    created_at: r.created_at,
  }));
}

export async function revokeRelayShare(env, userId, shareId) {
  const row = await env.DB.prepare("SELECT * FROM relay_shares WHERE id = ?").bind(Number(shareId)).first();
  if (!row || row.created_by !== userId) return false;
  await env.DB.prepare("UPDATE relay_shares SET revoked = 1 WHERE id = ?").bind(Number(shareId)).run();
  return true;
}

export async function resolveRelayShare(env, token) {
  const row = await env.DB.prepare(
    `SELECT rs.*, rf.drive_file_id, rf.mime_type, rf.size_bytes, rf.deleted, rf.original_name
       FROM relay_shares rs
       JOIN relay_files rf ON rf.id = rs.relay_file_id
      WHERE rs.token = ?`,
  )
    .bind(token)
    .first();
  if (!row) return { error: 404, message: "not_found" };
  if (row.revoked) return { error: 410, message: "revoked" };
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    return { error: 410, message: "expired" };
  }
  if (row.deleted) return { error: 410, message: "file_deleted" };
  return { row };
}

/**
 * v2.22.0: expire abandoned chunked-upload sessions. Without this, a client that
 * walks away mid-upload leaves both a D1 row and a live Drive session behind.
 */
export async function sweepRelayUploadSessions(env, maxAgeHours = 24) {
  const cutoff = `-${Math.max(1, Number(maxAgeHours) || 24)} hours`;
  const rows = await env.DB.prepare(
    `SELECT id, upload_uri FROM relay_upload_sessions
      WHERE status = 'active' AND updated_at < datetime('now', ?)`,
  )
    .bind(cutoff)
    .all();

  let removed = 0;
  for (const row of rows?.results || []) {
    // Best effort: tell Drive the session is done so it releases resources.
    try {
      await fetch(row.upload_uri, { method: "DELETE", headers: { "content-length": "0" } });
    } catch {
      // Drive may already have dropped it; the row still needs expiring.
    }
    await env.DB.prepare(
      "UPDATE relay_upload_sessions SET status = 'expired', updated_at = datetime('now') WHERE id = ?",
    )
      .bind(row.id)
      .run();
    removed++;
  }
  return removed;
}

/* ---------------- relay scheduled maintenance (v1.35) ---------------- */

/** Automatically purge expired trash files from the relay. */
export async function sweepRelayTrash(env, retentionDays = 30) {
  if (retentionDays === 0) return 0;
  const modifier = `-${retentionDays} days`;
  const { results } = await env.DB.prepare(
    "SELECT id, drive_file_id FROM relay_files WHERE deleted = 1 AND deleted_at < datetime('now', ?) LIMIT 100",
  )
    .bind(modifier)
    .all();
  const rows = results || [];
  let purged = 0;
  for (const row of rows) {
    try {
      await deleteFile(env, row.drive_file_id);
    } catch {
      // Drive delete best-effort
    }
    await env.DB.prepare("DELETE FROM relay_files WHERE id = ?").bind(row.id).run();
    purged++;
  }
  return purged;
}

/** Clean up expired share tokens. */
export async function sweepExpiredRelayShares(env) {
  const res = await env.DB.prepare(
    "DELETE FROM relay_shares WHERE expires_at IS NOT NULL AND expires_at < datetime('now')",
  ).run();
  return res.meta?.changes || 0;
}
