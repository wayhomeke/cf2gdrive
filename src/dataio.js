/** v1.22: data portability — export a metadata manifest, import image URLs. */

/** Columns exported for one image (no Drive ids, no secrets). */
export async function exportRows(env, userId) {
  const { results } = await env.DB.prepare(
    `SELECT i.public_id AS id, i.original_name, i.mime_type, i.size_bytes, i.visibility,
            i.views, i.created_at,
            (SELECT COUNT(*) FROM share_links s WHERE s.image_id = i.id AND s.revoked = 0) AS shares,
            (SELECT COUNT(*) FROM share_links s WHERE s.image_id = i.id AND s.revoked = 0
               AND (s.expires_at IS NULL OR julianday(s.expires_at) > julianday('now'))) AS live_shares
     FROM images i
     WHERE i.user_id = ? AND i.deleted = 0
     ORDER BY i.id`,
  )
    .bind(userId)
    .all();
  return results || [];
}

const CSV_COLUMNS = [
  "id",
  "original_name",
  "mime_type",
  "size_bytes",
  "visibility",
  "views",
  "shares",
  "live_shares",
  "created_at",
];

/** RFC4180-ish escaping: quote when the value contains comma/quote/newline. */
function csvCell(value) {
  const s = value == null ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows) {
  const head = CSV_COLUMNS.join(",");
  const body = rows.map((r) => CSV_COLUMNS.map((c) => csvCell(r[c])).join(",")).join("\r\n");
  return `${head}\r\n${body}${rows.length ? "\r\n" : ""}`;
}

/** Total bytes for a manifest (used in the page summary). */
export function sumBytes(rows) {
  return rows.reduce((acc, r) => acc + (Number(r.size_bytes) || 0), 0);
}

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Parse an import payload into {url, name?, visibility?} items.
 * Accepts a JSON array/object or newline/CSV text; a leading `url`/`链接` header
 * row is skipped, and `#` comments plus blank lines are ignored.
 * Returns {items, skipped, error}.
 */
export function parseImport(text, defaultVisibility = "private") {
  const raw = String(text || "").trim();
  if (!raw) return { items: [], skipped: 0, error: "empty" };
  const vis = defaultVisibility === "public" ? "public" : "private";

  // JSON: [{"url":...}] or {"items":[...]}
  if (raw.startsWith("[") || raw.startsWith("{")) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return { items: [], skipped: 0, error: "bad_json" };
    }
    const list = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
    const items = [];
    let skipped = 0;
    for (const entry of list) {
      const url = String(typeof entry === "string" ? entry : entry?.url || "").trim();
      if (!url) {
        skipped++;
        continue;
      }
      items.push({
        url,
        name: typeof entry === "object" && entry?.name ? String(entry.name).slice(0, 120) : undefined,
        visibility: entry?.visibility === "public" ? "public" : entry?.visibility === "private" ? "private" : vis,
      });
    }
    return { items, skipped, error: null };
  }

  // Text/CSV: each line is `url` or `url,name` or `url,name,visibility`.
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const items = [];
  let skipped = 0;
  for (let i = 0; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]).map((c) => c.trim());
    const first = cells[0] || "";
    if (i === 0 && /^(url|链接|地址)$/i.test(first)) continue; // header row
    if (!/^https?:\/\//i.test(first)) {
      skipped++;
      continue;
    }
    items.push({
      url: first,
      name: cells[1] ? cells[1].slice(0, 120) : undefined,
      visibility: cells[2] === "public" ? "public" : cells[2] === "private" ? "private" : vis,
    });
  }
  return { items, skipped, error: null };
}
