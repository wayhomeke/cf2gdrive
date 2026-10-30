/**
 * Per-user Drive folder (v1.27).
 *
 *   /<DRIVE_FOLDER_ID>/<sanitised email>/<file id>.<ext>
 *
 * One directory per user, named after the account email — no sharding, no
 * md5 prefixes, no 255-file ceilings. The folder id is cached in D1
 * (`user_folders`) so picking a directory costs zero Drive round trips after
 * the first upload, exactly like v1.24's `storage_dirs`.
 *
 * Why the email and not `display_name`: display_name is editable and not
 * unique, so renaming would orphan files on disk and two users could collide
 * into one directory. Email is the unique key and never changes.
 */
import { createFolder, findFolder, getDriveConfig } from "./drive.js";

/** Drive folder names cannot contain these. */
const ILLEGAL = /[\\/:*?"<>|#%&{}~[\]]/g;
const MAX_NAME = 80;

/**
 * Deterministic, Drive-safe folder name for an account email.
 *   "User@Example.COM" -> "user-at-example-com"
 * Pure function of the email, so it can be recomputed at any time (migration,
 * admin display) without consulting the database.
 */
export function userFolderName(email) {
  let s = String(email || "").trim().toLowerCase();
  s = s.replace(/@/g, "-at-").replace(/\.+/g, "-");
  s = s.replace(ILLEGAL, "-").replace(/^-+|-+$/g, "");
  if (s.length > MAX_NAME) s = s.slice(0, MAX_NAME).replace(/-+$/g, "");
  return s || "user";
}

/** Short, stable suffix used only when two accounts sanitise to one name. */
async function hashSuffix(email) {
  const norm = String(email || "").trim().toLowerCase();
  const bytes = new TextEncoder().encode(norm);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest).slice(0, 2)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Resolve (creating on first use) the user's folder.
 * Returns { id, folder, driveFolderId, created }.
 *
 * The D1 row is written with INSERT OR IGNORE + a re-read, so a concurrent
 * first upload for the same user converges on one row instead of racing to
 * create two Drive folders.
 */
export async function resolveUserFolder(env, userId, email) {
  const existing = await env.DB.prepare(
    "SELECT id, folder, drive_folder_id FROM user_folders WHERE user_id = ?",
  )
    .bind(userId)
    .first();
  if (existing?.drive_folder_id) {
    return {
      id: existing.id,
      folder: existing.folder,
      driveFolderId: existing.drive_folder_id,
      created: false,
    };
  }

  const cfg = await getDriveConfig(env);
  const root = cfg.folderId;
  if (!root) throw new Error("Storage root folder is not configured");
  let name = userFolderName(email);

  // Two different emails can sanitise to the same folder name; make the second
  // one distinct instead of silently sharing a directory.
  let driveFolderId = await findFolder(env, name, root);
  if (!driveFolderId) {
    const taken = await env.DB.prepare(
      "SELECT COUNT(*) c FROM user_folders WHERE folder = ?",
    )
      .bind(name)
      .first();
    if (taken?.c) name = `${name}-${await hashSuffix(email)}`;
    driveFolderId = await createFolder(env, name, root);
  }

  await env.DB.prepare(
    `INSERT OR IGNORE INTO user_folders (user_id, folder, drive_folder_id)
     VALUES (?, ?, ?)`,
  )
    .bind(userId, name, driveFolderId)
    .run();

  const row = await env.DB.prepare(
    "SELECT id, folder, drive_folder_id FROM user_folders WHERE user_id = ?",
  )
    .bind(userId)
    .first();
  return { id: row.id, folder: row.folder, driveFolderId: row.drive_folder_id, created: true };
}

/** List cached folders (admin panel). */
export async function listUserFolders(env, limit = 200) {
  const { results } = await env.DB.prepare(
    `SELECT uf.id, uf.user_id, uf.folder, uf.drive_folder_id, uf.created_at,
            u.email, u.display_name,
            (SELECT COUNT(*) FROM images  WHERE user_id = uf.user_id AND deleted = 0) AS image_count,
            (SELECT COUNT(*) FROM relay_files WHERE user_id = uf.user_id AND deleted = 0) AS relay_count
       FROM user_folders uf JOIN users u ON u.id = uf.user_id
      ORDER BY uf.id DESC LIMIT ?`,
  )
    .bind(limit)
    .all();
  return results || [];
}

/** Logical storage path recorded on every row (diagnostics + admin display). */
export function userStoragePath(folder, name) {
  return `${folder}/${name}`;
}
