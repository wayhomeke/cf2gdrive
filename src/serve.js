/** Image serving endpoint logic: auth, Drive passthrough, Cache API, ETag/304.
 *  v1.5 adds a thumbnail mode (`/t/<public_id>`): Drive renders a small JPEG
 *  server-side; we proxy it with the same ownership gate as `/i/<public_id>`. */
import { downloadFile, fetchThumbnail } from "./drive.js";
import { securityHeaders } from "./http.js";

const PUBLIC_CACHE_SECONDS = 86400; // 1 day for public images
const THUMB_CACHE_SECONDS = 604800; // 7 days for thumbnails (content is immutable per id)
const THUMB_WIDTH = 400; // covers 2x DPR on 200px gallery cells

/**
 * Cache API is available on Workers but NOT in Pages Functions.
 * Returns null when unavailable; callers must degrade gracefully.
 */
function getDefaultCache() {
  try {
    if (typeof caches !== "undefined" && caches.default) return caches.default;
  } catch {
    // Pages Functions: caches.default is not supported.
  }
  return null;
}

/** Deleted / ownership gate shared by both modes.
 *  v1.13: shareOk=true means a valid share token grants access (private
 *  images included). Share-served responses never use the public cache
 *  path below, so a cached copy can't leak to anonymous /i/ requests.
 *  Returns {ok:true} or {ok:false, response} (410/403/404). */
function gateImage(image, sessionUserId, shareOk = false) {
  if (!image) {
    return { ok: false, response: new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json", ...securityHeaders() },
    }) };
  }
  if (image.deleted) {
    return { ok: false, response: new Response("gone", { status: 410, headers: securityHeaders() }) };
  }
  if (image.visibility !== "public" && image.user_id !== sessionUserId && !shareOk) {
    return { ok: false, response: new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "content-type": "application/json", ...securityHeaders() },
    }) };
  }
  return { ok: true };
}

function cacheKeyFor(request, path) {
  return new Request(new URL(request.url).origin + path, { method: "GET" });
}

/**
 * Serve an original image (`/i/<public_id>`).
 * @param env Worker env
 * @param image D1 image row
 * @param request original request
 * @param sessionUserId currently authenticated user id or null
 * @param ctx waitUntil carrier
 * @param shareOk v1.13: a valid share token grants access (see gateImage)
 */
export async function serveImage(env, image, request, sessionUserId, ctx, shareOk = false) {
  const gate = gateImage(image, sessionUserId, shareOk);
  if (!gate.ok) return gate.response;

  const isPublic = image.visibility === "public";
  const etag = `W/"${image.public_id}-${image.size_bytes}"`;

  const baseHeaders = {
    "content-type": image.mime_type,
    etag,
    "x-content-type-options": "nosniff",
    "content-disposition": "inline",
    ...(isPublic
      ? { "cache-control": `public, max-age=${PUBLIC_CACHE_SECONDS}` }
      : { "cache-control": "private, no-store" }),
  };

  // 304 handling
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag, ...securityHeaders() } });
  }

  const rangeHeader = request.headers.get("range");
  const method = request.method;

  // Cache lookup (public, full-body GETs only; no-op on Pages)
  const cache = getDefaultCache();
  if (isPublic && method === "GET" && !rangeHeader && cache) {
    const hit = await cache.match(cacheKeyFor(request, `/i/${image.public_id}`));
    if (hit) {
      const h = new Headers(hit.headers);
      h.set("x-cache", "HIT");
      return new Response(hit.body, { status: 200, headers: h });
    }
  }

  const upstream = await downloadFile(env, image.drive_file_id, rangeHeader);

  if (upstream.status === 404) {
    return new Response("not found", { status: 404, headers: securityHeaders() });
  }
  if (!upstream.ok && upstream.status !== 206 && upstream.status !== 304) {
    return new Response(JSON.stringify({ error: "upstream_error" }), {
      status: 502,
      headers: { "content-type": "application/json", ...securityHeaders() },
    });
  }

  const headers = new Headers(baseHeaders);
  for (const h of ["content-length", "content-range", "accept-ranges"]) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (upstream.status === 206) headers.set("cache-control", "public, max-age=3600");

  const response =
    method === "HEAD"
      ? new Response(null, { status: upstream.status, headers })
      : new Response(upstream.body, { status: upstream.status, headers });

  // Count a view (best effort, never blocks the response).
  if (ctx?.waitUntil) {
    ctx.waitUntil(
      env.DB.prepare("UPDATE images SET views = views + 1 WHERE id = ?")
        .bind(image.id)
        .run()
        .catch(() => {}),
    );
  }

  // Store full 200s for public images (clone: one stream, two consumers).
  if (
    isPublic &&
    method === "GET" &&
    !rangeHeader &&
    upstream.status === 200 &&
    cache &&
    ctx?.waitUntil
  ) {
    ctx.waitUntil(cache.put(cacheKeyFor(request, `/i/${image.public_id}`), response.clone()).catch(() => {}));
  }

  return response;
}

/**
 * Serve a thumbnail (`/t/<public_id>`, v1.5). Ownership gate first (so a cached
 * thumbnail never leaks to non-owners), then Cache API, then Drive.
 * If Drive cannot render a thumbnail for this file, fall back to a redirect
 * to the original (`/i/<public_id>`) so the UI degrades gracefully.
 */
export async function serveThumbnail(env, image, request, sessionUserId, ctx) {
  const gate = gateImage(image, sessionUserId);
  if (!gate.ok) return gate.response;

  const etag = `W/"t${image.public_id}-${image.size_bytes}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag, ...securityHeaders() } });
  }

  const cache = getDefaultCache();
  if (request.method === "GET" && cache) {
    const hit = await cache.match(cacheKeyFor(request, `/t/${image.public_id}`));
    if (hit) {
      const h = new Headers(hit.headers);
      h.set("x-cache", "HIT");
      return new Response(hit.body, { status: 200, headers: h });
    }
  }

  let upstream;
  try {
    upstream = await fetchThumbnail(env, image.drive_file_id, THUMB_WIDTH);
  } catch {
    // Drive could not render a thumbnail: redirect to the original.
    return new Response(null, {
      status: 302,
      headers: { location: `/i/${image.public_id}`, ...securityHeaders() },
    });
  }
  // Guard: never pass through a non-image body (e.g. a Google HTML error page).
  if (!(upstream.headers.get("content-type") || "").startsWith("image/")) {
    return new Response(null, {
      status: 302,
      headers: { location: `/i/${image.public_id}`, ...securityHeaders() },
    });
  }

  const headers = new Headers({
    "content-type": upstream.headers.get("content-type") || "image/jpeg",
    etag,
    "x-content-type-options": "nosniff",
    "content-disposition": "inline",
    "cache-control": `private, max-age=${THUMB_CACHE_SECONDS}`,
    ...securityHeaders(),
  });

  const response = request.method === "HEAD"
    ? new Response(null, { status: 200, headers })
    : new Response(upstream.body, { status: 200, headers });

  if (request.method === "GET" && cache && ctx?.waitUntil) {
    ctx.waitUntil(cache.put(cacheKeyFor(request, `/t/${image.public_id}`), response.clone()).catch(() => {}));
  }
  return response;
}
