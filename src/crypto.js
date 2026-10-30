/** Crypto helpers: password hashing (PBKDF2-SHA256), tokens, digests.
 *  Works in Workers (WebCrypto) and Node >= 18. */

const PBKDF2_ITERATIONS = 100_000;

function subtle() {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error("WebCrypto unavailable");
  return c.subtle;
}

export function randomToken(bytes = 32) {
  const arr = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(text) {
  const digest = await subtle().digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashPassword(password, saltHex) {
  const key = await subtle().importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await subtle().deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: hexToBytes(saltHex),
      iterations: PBKDF2_ITERATIONS,
    },
    key,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

export async function verifyPassword(password, saltHex, expectedHashHex) {
  const actual = await hashPassword(password, saltHex);
  return constantTimeEqual(actual, expectedHashHex);
}

export function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
