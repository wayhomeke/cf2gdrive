/** Minimal EXIF extractor for uploaded images (v1.12).
 *
 *  Parses JPEG APP1 ("Exif\0\0" TIFF) for camera/settings metadata and reads
 *  pixel dimensions from JPEG SOF or PNG IHDR. Returns null when nothing
 *  interesting is found. Deliberately dependency-free: Workers bundle size
 *  matters, and we only need a dozen tags.
 *
 *  Stored as JSON on images.exif (TEXT, nullable). */

const APP1 = 0xe1; // marker byte (the 0xff is checked separately)
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** TIFF field type -> byte size (types 1..12). */
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

/** Tags we care about, by IFD. */
const IFD0_TAGS = {
  0x010f: "make",
  0x0110: "model",
  0x0112: "orientation",
  0x0131: "software",
  0x0132: "datetime",
};
const EXIF_TAGS = {
  0x829a: "exposure",        // RATIONAL seconds
  0x829d: "fnumber",         // RATIONAL
  0x8827: "iso",             // SHORT
  0x920a: "focal",           // RATIONAL mm
  0xa434: "lens",            // ASCII
  0x9003: "taken_at",        // ASCII "YYYY:MM:DD HH:MM:SS"
  0xa002: "width",           // SHORT/LONG
  0xa003: "height",
};
const GPS_TAGS = {
  0x0001: "lat_ref",
  0x0002: "lat",
  0x0003: "lon_ref",
  0x0004: "lon",
};

/** Read a big/little-endian integer from buf at pos. */
function readInt(buf, pos, size, le) {
  let v = 0;
  if (le) {
    for (let i = size - 1; i >= 0; i--) v = v * 256 + buf[pos + i];
  } else {
    for (let i = 0; i < size; i++) v = v * 256 + buf[pos + i];
  }
  return v;
}

/** Read one TIFF field value (number, string, or rational). */
function readValue(buf, entryPos, le, tiffStart) {
  const type = readInt(buf, entryPos + 2, 2, le);
  const count = readInt(buf, entryPos + 4, 4, le);
  const size = (TYPE_SIZE[type] || 1) * count;
  const dataPos = size <= 4 ? entryPos + 8 : tiffStart + readInt(buf, entryPos + 8, 4, le);
  if (type === 2) {
    // ASCII
    let s = "";
    for (let i = 0; i < count; i++) {
      const c = buf[dataPos + i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s.trim();
  }
  if (type === 5) {
    // RATIONAL (or DMS triple for GPS tags)
    if (count === 1) {
      return { n: readInt(buf, dataPos, 4, le), d: readInt(buf, dataPos + 4, 4, le) };
    }
    if (count === 3) {
      const arr = [];
      for (let i = 0; i < 3; i++) {
        arr.push({
          n: readInt(buf, dataPos + i * 8, 4, le),
          d: readInt(buf, dataPos + i * 8 + 4, 4, le),
        });
      }
      return arr;
    }
    return null;
  }
  if (count === 1) return readInt(buf, dataPos, size, le);
  return null; // arrays: unused by our tag set
}

/** Walk one IFD, collecting the tags we want. Returns {tags, next}. */
function readIfd(buf, ifdPos, le, tiffStart, wanted) {
  const tags = {};
  const n = readInt(buf, ifdPos, 2, le);
  for (let i = 0; i < n; i++) {
    const entryPos = ifdPos + 2 + i * 12;
    if (entryPos + 12 > buf.length) break;
    const tag = readInt(buf, entryPos, 2, le);
    if (wanted[tag] == null) continue;
    const v = readValue(buf, entryPos, le, tiffStart);
    if (v !== null && v !== undefined) tags[wanted[tag]] = v;
  }
  const next = readInt(buf, ifdPos + 2 + n * 12, 4, le);
  return { tags, next };
}

function parseTiff(buf, start) {
  const le = buf[start] === 0x49 && buf[start + 1] === 0x49; // "II"
  if (!le && !(buf[start] === 0x4d && buf[start + 1] === 0x4d)) return null; // "MM"
  const ifd0 = start + readInt(buf, start + 4, 4, le);
  const out = {};
  const r0 = readIfd(buf, ifd0, le, start, IFD0_TAGS);
  Object.assign(out, r0.tags);
  let exifPtr = null;
  let gpsPtr = null;
  // pointers live in IFD0 but are not in IFD0_TAGS — re-read raw
  const n = readInt(buf, ifd0, 2, le);
  for (let i = 0; i < n; i++) {
    const entryPos = ifd0 + 2 + i * 12;
    const tag = readInt(buf, entryPos, 2, le);
    if (tag === 0x8769) exifPtr = start + readInt(buf, entryPos + 8, 4, le);
    if (tag === 0x8825) gpsPtr = start + readInt(buf, entryPos + 8, 4, le);
  }
  if (exifPtr) {
    const r = readIfd(buf, exifPtr, le, start, EXIF_TAGS);
    Object.assign(out, r.tags);
  }
  if (gpsPtr) {
    const r = readIfd(buf, gpsPtr, le, start, GPS_TAGS);
    Object.assign(out, r.tags);
  }
  return out;
}

function ratioStr(r, unit) {
  if (!r || !r.d) return null;
  if (unit === "s") {
    if (r.d === 1) return `${r.n}s`;
    if (r.n === 1) return `1/${r.d}s`;
    return `${(r.n / r.d).toFixed(2)}s`;
  }
  if (unit === "mm") return `${Math.round((r.n / r.d) * 10) / 10}mm`;
  const v = r.n / r.d;
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10}${unit || ""}`;
}

/** GPS DMS triple -> signed decimal degrees. */
function dmsToDeg(dms, ref) {
  if (!Array.isArray(dms) || dms.length !== 3) return null;
  const v = dms[0].n / dms[0].d + dms[1].n / dms[1].d / 60 + dms[2].n / dms[2].d / 3600;
  if (!Number.isFinite(v)) return null;
  return ref === "S" || ref === "W" ? -v : v;
}

/** Extract metadata. Returns a compact object or null. */
export function extractExif(buffer, mimeType) {
  if (!buffer || buffer.length < 32) return null;
  const out = {};

  if (mimeType === "image/png" || (buffer[0] === 0x89 && buffer[1] === 0x50)) {
    // PNG: IHDR at fixed offset 16 (after 8-byte signature + 4 len + "IHDR")
    if (buffer.length >= 24) {
      out.width = (buffer[16] << 24) | (buffer[17] << 16) | (buffer[18] << 8) | buffer[19];
      out.height = (buffer[20] << 24) | (buffer[21] << 16) | (buffer[22] << 8) | buffer[23];
    }
  }

  if (!(buffer[0] === 0xff && buffer[1] === 0xd8)) {
    return Object.keys(out).length ? out : null; // not JPEG: PNG dims only
  }

  // Walk JPEG segments.
  let pos = 2;
  while (pos + 4 <= buffer.length) {
    if (buffer[pos] !== 0xff) break;
    const marker = buffer[pos + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break; // SOS/EOI: image data starts
    const segLen = (buffer[pos + 2] << 8) | buffer[pos + 3];
    if (segLen < 2 || pos + 2 + segLen > buffer.length) break;
    if (marker === APP1 && buffer[pos + 4] === 0x45 && buffer[pos + 5] === 0x78) {
      // "Exif\0\0"
      const t = parseTiff(buffer, pos + 10);
      if (t) Object.assign(out, t);
    }
    if (SOF_MARKERS.has(marker) && out.width == null) {
      out.height = (buffer[pos + 5] << 8) | buffer[pos + 6];
      out.width = (buffer[pos + 7] << 8) | buffer[pos + 8];
    }
    pos += 2 + segLen;
  }

  return formatExif(out);
}

/** Map raw TIFF values to the stored/displayed shape. */
function formatExif(raw) {
  const o = {};
  const clean = (s, max = 64) => (typeof s === "string" ? s.slice(0, max) : null);
  const make = clean(raw.make);
  const model = clean(raw.model);
  if (make || model) o.camera = [make, model].filter(Boolean).join(" ").slice(0, 80);
  const lens = clean(raw.lens);
  if (lens) o.lens = lens;
  const taken = clean(raw.taken_at || raw.datetime, 20);
  if (taken) o.taken_at = taken.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3");
  if (raw.exposure) o.exposure = ratioStr(raw.exposure, "s");
  if (raw.fnumber) o.fnumber = "f/" + ratioStr(raw.fnumber, "");
  if (raw.iso != null) o.iso = Number(raw.iso) || null;
  if (raw.focal) o.focal = ratioStr(raw.focal, "mm");
  if (raw.software) o.software = clean(raw.software, 48);
  if (raw.orientation) o.orientation = Number(raw.orientation);
  if (raw.width && raw.height) {
    o.width = Number(raw.width);
    o.height = Number(raw.height);
  }
  if (raw.lat && raw.lon) {
    const lat = dmsToDeg(raw.lat, raw.lat_ref);
    const lon = dmsToDeg(raw.lon, raw.lon_ref);
    if (lat != null && lon != null) {
      o.gps = [Math.round(lat * 1e6) / 1e6, Math.round(lon * 1e6) / 1e6];
    }
  }
  for (const k of Object.keys(o)) if (o[k] == null) delete o[k];
  return Object.keys(o).length ? o : null;
}
