/** Global settings (v1.4): key/value store in D1 with per-isolate cache.
 *  Admins tune values from /admin; registration and uploads read them. */

const DEFAULT_QUOTA_BYTES = 1073741824; // 1 GiB fallback
const DEFAULT_TRASH_RETENTION_DAYS = 30; // v1.11: trash auto-purge fallback
const CACHE_TTL_MS = 30_000;

let cache = { at: 0, values: {} };

/** Fallbacks used when a key is missing from D1 and env. */
const FALLBACKS = {
  default_quota_bytes: DEFAULT_QUOTA_BYTES,
  trash_retention_days: DEFAULT_TRASH_RETENTION_DAYS,
  explore_enabled: 1, // v1.23: public gallery on by default
  // v2.28.0: relay transfer tuning, previously hard-coded in source
  relay_max_mb: 20,
  relay_chunk_mb: 4,
  // v2.31.0: ceiling for chunked uploads (single-request uploads use relay_max_mb)
  relay_chunked_max_mb: 100,
};

/** Keys whose env override is parsed as a human size (bytes). */
const BYTE_KEYS = new Set(["default_quota_bytes"]);

/** Parse a human size like "500", "500G", "1.5T", "500GiB" into bytes.
 *  Returns null when unparseable. Binary units (GiB/TiB) by default;
 *  an explicit bare "B" suffix (e.g. "100B") means raw bytes. */
export function parseSize(input) {
  if (input == null) return null;
  if (typeof input === "number" && Number.isFinite(input)) {
    return input > 0 ? Math.floor(input) : null;
  }
  const s = String(input).trim();
  const m = /^([0-9]+(?:\.[0-9]+)?)\s*([KMGT]?)(?:I?B)?$/i.exec(s);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2].toUpperCase();
  if (!unit && /B$/i.test(s)) {
    const bytes = Math.floor(n);
    return bytes > 0 ? bytes : null;
  }
  const mult = { "": 1024 ** 3, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[unit];
  const bytes = Math.floor(n * mult);
  return bytes > 0 ? bytes : null;
}

/** Inverse of parseSize for display: 5497558138880 -> "5 TiB". */
export function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 ** 4) return trimZero(n / 1024 ** 4) + " TiB";
  if (n >= 1024 ** 3) return trimZero(n / 1024 ** 3) + " GiB";
  if (n >= 1024 ** 2) return trimZero(n / 1024 ** 2) + " MiB";
  if (n >= 1024) return trimZero(n / 1024) + " KiB";
  return n + " B";
}

function trimZero(x) {
  return x >= 100 ? String(Math.round(x)) : x.toFixed(1).replace(/\.0$/, "");
}

/** Read one setting (cached). Falls back to env, then a hard default.
 *  Byte-valued keys parse their env override as a human size; other keys
 *  accept a plain numeric env override. */
export async function getSetting(env, key) {
  const values = await loadAll(env);
  if (values[key] != null) return values[key];
  if (BYTE_KEYS.has(key)) {
    const envVal = parseSize(env[key.toUpperCase()]);
    if (envVal != null) return String(envVal);
  } else {
    const raw = env[key.toUpperCase()];
    if (raw != null && raw !== "" && Number.isFinite(Number(raw))) return String(Number(raw));
  }
  return String(FALLBACKS[key] ?? "");
}

/** Numeric convenience for byte-valued settings. */
export async function getSettingBytes(env, key) {
  const raw = await getSetting(env, key);
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : FALLBACKS[key];
}

/** Numeric convenience for plain-integer settings (v1.11 retention days),
 *  clamped to [min, max]; falls back to the hard default when unset/invalid. */
export async function getSettingInt(env, key, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const raw = await getSetting(env, key);
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return FALLBACKS[key] ?? min;
  return Math.min(max, Math.max(min, n));
}

/** Write one setting (admin only; updates cache immediately). */
export async function setSetting(env, key, value) {
  const v = String(value);
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  )
    .bind(key, v)
    .run();
  cache.values[key] = v;
  cache.at = Date.now();
  return v;
}

async function loadAll(env) {
  if (cache.at && Date.now() - cache.at < CACHE_TTL_MS) return cache.values;
  try {
    const { results } = await env.DB.prepare("SELECT key, value FROM settings").all();
    const values = {};
    for (const r of results || []) values[r.key] = r.value;
    cache = { at: Date.now(), values };
    return values;
  } catch {
    // Table not yet migrated: serve fallbacks without poisoning the cache.
    return cache.values;
  }
}

/** Test helper: drop the in-isolate cache. */
export function resetSettingsCache() {
  cache = { at: 0, values: {} };
}
