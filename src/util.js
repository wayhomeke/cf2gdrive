/** Small shared utilities. */

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

/* ---------------- v1.25: opaque image ids ----------------
 * Sequential integer ids leak volume (9 images? 900000?) and let anyone walk
 * /i/1, /i/2, … to find every public image. The only id that leaves the server
 * is now `images.public_id`: 12 random hex chars (48 bit).
 */
export const SLUG_LEN = 12;
/** Route pattern for a public id (used inside `add("GET", "/i/(?<slug>…)")`). */
export const SLUG_PATTERN = "[0-9a-f]{12}";

const HEX = "0123456789abcdef";

/** 12 lowercase hex chars = 6 random bytes = 48 bit. */
export function newSlug(len = SLUG_LEN) {
  const arr = new Uint8Array(Math.ceil(len / 2));
  crypto.getRandomValues(arr);
  let s = "";
  for (const b of arr) s += HEX[b >> 4] + HEX[b & 15];
  return s.slice(0, len);
}

export function isSlug(s) {
  return typeof s === "string" && /^[0-9a-f]{12}$/.test(s);
}
