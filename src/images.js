/** Image upload pipeline: validation, quota, Drive storage, D1 metadata. */
import { deleteFile, uploadFile } from "./drive.js";
import { nowIso } from "./http.js";
import { extractExif } from "./exif.js";
import { newStorageName, ownerPrefix, releaseStorageDir, resolveStorageDir, storagePath } from "./shard.js";
import { newSlug } from "./util.js";

/** Allowed raster formats and their magic-byte signatures. */
function startsWithBytes(b, bytes, offset = 0) {
  if (b.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (b[offset + i] !== bytes[i]) return false;
  }
  return true;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const SIGNATURES = [
  { mime: "image/jpeg", ext: "jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/png", ext: "png", test: (b) => startsWithBytes(b, PNG_MAGIC) },
  { mime: "image/gif", ext: "gif", test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
  {
    mime: "image/webp",
    ext: "webp",
    test: (b) =>
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
  {
    mime: "image/avif",
    ext: "avif",
    test: (b) => {
      // ....ftypavif / ftypavis
      return (
        b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 &&
        ((b[8] === 0x61 && b[9] === 0x76 && b[10] === 0x69 && b[11] === 0x66) ||
          (b[8] === 0x61 && b[9] === 0x76 && b[10] === 0x69 && b[11] === 0x73))
      );
    },
  },
];

export function detectImageType(buffer) {
  const b = new Uint8Array(buffer);
  if (b.length < 12) return null;
  for (const sig of SIGNATURES) {
    if (sig.test(b)) return sig;
  }
  return null;
}

export function sanitizeFilename(name) {
  let s = String(name || "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[\\/]/g, "_")
    .replace(/\.\.+/g, ".")
    .trim();
  if (s.length > 120) s = s.slice(-120);
  if (!s || s === "." || s === "..") s = "image";
  return s;
}

export class UploadError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Full upload pipeline for one image.
 * @param env Worker env
 * @param user authenticated user row
 * @param input {buffer: ArrayBuffer, originalName: string, visibility?: 'private'|'public'}
 * @returns image row (id, url, ...)
 */
export async function uploadImage(env, user, input) {
  const maxBytes = (Number(env.MAX_UPLOAD_MB) || 20) * 1024 * 1024;
  if (!input.buffer || input.buffer.byteLength === 0) {
    throw new UploadError(400, "empty_file", "empty file");
  }
  if (input.buffer.byteLength > maxBytes) {
    throw new UploadError(413, "too_large", `file exceeds ${maxBytes} bytes`);
  }

  const sig = detectImageType(input.buffer);
  if (!sig) {
    throw new UploadError(415, "unsupported_type", "not an allowed image type (jpeg/png/gif/webp/avif)");
  }

  // Quota check before touching Drive.
  if (user.used_bytes + input.buffer.byteLength > user.quota_bytes) {
    throw new UploadError(413, "quota_exceeded", "user storage quota exceeded");
  }

  const visibility = input.visibility === "public" ? "public" : "private";
  const originalName = sanitizeFilename(input.originalName || `image.${sig.ext}`);

  // v1.12: best-effort EXIF/dimensions (never blocks the upload).
  let exifJson = null;
  try {
    const exif = extractExif(new Uint8Array(input.buffer), sig.mime);
    if (exif) exifJson = JSON.stringify(exif);
  } catch {
    // malformed metadata is not worth failing an upload over
  }

  // v1.24: sharded layout — <md5(email)[0..4]>/<1..255>/<8-char id>.<ext>
  const prefix = ownerPrefix(user.email);
  const dir = await resolveStorageDir(env, prefix);
  const storageName = newStorageName(sig.ext);
  const path = storagePath(prefix, dir.bucket, storageName);

  let meta = null;
  try {
    meta = await uploadFile(env, {
      name: storageName,
      mime: sig.mime,
      bytes: new Uint8Array(input.buffer),
      parents: [dir.folderId],
    });

    // v1.25: the opaque id that goes in every URL. 48 bit, so a clash is
    // vanishingly unlikely — but the unique index decides, and a clash just
    // means we draw again.
    let publicId = newSlug();
    let res = null;
    for (let attempt = 0; attempt < 3 && !res; attempt++) {
      try {
        res = await env.DB.prepare(
          `INSERT INTO images (public_id, user_id, drive_file_id, name, original_name, mime_type, size_bytes, visibility, exif, dir_id, storage_path)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            publicId,
            user.id,
            meta.id,
            storageName,
            originalName,
            sig.mime,
            input.buffer.byteLength,
            visibility,
            exifJson,
            dir.dirId,
            path,
          )
          .run();
      } catch (e) {
        if (!/UNIQUE/i.test(String(e.message))) throw e;
        publicId = newSlug();
      }
    }
    if (!res) throw new Error("could not allocate a unique public id");

    await env.DB.prepare("UPDATE users SET used_bytes = used_bytes + ? WHERE id = ?")
      .bind(input.buffer.byteLength, user.id)
      .run();

    const row = await env.DB.prepare("SELECT * FROM images WHERE id = ?")
      .bind(res.meta.last_row_id)
      .first();
    return { ...row, url: `/i/${row.public_id}` };
  } catch (e) {
    // No half-written state: drop the Drive object and give the slot back.
    if (meta?.id) {
      try {
        await deleteFile(env, meta.id);
      } catch {
        // orphan cleanup is best-effort
      }
    }
    await releaseStorageDir(env, dir.dirId);
    throw e;
  }
}

/** Re-read a user's quota fields (used_bytes may have changed). */
export async function refreshUser(env, userId) {
  return env.DB.prepare(
    "SELECT id, email, display_name, role, status, quota_bytes, used_bytes, created_at, last_login_at FROM users WHERE id = ?",
  )
    .bind(userId)
    .first();
}

export { nowIso };

/* ---------------- remote URL fetch (v1.9) ---------------- */

const PRIVATE_HOST_RE =
  /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 15_000;

/** Block loopback/private/link-local literals and well-known local names. */
function isPrivateHost(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan") || h.endsWith(".home.arpa")) {
    return true;
  }
  if (PRIVATE_HOST_RE.test(h)) return true;
  if (h.startsWith("::1") || h.startsWith("fe80:") || /^f[cd][0-9a-f]{2}:/.test(h)) return true;
  return false;
}

/** Read a response body with a hard cap; abort as soon as it is exceeded. */
async function readCapped(body, maxBytes) {
  if (!body) throw new UploadError(502, "fetch_failed", "empty response body");
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new UploadError(413, "too_large", "remote file exceeds size limit");
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
 * Fetch an image over http/https with SSRF guards: scheme allowlist,
 * private-address blocklist (re-checked per redirect hop), redirect cap,
 * timeout, and a hard size cap. Returns {buffer, name}.
 */
export async function fetchRemoteImage(rawUrl, maxBytes) {
  let current;
  try {
    current = new URL(String(rawUrl || ""));
  } catch {
    throw new UploadError(400, "bad_url", "invalid url");
  }
  if (current.protocol !== "http:" && current.protocol !== "https:") {
    throw new UploadError(400, "bad_url", "only http/https urls are allowed");
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (isPrivateHost(current.hostname)) {
      throw new UploadError(400, "bad_url", "private or local addresses are blocked");
    }
    const resp = await fetch(current.toString(), {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "user-agent": "cf2gdrive/1.35 (+https://images.example.com)" },
    });
    if (resp.status >= 300 && resp.status < 400 && resp.headers.get("location")) {
      try {
        current = new URL(resp.headers.get("location"), current);
      } catch {
        throw new UploadError(400, "bad_url", "malformed redirect");
      }
      continue;
    }
    if (!resp.ok) {
      throw new UploadError(502, "fetch_failed", `upstream returned HTTP ${resp.status}`);
    }
    const buffer = await readCapped(resp.body, maxBytes);
    const name = decodeURIComponent(current.pathname.split("/").pop() || "") || "remote-image";
    return { buffer, name };
  }
  throw new UploadError(502, "fetch_failed", "too many redirects");
}
