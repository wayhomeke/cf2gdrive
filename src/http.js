/** Shared HTTP helpers for cf2gdrive (zero-dependency, Workers-compatible). */

export function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

export function html(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...securityHeaders(),
      ...extraHeaders,
    },
  });
}

export function securityHeaders() {
  return {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "same-origin",
    // v1.21: force https for a year (ignored on plain-http origins), and cut off
    // device APIs this app never needs.
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
    "content-security-policy":
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  };
}

/**
 * v1.21: true when a browser tells us the request came from another origin.
 * Requests with no Origin/Referer at all (curl, API clients, image embeds)
 * cannot be cross-site requests forged by a browser, so they are not flagged.
 */
export function isCrossOrigin(request) {
  let host;
  try {
    host = new URL(request.url).host;
  } catch {
    return true;
  }
  const judge = (value) => {
    if (!value) return null;
    try {
      return new URL(value).host === host;
    } catch {
      return false;
    }
  };
  const byOrigin = judge(request.headers.get("origin"));
  if (byOrigin !== null) return byOrigin === false;
  const byReferer = judge(request.headers.get("referer"));
  if (byReferer !== null) return byReferer === false;
  return false;
}

export function redirect(location, extraHeaders = {}) {
  return new Response(null, {
    status: 302,
    headers: { location, ...securityHeaders(), ...extraHeaders },
  });
}

export function parseCookies(request) {
  const out = {};
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function sessionCookie(token, maxAgeSeconds) {
  // Secure is always set: modern browsers accept Secure cookies on
  // http://localhost, and production is https-only anyway.
  return [
    `picbed_session=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Secure",
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ");
}

export function clearSessionCookie() {
  return [
    "picbed_session=",
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ].join("; ");
}

export function getClientIp(request) {
  return (
    request.headers.get("cf-connecting-ip") ||
    (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    "0.0.0.0"
  );
}

/** Parse JSON body safely; returns null on failure. */
export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isValidEmail(email) {
  return typeof email === "string" && email.length <= 254 && EMAIL_RE.test(email);
}

export function nowIso() {
  return new Date().toISOString();
}
