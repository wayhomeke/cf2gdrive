/**
 * Dev helper for test-storage.sh: move one Drive file back into the root
 * folder, i.e. recreate the pre-v1.24 flat layout, so the admin migration
 * action can be exercised against a genuinely legacy file.
 *
 *   node tests/mk-legacy.mjs <driveFileId>
 *
 * Needs outbound HTTPS (the sandbox routes it through https_proxy) and explicit Google OAuth
 * credentials plus DRIVE_FOLDER_ID in environment variables.
 */
import * as drive from "../src/drive.js";

const env = process.env;
for (const name of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "DRIVE_FOLDER_ID"]) {
  if (!env[name]) throw new Error(`Missing required environment variable: ${name}`);
}
const root = env.DRIVE_FOLDER_ID;
const fileId = process.argv[2];
if (!fileId || !root) {
  console.error("usage: node tests/mk-legacy.mjs <driveFileId>");
  process.exit(2);
}

const meta = await drive.getFileMeta(env, fileId);
const parents = (meta.parents || []).filter((p) => p !== root);
await drive.moveFile(env, fileId, {
  addParents: root,
  removeParents: parents.join(","),
});
console.log(`legacy: ${fileId} -> root (was ${parents.join(",") || "root"})`);
