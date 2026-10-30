/**
 * v0.2 harness: exercise src/drive.js against the real Google Drive API
 * with explicit GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 * and DRIVE_FOLDER_ID environment variables. Run:
 *   NODE_USE_ENV_PROXY=1 node tests/test-drive.mjs
 */
import * as drive from "../src/drive.js";

const env = process.env;
for (const name of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "DRIVE_FOLDER_ID"]) {
  if (!env[name]) throw new Error(`Missing required environment variable: ${name}`);
}
const FOLDER_ID = env.DRIVE_FOLDER_ID;

let failed = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) failed++;
}

try {
  // 1. token
  const t0 = Date.now();
  const token = await drive.getAccessToken(env);
  check("getAccessToken", typeof token === "string" && token.length > 20, `${Date.now() - t0}ms`);

  // 2. upload
  const stamp = Date.now();
  const name = `v02-test-${stamp}.txt`;
  const payload = `cf-picbed v0.2 drive module test\nstamp=${stamp}\n`;
  const bytes = new TextEncoder().encode(payload);
  const t1 = Date.now();
  const meta = await drive.uploadFile(env, {
    name,
    mime: "text/plain",
    bytes,
    parents: [FOLDER_ID],
  });
  check("uploadFile", !!meta.id && meta.name === name, `${Date.now() - t1}ms id=${meta.id}`);
  check("uploadFile.parents", meta.parents?.includes(FOLDER_ID));

  // 3. meta
  const got = await drive.getFileMeta(env, meta.id);
  check("getFileMeta", got.id === meta.id && got.name === name);

  // 4. rename
  const newName = `v02-test-${stamp}-renamed.txt`;
  const renamed = await drive.renameFile(env, meta.id, newName);
  check("renameFile", renamed.name === newName);

  // 5. download + byte-exact compare
  const resp = await drive.downloadFile(env, meta.id);
  check("downloadFile status", resp.status === 200, `HTTP ${resp.status}`);
  const text = await resp.text();
  check("downloadFile content", text === payload, `${text.length} bytes`);

  // 6. range passthrough (first 10 bytes)
  const r2 = await drive.downloadFile(env, meta.id, "bytes=0-9");
  check("downloadFile range", r2.status === 206, `HTTP ${r2.status}`);
  if (r2.status === 206) {
    const partial = await r2.text();
    check("range content", partial === payload.slice(0, 10), JSON.stringify(partial));
  }

  // 7. list
  const files = await drive.listFiles(env, FOLDER_ID);
  check("listFiles", Array.isArray(files) && files.some((f) => f.id === meta.id), `count=${files.length}`);

  // 8. delete
  const t2 = Date.now();
  await drive.deleteFile(env, meta.id);
  check("deleteFile", true, `${Date.now() - t2}ms`);

  // 9. verify gone
  const gone = await drive.getFileMeta(env, meta.id).catch((e) => e);
  check("verify deleted", gone instanceof Error || gone.trashed, gone instanceof Error ? gone.message : "trashed=true");
} catch (e) {
  console.log("FAIL  unexpected exception:", e.message);
  failed++;
}

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILURES`);
process.exit(failed === 0 ? 0 : 1);
