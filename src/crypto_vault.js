/**
 * WebCrypto-based AES-GCM-256 encryption helper for sensitive tokens in D1.
 * Uses Workers native crypto.subtle (zero external dependency).
 * Derives a dedicated 256-bit encryption key from SESSION_SECRET via HKDF.
 */

const ENC_ALGO = "AES-GCM";
const SALT = new TextEncoder().encode("cf2gdrive-credentials-vault-v1");

/** Derive AES-GCM-256 key from session secret using HKDF. */
async function deriveKey(sessionSecret) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(sessionSecret || "fallback-insecure-secret-seed-32chars"),
    "HKDF",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: SALT,
      info: enc.encode("credentials-encryption"),
    },
    baseKey,
    { name: ENC_ALGO, length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt plain text into "iv_hex:ciphertext_base64" string.
 */
export async function encryptSecret(sessionSecret, plainText) {
  if (!plainText) return "";
  const key = await deriveKey(sessionSecret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(plainText);

  const cipherBuf = await crypto.subtle.encrypt(
    { name: ENC_ALGO, iv },
    key,
    data,
  );

  const ivHex = [...iv].map((b) => b.toString(16).padStart(2, "0")).join("");
  const cipherBase64 = btoa(String.fromCharCode(...new Uint8Array(cipherBuf)));
  return `${ivHex}:${cipherBase64}`;
}

/**
 * Decrypt "iv_hex:ciphertext_base64" back into plain text.
 */
export async function decryptSecret(sessionSecret, cipherStr) {
  if (!cipherStr || !cipherStr.includes(":")) return "";
  const [ivHex, cipherBase64] = cipherStr.split(":");
  const ivBytes = new Uint8Array(
    ivHex.match(/.{1,2}/g).map((byte) => parseInt(byte, 16)),
  );
  const cipherBytes = Uint8Array.from(atob(cipherBase64), (c) => c.charCodeAt(0));

  const key = await deriveKey(sessionSecret);
  const plainBuf = await crypto.subtle.decrypt(
    { name: ENC_ALGO, iv: ivBytes },
    key,
    cipherBytes,
  );

  return new TextDecoder().decode(plainBuf);
}
