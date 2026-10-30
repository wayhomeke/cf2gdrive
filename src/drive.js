/**
 * Google Drive storage module for cf2gdrive.
 * Zero-dependency; runs on the Workers fetch API.
 *
 * Auth: OAuth2 refresh-token flow (the service account cannot upload —
 * it has zero storage quota). Token is cached per isolate.
 */

import { getSetting } from "./settings.js";
import { decryptSecret } from "./crypto_vault.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

/** Per-isolate access-token cache. */
let tokenCache = { token: null, expiresAt: 0 };

export class DriveError extends Error {
  constructor(op, status, detail) {
    super(`drive ${op} failed: HTTP ${status} ${detail}`);
    this.name = "DriveError";
    this.op = op;
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Retrieve decrypted Google Drive configuration from D1.
 * If credentials are not yet configured, returns ready: false.
 */
export async function getDriveConfig(env) {
  const clientId = (await getSetting(env, "gdrive_client_id")) || env.GOOGLE_CLIENT_ID || "";
  const encSec = await getSetting(env, "gdrive_client_secret_enc");
  let clientSecret = "";
  if (encSec) {
    clientSecret = await decryptSecret(env.SESSION_SECRET, encSec);
  } else if (env.GOOGLE_CLIENT_SECRET) {
    clientSecret = env.GOOGLE_CLIENT_SECRET;
  }

  const encTok = await getSetting(env, "gdrive_refresh_token_enc");
  let refreshToken = "";
  if (encTok) {
    refreshToken = await decryptSecret(env.SESSION_SECRET, encTok);
  } else if (env.GOOGLE_REFRESH_TOKEN) {
    refreshToken = env.GOOGLE_REFRESH_TOKEN;
  }

  const folderId = (await getSetting(env, "gdrive_folder_id")) || env.DRIVE_FOLDER_ID || "";
  const accountEmail = (await getSetting(env, "gdrive_account_email")) || "";
  // v2.39.0: scopes Google actually granted at consent time (space separated).
  const grantedScope = (await getSetting(env, "gdrive_granted_scope")) || "";

  const ready = Boolean(clientId && clientSecret && refreshToken && folderId);
  return {
    ready,
    clientId,
    clientSecret,
    refreshToken,
    folderId,
    accountEmail,
    grantedScope,
  };
}

/** Check if storage backend is configured and ready. */
export async function isStorageConfigured(env) {
  const cfg = await getDriveConfig(env);
  return cfg.ready;
}

async function parseGoogleError(resp) {
  let detail = "";
  try {
    const j = await resp.json();
    detail = j.error?.message || JSON.stringify(j).slice(0, 300);
  } catch {
    detail = (await resp.text().catch(() => "")).slice(0, 300);
  }
  return detail;
}

export async function getAccessToken(env) {
  const now = Date.now();
  if (tokenCache.token && tokenCache.expiresAt - 60_000 > now) {
    return tokenCache.token;
  }

  const cfg = await getDriveConfig(env);
  if (!cfg.clientId || !cfg.clientSecret || !cfg.refreshToken) {
    throw new DriveError("unconfigured", 503, "Google Drive credentials not configured. Please visit /admin/storage to connect an account.");
  }

  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: cfg.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!resp.ok) {
    throw new DriveError("token", resp.status, await parseGoogleError(resp));
  }
  const j = await resp.json();
  tokenCache = {
    token: j.access_token,
    expiresAt: now + j.expires_in * 1000,
  };
  return j.access_token;
}

async function authHeaders(env) {
  return { authorization: `Bearer ${await getAccessToken(env)}` };
}

/**
 * Upload bytes via a resumable session (single-shot PUT).
 * Works for any size the runtime can buffer; images only in practice.
 * Returns Drive file metadata: { id, name, mimeType, size, parents, ... }
 */
export async function uploadFile(env, { name, mime, bytes, parents }) {
  const start = await fetch(
    `${UPLOAD_API}/files?uploadType=resumable&fields=id,name,mimeType,size,parents`,
    {
    method: "POST",
    headers: {
      ...(await authHeaders(env)),
      "content-type": "application/json; charset=UTF-8",
      "x-upload-content-type": mime,
      "x-upload-content-length": String(byteLength(bytes)),
    },
    body: JSON.stringify({ name, parents, mimeType: mime }),
  });
  if (!start.ok) {
    throw new DriveError("upload:start", start.status, await parseGoogleError(start));
  }
  const sessionUri = start.headers.get("location");
  if (!sessionUri) {
    throw new DriveError("upload:start", 0, "missing session location header");
  }

  const put = await fetch(sessionUri, {
    method: "PUT",
    headers: {
      "content-type": mime,
      "content-length": String(byteLength(bytes)),
    },
    body: bytes,
  });
  if (!put.ok) {
    throw new DriveError("upload:put", put.status, await parseGoogleError(put));
  }
  return put.json();
}

function byteLength(bytes) {
  if (bytes == null) return 0;
  if (typeof bytes === "string") return new TextEncoder().encode(bytes).length;
  if (bytes instanceof ArrayBuffer) return bytes.byteLength;
  if (ArrayBuffer.isView(bytes)) return bytes.byteLength;
  if (typeof bytes === "object" && "length" in bytes) return bytes.length;
  return 0;
}

/**
 * v2.19.0: open a Drive resumable session without sending any bytes yet, so the
 * caller can push chunks one at a time and resume after a broken connection.
 */
export async function startResumableUpload(env, { name, mime, size, parents }) {
  const start = await fetch(
    `${UPLOAD_API}/files?uploadType=resumable&fields=id,name,mimeType,size,parents`,
    {
      method: "POST",
      headers: {
        ...(await authHeaders(env)),
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-type": mime,
        "x-upload-content-length": String(size),
      },
      body: JSON.stringify({ name, parents, mimeType: mime }),
    },
  );
  if (!start.ok) {
    throw new DriveError("upload:start", start.status, await parseGoogleError(start));
  }
  const sessionUri = start.headers.get("location");
  if (!sessionUri) {
    throw new DriveError("upload:start", 0, "missing session location header");
  }
  return sessionUri;
}

/**
 * v2.19.0: push a single chunk of a resumable upload.
 * Drive answers 308 while incomplete (with a Range of what it holds) and the
 * final metadata once the last byte lands.
 */
export async function putResumableChunk(sessionUri, bytes, start, total) {
  const len = byteLength(bytes);
  const put = await fetch(sessionUri, {
    method: "PUT",
    headers: {
      "content-range": `bytes ${start}-${start + len - 1}/${total}`,
      "content-length": String(len),
    },
    body: bytes,
  });
  if (put.status === 308) {
    return { done: false, received: receivedFromRange(put.headers.get("range"), start) };
  }
  if (!put.ok) {
    throw new DriveError("upload:chunk", put.status, await parseGoogleError(put));
  }
  return { done: true, received: total, file: await put.json() };
}

/**
 * v2.21.0: ask Drive how much of an upload it already accepted. Sending an
 * unknown total is how a client recovers the offset after a dropped connection.
 */
export async function queryResumableStatus(sessionUri, total) {
  const res = await fetch(sessionUri, {
    method: "PUT",
    headers: { "content-range": `bytes */${total}` },
  });
  if (res.status === 308) {
    return { done: false, received: receivedFromRange(res.headers.get("range"), 0) };
  }
  if (!res.ok) {
    throw new DriveError("upload:status", res.status, await parseGoogleError(res));
  }
  return { done: true, received: total, file: await res.json() };
}

/** "bytes=0-1048575" -> 1048576 */
function receivedFromRange(rangeHeader, fallback) {
  const m = /bytes=\d*-(\d+)/.exec(rangeHeader || "");
  if (!m) return fallback;
  return Number(m[1]) + 1;
}

/** Fetch file bytes. Pass rangeHeader through for partial content. */
export async function downloadFile(env, fileId, rangeHeader) {
  const headers = await authHeaders(env);
  if (rangeHeader) headers.range = rangeHeader;
  return fetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`, {
    headers,
  });
}

/**
 * Server-side Drive thumbnail (v1.5). Drive renders the image; we only proxy.
 * `sz` is the max width in pixels (e.g. w400). Returns the raw upstream
 * Response (image/jpeg) or throws DriveError on failure.
 *
 * Note: the endpoint 302-redirects to lh3.googleusercontent.com, and the
 * fetch spec strips Authorization on cross-origin redirects — so we follow
 * the hop manually and re-attach the bearer (lh3 accepts it).
 */
export async function fetchThumbnail(env, fileId, sz = 400) {
  const auth = await authHeaders(env);
  const first = await fetch(
    `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w${sz}`,
    { headers: auth, redirect: "manual" },
  );
  const loc = first.headers.get("location");
  if (loc) {
    const second = await fetch(loc, { headers: auth, redirect: "manual" });
    if (second.ok) return second;
    throw new DriveError("thumbnail", second.status, "thumbnail render failed");
  }
  if (first.ok && (first.headers.get("content-type") || "").startsWith("image/")) {
    return first;
  }
  throw new DriveError("thumbnail", first.status, "no thumbnail");
}

/** Permanent delete. */
export async function deleteFile(env, fileId) {
  const resp = await fetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`, {
    method: "DELETE",
    headers: await authHeaders(env),
  });
  if (!resp.ok && resp.status !== 204) {
    throw new DriveError("delete", resp.status, await parseGoogleError(resp));
  }
  return true;
}

/** Rename a file (keeps content). */
export async function renameFile(env, fileId, newName) {
  const resp = await fetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`, {
    method: "PATCH",
    headers: {
      ...(await authHeaders(env)),
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: newName }),
  });
  if (!resp.ok) {
    throw new DriveError("rename", resp.status, await parseGoogleError(resp));
  }
  return resp.json();
}

/** Metadata only. */
export async function getFileMeta(env, fileId) {
  const resp = await fetch(
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size,parents,createdTime,trashed`,
    { headers: await authHeaders(env) },
  );
  if (!resp.ok) {
    throw new DriveError("meta", resp.status, await parseGoogleError(resp));
  }
  return resp.json();
}

/* ---------------- folders (v1.24 sharded layout) ---------------- */

const FOLDER_MIME = "application/vnd.google-apps.folder";

/** Drive query strings are single-quoted; backslash and quote must escape. */
function escapeQ(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** Look up a direct child folder by exact name. Returns its id or null. */
export async function findFolder(env, name, parentId) {
  const params = new URLSearchParams({
    q: `name = '${escapeQ(name)}' and mimeType = '${FOLDER_MIME}' and '${escapeQ(parentId)}' in parents and trashed = false`,
    fields: "files(id,name)",
    pageSize: "10",
    spaces: "drive",
  });
  const resp = await fetch(`${DRIVE_API}/files?${params}`, { headers: await authHeaders(env) });
  if (!resp.ok) {
    throw new DriveError("find-folder", resp.status, await parseGoogleError(resp));
  }
  const j = await resp.json();
  return j.files?.[0]?.id || null;
}

/** Create a folder under a parent. Returns its id. */
export async function createFolder(env, name, parentId) {
  const resp = await fetch(`${DRIVE_API}/files?fields=id,name`, {
    method: "POST",
    headers: { ...(await authHeaders(env)), "content-type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
  if (!resp.ok) {
    throw new DriveError("create-folder", resp.status, await parseGoogleError(resp));
  }
  const j = await resp.json();
  return j.id;
}

/**
 * Move a file to another folder and optionally rename it in the same PATCH
 * (used by the v1.24 legacy-file migration).
 */
export async function moveFile(env, fileId, { addParents, removeParents, name } = {}) {
  const params = new URLSearchParams({ fields: "id,name,parents" });
  if (addParents) params.set("addParents", addParents);
  if (removeParents) params.set("removeParents", removeParents);
  const body = {};
  if (name) body.name = name;
  const resp = await fetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?${params}`, {
    method: "PATCH",
    headers: { ...(await authHeaders(env)), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new DriveError("move", resp.status, await parseGoogleError(resp));
  }
  return resp.json();
}

/** List files inside the configured storage folder. */
export async function listFiles(env, folderId, pageSize = 100) {
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and trashed=false`,
    fields: "files(id,name,mimeType,size,createdTime)",
    pageSize: String(pageSize),
  });
  const resp = await fetch(`${DRIVE_API}/files?${params}`, {
    headers: await authHeaders(env),
  });
  if (!resp.ok) {
    throw new DriveError("list", resp.status, await parseGoogleError(resp));
  }
  const j = await resp.json();
  return j.files || [];
}

/** List all top-level folders in the user's My Drive. */
export async function listDriveFolders(env) {
  const params = new URLSearchParams({
    q: `mimeType = '${FOLDER_MIME}' and trashed = false and 'root' in parents`,
    fields: "files(id,name,modifiedTime)",
    pageSize: "50",
    orderBy: "name",
  });
  const resp = await fetch(`${DRIVE_API}/files?${params}`, { headers: await authHeaders(env) });
  if (!resp.ok) {
    throw new DriveError("list-folders", resp.status, await parseGoogleError(resp));
  }
  const j = await resp.json();
  return j.files || [];
}

/** Fetch user profile info (email) from Google OAuth2 using access token. */
export async function getDriveUserInfo(accessToken) {
  const resp = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) return null;
  const j = await resp.json();
  return {
    email: j.email || "",
    name: j.name || "",
    picture: j.picture || "",
  };
}
