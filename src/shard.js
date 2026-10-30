/**
 * Sharded Drive storage layout (v1.24).
 *
 *   /<DRIVE_FOLDER_ID>/<md5(email)[0..4]>/<bucket 1..255>/<8-char id>.<ext>
 *
 * - level 1 = first 4 hex chars of md5(user email); 4 nibbles = 65536 buckets
 * - level 2 = numeric shard 1..255, filled sequentially, hard cap of
 *   MAX_FILES_PER_DIR live files per directory
 * - file name = 8 random chars + the format extension
 *
 * Counters live in D1 (`storage_dirs`) instead of being derived from Drive
 * listings: picking a directory must not cost a Drive round trip, and the
 * 255-file cap has to be enforced atomically under concurrent uploads.
 */
import { md5Hex } from "./md5.js";
import { createFolder, findFolder, getDriveConfig } from "./drive.js";

export const MAX_FILES_PER_DIR = 255;
export const MAX_DIRS = 255;
export const ID_LEN = 8;

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export class StorageError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "StorageError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Level-1 directory name: first 4 chars of md5(email).
 * Email is the stable unique identity (display names are not unique and can
 * be edited), so the shard never moves once a user's files are in place.
 */
export function ownerPrefix(email) {
  const norm = String(email || "").trim().toLowerCase();
  return md5Hex(norm).slice(0, 4);
}

/** 8-char storage file name, optionally with an extension. */
export function newStorageName(ext) {
  const arr = new Uint8Array(ID_LEN);
  crypto.getRandomValues(arr);
  let s = "";
  for (let i = 0; i < arr.length; i++) s += ID_ALPHABET[arr[i] % ID_ALPHABET.length];
  return ext ? `${s}.${ext}` : s;
}

/** Logical path stored next to every image row (diagnostics + admin display). */
export function storagePath(prefix, bucket, name) {
  return `${prefix}/${bucket}/${name}`;
}

/**
 * Reserve one slot in the user's current shard, creating folders and new
 * shards on demand. Returns { dirId, prefix, bucket, folderId, count }.
 * The caller MUST call releaseStorageDir() if the upload does not land.
 */
export async function resolveStorageDir(env, prefix) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const dir = await env.DB.prepare(
      `SELECT id, bucket, drive_folder_id FROM storage_dirs
        WHERE owner_key = ? AND file_count < ?
        ORDER BY bucket LIMIT 1`,
    )
      .bind(prefix, MAX_FILES_PER_DIR)
      .first();

    if (!dir) {
      const row = await env.DB.prepare(
        "SELECT COALESCE(MAX(bucket), 0) + 1 AS b FROM storage_dirs WHERE owner_key = ?",
      )
        .bind(prefix)
        .first();
      const bucket = Number(row?.b || 1);
      if (bucket > MAX_DIRS) {
        throw new StorageError(507, "storage_full", `all ${MAX_DIRS} shards for prefix ${prefix} are full`);
      }
      // Inherit the level-1 folder id if a sibling shard already resolved it.
      await env.DB.prepare(
        `INSERT OR IGNORE INTO storage_dirs (owner_key, bucket, file_count, root_folder_id)
         VALUES (?, ?, 0, (SELECT root_folder_id FROM storage_dirs
                            WHERE owner_key = ? AND root_folder_id IS NOT NULL LIMIT 1))`,
      )
        .bind(prefix, bucket, prefix)
        .run();
      continue; // re-select: another isolate may have created the row instead
    }

    // Atomic reservation — RETURNING is empty when the shard just filled up.
    const reserved = await env.DB.prepare(
      "UPDATE storage_dirs SET file_count = file_count + 1 WHERE id = ? AND file_count < ? RETURNING file_count",
    )
      .bind(dir.id, MAX_FILES_PER_DIR)
      .first();
    if (!reserved) continue;

    let folderId;
    try {
      folderId = await ensureBucketFolder(env, prefix, dir.bucket, dir.drive_folder_id, dir.id);
    } catch (e) {
      await releaseStorageDir(env, dir.id);
      throw e;
    }
    return { dirId: dir.id, prefix, bucket: dir.bucket, folderId, count: Number(reserved.file_count) };
  }
  throw new StorageError(503, "storage_busy", "could not reserve a storage directory, retry");
}

/** Give a reserved slot back (failed upload, failed insert, purge). */
export async function releaseStorageDir(env, dirId) {
  if (!dirId) return;
  await env.DB.prepare(
    "UPDATE storage_dirs SET file_count = CASE WHEN file_count > 0 THEN file_count - 1 ELSE 0 END WHERE id = ?",
  )
    .bind(dirId)
    .run();
}

/** Resolve (and cache) the level-1 folder for a prefix. */
async function ensureRootFolder(env, prefix) {
  const row = await env.DB.prepare(
    "SELECT root_folder_id FROM storage_dirs WHERE owner_key = ? AND root_folder_id IS NOT NULL LIMIT 1",
  )
    .bind(prefix)
    .first();
  if (row?.root_folder_id) return row.root_folder_id;

  const cfg = await getDriveConfig(env);
  const root = cfg.folderId;
  if (!root) throw new Error("Storage root folder is not configured");

  let id = await findFolder(env, prefix, root);
  if (!id) id = await createFolder(env, prefix, root);
  await env.DB.prepare("UPDATE storage_dirs SET root_folder_id = ? WHERE owner_key = ?").bind(id, prefix).run();
  return id;
}

/** Resolve (create on first use) the numeric shard folder under a prefix. */
async function ensureBucketFolder(env, prefix, bucket, knownId, dirId) {
  if (knownId) return knownId;
  const root = await ensureRootFolder(env, prefix);
  const name = String(bucket);
  let id = await findFolder(env, name, root);
  if (!id) id = await createFolder(env, name, root);
  await env.DB.prepare("UPDATE storage_dirs SET drive_folder_id = ?, root_folder_id = ? WHERE id = ?")
    .bind(id, root, dirId)
    .run();
  return id;
}

/** Recompute every counter from the images table (admin repair action). */
export async function recountStorageDirs(env) {
  const res = await env.DB.prepare(
    "UPDATE storage_dirs SET file_count = (SELECT COUNT(*) FROM images WHERE images.dir_id = storage_dirs.id)",
  ).run();
  return Number(res.meta?.changes || 0);
}

export async function listStorageDirs(env, limit = 200) {
  const { results } = await env.DB.prepare(
    `SELECT id, owner_key, bucket, drive_folder_id, root_folder_id, file_count, created_at
       FROM storage_dirs ORDER BY owner_key, bucket LIMIT ?`,
  )
    .bind(limit)
    .all();
  return results || [];
}

export async function storageSummary(env) {
  const dirs = await env.DB.prepare(
    `SELECT COUNT(*) AS dirs,
            COALESCE(SUM(file_count), 0) AS files,
            COALESCE(MAX(bucket), 0) AS max_bucket,
            COALESCE(SUM(CASE WHEN file_count >= ? THEN 1 ELSE 0 END), 0) AS full_dirs
       FROM storage_dirs`,
  )
    .bind(MAX_FILES_PER_DIR)
    .first();
  const legacy = await env.DB.prepare("SELECT COUNT(*) AS c FROM images WHERE dir_id IS NULL").first();
  return {
    dirs: Number(dirs?.dirs || 0),
    files: Number(dirs?.files || 0),
    max_bucket: Number(dirs?.max_bucket || 0),
    full_dirs: Number(dirs?.full_dirs || 0),
    legacy: Number(legacy?.c || 0),
    capacity_per_user: MAX_DIRS * MAX_FILES_PER_DIR,
  };
}
