/**
 * cf2gdrive — Cloudflare Pages (Functions) image hosting and file relay backed by Google Drive.
 * v0.3: user auth (register / login / logout / session middleware).
 */
import {
  getSessionUser,
  login,
  logout,
  rateLimit,
  register,
  unauthorized,
  withSessionCookie,
  withoutSessionCookie,
} from "./auth.js";
import { getClientIp, html, isCrossOrigin, json, readJson, redirect, securityHeaders } from "./http.js";
import { UploadError, fetchRemoteImage, uploadImage } from "./images.js";
import {
  RelayError,
  createRelayShare,
  fetchRemoteRelayFile,
  getRelayFile,
  listRelayFiles,
  listRelayShares,
  loadOwnRelayFile,
  formatContentDisposition,
  purgeRelayFile,
  relayJson,
  renameRelayFile,
  resolveRelayShare,
  restoreRelayFile,
  RELAY_MAX_MB,
  revokeRelayShare,
  serveRelayFile,
  softDeleteRelayFile,
  uploadRelayFile,
} from "./relay.js";
import { adminPage, auditPage, dataPage, docsPage, errorPage, explorePage, galleryPage, relayPage, sessionsPage, settingsPage, sharesPage, storageGuidePage, storagePage, trashPage } from "./pages.js";
import { encryptSecret, decryptSecret } from "./crypto_vault.js";
import { generateAuthUrl, exchangeCallback } from "./gdrive_oauth.js";
import { listSessions, revokeOtherSessions, revokeSession } from "./sessions.js";
import {
  AUDIT_LABELS,
  auditActions,
  auditActionsStatement,
  auditLabel,
  auditListStatement,
  auditResultShape,
  listAudit,
  logAudit,
} from "./audit.js";
import { serveImage, serveThumbnail } from "./serve.js";
import {
  createShare,
  listSharesForImage,
  listSharesForUser,
  parseExpiry,
  resolveShare,
  revokeShare,
} from "./shares.js";
import { SLUG_PATTERN, escapeHtml, isSlug } from "./util.js";
import { sanitizeFilename } from "./images.js";
import { deleteFile, moveFile, createFolder, listDriveFolders, getDriveConfig, downloadFile, startResumableUpload, putResumableChunk, queryResumableStatus } from "./drive.js";
import { listUserFolders, resolveUserFolder, userFolderName, userStoragePath } from "./folder.js";
import {
  ID_LEN,
  MAX_DIRS,
  MAX_FILES_PER_DIR,
  listStorageDirs,
  newStorageName,
  ownerPrefix,
  recountStorageDirs,
  releaseStorageDir,
  resolveStorageDir,
  storagePath,
  storageSummary,
} from "./shard.js";
import { hashPassword, randomToken, verifyPassword } from "./crypto.js";
import {
  authenticateApiKey,
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from "./apikeys.js";
import {
  createInvite,
  inviteListStatement,
  inviteStatus,
  listInvites,
  revokeInvite,
} from "./invites.js";
import { exportRows, parseImport, sumBytes, toCsv } from "./dataio.js";
import { formatSize, getSetting, getSettingBytes, getSettingInt, parseSize, setSetting } from "./settings.js";

const VERSION = "2.39.1";

/* ---------------- tiny router ---------------- */
const routes = [];
function add(method, pattern, handler) {
  routes.push({ method, pattern: new RegExp(`^${pattern}$`), handler });
}
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

async function dispatch(request, env, ctx) {
  const url = new URL(request.url);
  // v1.21: one choke point for CSRF. Cookie-authenticated writes coming from a
  // foreign origin are refused before any handler runs; Bearer-token calls are
  // exempt because a browser never attaches that credential on its own.
  if (WRITE_METHODS.has(request.method) && !request.headers.get("authorization") && isCrossOrigin(request)) {
    return json({ error: "cross_origin" }, 403, securityHeaders());
  }
  const isHead = request.method === "HEAD";
  const effectiveMethod = isHead ? "GET" : request.method;

  for (const r of routes) {
    if (r.method !== effectiveMethod) continue;
    const m = r.pattern.exec(url.pathname);
    if (m) {
      const params = m.groups || {};
      const res = await r.handler({ request, env, ctx, url, params });
      return isHead ? new Response(null, { status: res.status, headers: res.headers }) : res;
    }
  }
  if (url.pathname.startsWith("/api/")) {
    return json({ error: "not_found" }, 404, securityHeaders());
  }
  const user = await getSessionUser(env, request).catch(() => null);
  return html(errorPage(404, "页面不存在", "你访问的路径没有对应的页面。", user), 404);
}

/* ---------------- helpers ---------------- */
function badRequest(msg) {
  return json({ error: "bad_request", message: msg }, 400, securityHeaders());
}

/** Local byte formatter for inline page templates (v1.6 quota bar). */
function fmtBytesLocal(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KiB";
  if (n < 1073741824) return (n / 1048576).toFixed(2) + " MiB";
  if (n < 1099511627776) return (n / 1073741824).toFixed(2) + " GiB";
  return (n / 1099511627776).toFixed(2) + " TiB";
}

function sameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true; // non-browser client (curl/API)
  const host = new URL(request.url).host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function readForm(request) {
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/json")) return await readJson(request);
  if (ct.includes("form-urlencoded") || ct.includes("multipart/form-data")) {
    try {
      const fd = await request.formData();
      return Object.fromEntries(fd.entries());
    } catch {
      return null;
    }
  }
  return await readJson(request);
}

function authPage(kind, error = "", isFirstUser = false) {
  const isLogin = kind === "login";
  const title = isLogin ? "登录" : "注册";
  const action = isLogin ? "/login" : "/register";
  const errHtml = error ? `<p class="err">${escapeHtml(error)}</p>` : "";
  const nameField = isLogin
    ? ""
    : `<label>显示名称<input name="display_name" maxlength="60" autocomplete="nickname"></label>`;
  const inviteField = isLogin
    ? ""
    : isFirstUser
      ? `<label>邀请码（免填）<input name="invite_code" autocomplete="off" placeholder="首位用户免填邀请码" style="text-transform:uppercase;letter-spacing:1px"></label>
         <p style="font-size:12px;color:var(--ok);margin:-4px 0 12px">🎉 系统自举：首位注册用户将自动升级为超级管理员，无需邀请码。</p>`
      : `<label>邀请码<input name="invite_code" required autocomplete="off" placeholder="XXXX-XXXX-XXXX-XXXX" style="text-transform:uppercase;letter-spacing:1px"></label>
         <p style="font-size:12px;color:var(--mut);margin:-4px 0 12px">注册需要邀请码，请联系管理员获取。</p>`;
  const switchLine = isLogin
    ? `<p class="switch">还没有账号？<a href="/register">注册</a></p>`
    : `<p class="switch">已有账号？<a href="/login">登录</a></p>`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · cf2gdrive</title>
<script>(function(){try{var t=localStorage.getItem('picbed_theme');if(t!=='dark'&&t!=='light')t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme='light'}})()</script>
<style>
  :root{--bg:#f6f7f9;--card:#fff;--line:#e3e6ea;--txt:#1f2328;--mut:#6b7280;--label:#444;--inp:#ccd2d9;--inp-bg:#fff;--acc:#2563eb;--acc-h:#1d4ed8;--dan:#dc2626;--nt-err-bg:#fef2f2;--nt-err-line:#fecaca}
  html[data-theme="dark"]{--bg:#0f1115;--card:#171a21;--line:#2a2f3a;--txt:#e5e7eb;--mut:#9ca3af;--label:#9ca3af;--inp:#374151;--inp-bg:#111827;--acc:#3b82f6;--acc-h:#2563eb;--dan:#f87171;--nt-err-bg:rgba(248,113,113,.12);--nt-err-line:#7f1d1d}
  body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--txt);display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:32px;width:min(320px,90vw);box-shadow:0 2px 12px rgba(0,0,0,.05)}
  h1{font-size:20px;margin:0 0 20px}
  label{display:block;font-size:13px;color:var(--label);margin-bottom:12px}
  input{display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:8px 10px;border:1px solid var(--inp);border-radius:6px;font-size:14px;background:var(--inp-bg);color:var(--txt)}
  button{width:100%;padding:10px;background:var(--acc);color:#fff;border:0;border-radius:6px;font-size:14px;cursor:pointer;margin-top:8px}
  button:hover{background:var(--acc-h)}
  .err{color:var(--dan);font-size:13px;background:var(--nt-err-bg);border:1px solid var(--nt-err-line);border-radius:6px;padding:8px 10px}
  .switch{font-size:13px;color:var(--mut);text-align:center;margin:16px 0 0}
  a{color:var(--acc)}
  #themebtn{position:fixed;top:14px;right:14px;width:auto;margin:0;padding:6px 10px;background:var(--card);border:1px solid var(--line);border-radius:6px;font-size:14px;cursor:pointer}
</style>
</head>
<body>
<button id="themebtn" type="button" onclick="toggleTheme()" title="切换深色/浅色模式">🌓</button>
<div class="card">
  <h1>${title}</h1>
  ${errHtml}
  <form method="post" action="${action}">
    <label>邮箱<input name="email" type="email" required autocomplete="email"></label>
    ${nameField}
    <label>密码<input name="password" type="password" required minlength="8" autocomplete="${isLogin ? "current-password" : "new-password"}"></label>
    ${inviteField}
    <button type="submit">${title}</button>
  </form>
  ${switchLine}
</div>
<script>
function toggleTheme(){const cur=document.documentElement.dataset.theme==='dark'?'dark':'light';const next=cur==='dark'?'light':'dark';document.documentElement.dataset.theme=next;try{localStorage.setItem('picbed_theme',next)}catch(e){}const b=document.getElementById('themebtn');if(b)b.textContent=next==='dark'?'☀️':'🌓';}
(function(){const b=document.getElementById('themebtn');if(b)b.textContent=document.documentElement.dataset.theme==='dark'?'☀️':'🌓';})();
</script>
</body>
</html>`;
}

const ERR_TEXT = {
  invalid_email: "邮箱格式不正确",
  email_taken: "该邮箱已注册",
  password_too_short: "密码至少 8 位",
  invalid_credentials: "邮箱或密码错误",
  rate_limited: "操作过于频繁，请稍后再试",
  invite_required: "请输入邀请码",
  invalid_invite: "邀请码无效或已被吊销",
  invite_exhausted: "邀请码使用次数已用完",
  invite_expired: "邀请码已过期",
};

/* ---------------- routes ---------------- */

add("GET", "/healthz", async ({ env }) => {
  // v2.27.0: surface the relay transfer contract so a client (or a support
  // session) can see the effective limits without reading the source.
  const maxMb = await getSettingInt(env, "relay_max_mb", 1, 200).catch(() => 20);
  const chunkMb = await getSettingInt(env, "relay_chunk_mb", 1, 16).catch(() => 4);
  return json(
    {
      status: "ok",
      version: VERSION,
      relay: {
        max_upload_mb: Number(env.RELAY_MAX_MB) || maxMb,
        chunked_max_upload_mb: Math.floor((await relayChunkedMaxBytes(env)) / 1048576),
        download_chunk_mb: 2,
        chunk_mb: chunkMb,
        upload_concurrency: 2,
        resumable: true,
        integrity: "sha256",
        content_length: true,
      },
    },
    200,
    securityHeaders(),
  );
});

add("GET", "/", async ({ request, env }) => {
  const user = await getSessionUser(env, request);
  if (user) return redirect("/dashboard");
  return redirect("/login");
});

add("GET", "/register", async ({ env }) => {
  const c = Number((await env.DB.prepare("SELECT COUNT(*) AS c FROM users").first())?.c || 0);
  return html(authPage("register", "", c === 0));
});
add("GET", "/login", () => html(authPage("login")));

add("POST", "/register", async ({ request, env, ctx }) => {
  if (!sameOrigin(request)) return badRequest("cross-origin post rejected");
  const ip = getClientIp(request);
  const rl = await rateLimit(env, `register:${ip}`, 5, 3600);
  if (!rl.allowed) return badRequest(ERR_TEXT.rate_limited);

  const form = await readForm(request);
  if (!form) return badRequest("invalid body");
  const res = await register(env, { ...form, inviteCode: form.invite_code });
  if (res.error) {
    const c = Number((await env.DB.prepare("SELECT COUNT(*) AS c FROM users").first())?.c || 0);
    return html(authPage("register", ERR_TEXT[res.error] || res.error, c === 0), 400);
  }
  // auto-login after register
  const loginRes = await login(env, {
    email: form.email,
    password: form.password,
    request,
  });
  if (loginRes.error) return redirect("/login");
  logAudit(env, ctx, { action: "register", email: form.email, detail: res.user?.role === "admin" ? "首位用户自举管理员" : "邀请码注册", ip: getClientIp(request) });
  return withSessionCookie(redirect("/dashboard"), loginRes.token);
});

add("POST", "/login", async ({ request, env, ctx }) => {
  if (!sameOrigin(request)) return badRequest("cross-origin post rejected");
  const ip = getClientIp(request);
  const rl = await rateLimit(env, `login:${ip}`, 10, 300);
  if (!rl.allowed) return html(authPage("login", ERR_TEXT.rate_limited), 429);

  const form = await readForm(request);
  if (!form) return badRequest("invalid body");
  const res = await login(env, { ...form, request });
  if (res.error) {
    logAudit(env, ctx, { action: "login_failed", email: form.email, detail: res.error, ip });
    return html(authPage("login", ERR_TEXT[res.error] || res.error), 401);
  }
  logAudit(env, ctx, { action: "login", email: form.email, ip });
  return withSessionCookie(redirect("/dashboard"), res.token);
});

add("POST", "/logout", async ({ request, env, ctx }) => {
  if (!sameOrigin(request)) return badRequest("cross-origin post rejected");
  const u = await getSessionUser(env, request);
  await logout(env, request);
  if (u) logAudit(env, ctx, { action: "logout", userId: u.id, email: u.email, ip: getClientIp(request) });
  return withoutSessionCookie(redirect("/login"));
});

add("GET", "/me", async ({ request, env }) => {
  const user = await getSessionUser(env, request);
  if (!user) return json({ error: "unauthorized" }, 401, securityHeaders());
  return json({ user }, 200, securityHeaders());
});

/* ---------------- gallery + image management (v0.6) ---------------- */

const PAGE_SIZE = 24;

/* ---------------- image list filters (v1.10) ---------------- */

const IMAGE_SORTS = {
  newest: "created_at DESC, id DESC",
  oldest: "created_at ASC, id ASC",
  largest: "size_bytes DESC, id DESC",
  smallest: "size_bytes ASC, id DESC",
  views: "views DESC, id DESC",
};

function parseImageFilters(url) {
  const q = String(url.searchParams.get("q") || "").trim().slice(0, 100);
  const visRaw = url.searchParams.get("vis");
  const sortRaw = url.searchParams.get("sort");
  return {
    q,
    vis: ["private", "public"].includes(visRaw) ? visRaw : "all",
    sort: Object.hasOwn(IMAGE_SORTS, sortRaw) ? sortRaw : "newest",
  };
}

/** Escape LIKE metacharacters so q matches literally (ESCAPE '\'). */
function likeEscape(s) {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

/** Dynamic WHERE/ORDER for image list queries. Base is user_id = ? AND deleted = 0. */
function imageListQuery(filters, userId) {
  const clauses = ["user_id = ?", "deleted = 0"];
  const binds = [userId];
  if (filters.q) {
    clauses.push("original_name LIKE ? ESCAPE '\\'");
    binds.push(`%${likeEscape(filters.q)}%`);
  }
  if (filters.vis !== "all") {
    clauses.push("visibility = ?");
    binds.push(filters.vis);
  }
  return { where: clauses.join(" AND "), binds, order: IMAGE_SORTS[filters.sort] };
}

/** Query string preserving active filters (for pagination links / redirects). */
function filterQuery(filters, extra = {}) {
  const qs = new URLSearchParams();
  if (filters.q) qs.set("q", filters.q);
  if (filters.vis !== "all") qs.set("vis", filters.vis);
  if (filters.sort !== "newest") qs.set("sort", filters.sort);
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

add("GET", "/dashboard", ({ request, env, url }) =>
  redirect(`/gallery${url.search}`));

add("GET", "/gallery", async ({ request, env, url }) => {
  const user = await getSessionUser(env, request);
  if (!user) return redirect("/login");
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const filters = parseImageFilters(url);
  // v1.5: one round trip (COUNT(*) OVER ()); v1.10: dynamic where/order.
  const q = imageListQuery(filters, user.id);
  const { results } = await env.DB.prepare(
    `SELECT id, public_id, original_name, mime_type, size_bytes, visibility, views, created_at, exif,
            COUNT(*) OVER () AS total_count
     FROM images WHERE ${q.where}
     ORDER BY ${q.order} LIMIT ? OFFSET ?`,
  )
    .bind(...q.binds, PAGE_SIZE, (page - 1) * PAGE_SIZE)
    .all();
  const images = results || [];
  const totalCount = images.length ? images[0].total_count : 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  if (safePage !== page) return redirect(`/gallery${filterQuery(filters, { page: safePage })}`);
  return html(galleryPage(user, images, safePage, totalPages, totalCount, filters));
});

/** Resolve the acting user: Bearer API key first, then session cookie. */
async function resolveUser(env, request, ctx) {
  const apiUser = await authenticateApiKey(env, request, ctx);
  if (apiUser) return apiUser;
  return getSessionUser(env, request);
}

/** v1.25: batch endpoints accept opaque tokens only. Entries that are not a
 *  well-formed slug (integers from the pre-v1.25 API, nulls, objects) are
 *  dropped before they cost a D1 round trip. */
function idList(body, cap) {
  const raw = Array.isArray(body?.ids) ? body.ids : [];
  return raw.slice(0, cap).map((v) => String(v)).filter(isSlug);
}

/** Shared: load an image owned by the acting user (or 404/403). */
async function loadOwnImage(env, request, id, ctx) {
  const user = await resolveUser(env, request, ctx);
  if (!user) return { error: unauthorized() };
  const image = await env.DB.prepare("SELECT * FROM images WHERE public_id = ?")
    .bind(String(id))
    .first();
  if (!image || image.deleted) return { error: json({ error: "not_found" }, 404, securityHeaders()) };
  if (image.user_id !== user.id) {
    return { error: json({ error: "forbidden" }, 403, securityHeaders()) };
  }
  return { user, image };
}

add("POST", `/images/(?<slug>${SLUG_PATTERN})/delete`, async ({ request, env, ctx, params }) => {
  const { error, user, image } = await loadOwnImage(env, request, params.slug, ctx);
  if (error) return error;
  await softDeleteImage(env, user, image);
  logAudit(env, ctx, { action: "delete", userId: user.id, email: user.email, target: image.public_id, detail: image.original_name });
  return json({ ok: true, id: image.public_id }, 200, securityHeaders());
});

async function softDeleteImage(env, user, image) {
  await env.DB.prepare("UPDATE images SET deleted = 1, deleted_at = ? WHERE id = ?")
    .bind(nowIsoSafe(), image.id)
    .run();
  await env.DB.prepare("UPDATE users SET used_bytes = MAX(0, used_bytes - ?) WHERE id = ?")
    .bind(image.size_bytes, user.id)
    .run();
}

add("POST", `/images/(?<slug>${SLUG_PATTERN})/rename`, async ({ request, env, ctx, params }) => {
  const { error, image } = await loadOwnImage(env, request, params.slug, ctx);
  if (error) return error;
  const form = await readForm(request);
  const name = String(form?.name || "").trim();
  if (!name || name.length > 120) {
    return json({ error: "bad_name" }, 400, securityHeaders());
  }
  const safe = name.replace(/[\x00-\x1f\x7f]/g, "").replace(/[\\/]/g, "_").slice(0, 120);
  await env.DB.prepare("UPDATE images SET original_name = ? WHERE id = ?")
    .bind(safe, image.id)
    .run();
  return json({ ok: true, name: safe }, 200, securityHeaders());
});

function nowIsoSafe() {
  return new Date().toISOString();
}

/* ---------------- image serving (v0.5) ---------------- */

async function handleImageServe({ request, env, ctx, params }) {
  const image = await env.DB.prepare("SELECT * FROM images WHERE public_id = ?")
    .bind(params.slug)
    .first();
  if (!image) {
    return json({ error: "not_found" }, 404, securityHeaders());
  }
  const user = await resolveUser(env, request, ctx);
  return serveImage(env, image, request, user?.id ?? null, ctx);
}

add("GET", `/i/(?<slug>${SLUG_PATTERN})`, handleImageServe);
add("HEAD", `/i/(?<slug>${SLUG_PATTERN})`, handleImageServe);

/** Thumbnail serve (v1.5): Drive-rendered small JPEG behind the same gate. */
async function handleThumbServe({ request, env, ctx, params }) {
  const image = await env.DB.prepare("SELECT * FROM images WHERE public_id = ?")
    .bind(params.slug)
    .first();
  if (!image) {
    return json({ error: "not_found" }, 404, securityHeaders());
  }
  const user = await resolveUser(env, request, ctx);
  return serveThumbnail(env, image, request, user?.id ?? null, ctx);
}

add("GET", `/t/(?<slug>${SLUG_PATTERN})`, handleThumbServe);
add("HEAD", `/t/(?<slug>${SLUG_PATTERN})`, handleThumbServe);

/* ---------------- share links (v1.13) ---------------- */

const SHARE_ERROR_TEXT = {
  not_found: { status: 404, title: "链接不存在", msg: "这个分享链接无效或已被删除。" },
  revoked: { status: 404, title: "链接已被吊销", msg: "链接创建者已吊销此分享。" },
  expired: { status: 410, title: "链接已过期", msg: "分享链接已超过有效期，请联系创建者。" },
  gone: { status: 410, title: "图片不存在", msg: "被分享的图片已被删除。" },
};

/** GET /s/<token>: serve the shared image bytes directly.
 *  Served with the private (no-store) headers and never via the public
 *  cache, so an anonymous /i/<id> request can never hit a shared copy. */
add("GET", "/s/(?<token>[A-Za-z0-9_-]{8,64})", async ({ request, env, ctx, params }) => {
  const resolved = await resolveShare(env, params.token);
  if (resolved.error) {
    const e = SHARE_ERROR_TEXT[resolved.error] || SHARE_ERROR_TEXT.not_found;
    return html(errorPage(e.status, e.title, e.msg), e.status);
  }
  const { share, image } = resolved;
  if (ctx?.waitUntil) {
    ctx.waitUntil(
      env.DB.prepare("UPDATE share_links SET views = views + 1 WHERE id = ?")
        .bind(share.id)
        .run()
        .catch(() => {}),
    );
  }
  return serveImage(env, image, request, null, ctx, true);
});
add("HEAD", "/s/(?<token>[A-Za-z0-9_-]{8,64})", async ({ request, env, ctx, params }) => {
  const resolved = await resolveShare(env, params.token);
  if (resolved.error) {
    const e = SHARE_ERROR_TEXT[resolved.error] || SHARE_ERROR_TEXT.not_found;
    return html(errorPage(e.status, e.title, e.msg), e.status);
  }
  return serveImage(env, resolved.image, request, null, ctx, true);
});

/** POST /api/images/:id/share — create a time-limited share link. */
add("POST", `/api/images/(?<slug>${SLUG_PATTERN})/share`, async ({ request, env, ctx, params }) => {
  const user = await resolveUser(env, request, ctx);
  if (!user) return unauthorized();
  const image = await env.DB.prepare("SELECT * FROM images WHERE public_id = ?")
    .bind(params.slug)
    .first();
  if (!image || image.deleted || image.user_id !== user.id) {
    return json({ error: "not_found" }, 404, securityHeaders());
  }
  const body = await readJson(request).catch(() => ({}));
  const expiry = parseExpiry(body);
  if (!expiry) {
    return badRequest("expires_in_days must be an integer 1-3650, or set never=true");
  }
  const share = await createShare(env, user.id, image.id, expiry);
  logAudit(env, ctx, { action: "share_create", userId: user.id, email: user.email, target: image.public_id, detail: share.expires_at ? `到期 ${share.expires_at}` : "永久有效" });
  return json(
    {
      id: share.id,
      url: `/s/${share.token}`,
      token: share.token,
      expires_at: share.expires_at,
      created_at: share.created_at,
    },
    201,
    securityHeaders(),
  );
});

/** GET /api/images/:id/shares — active shares of one image. */
add("GET", `/api/images/(?<slug>${SLUG_PATTERN})/shares`, async ({ request, env, ctx, params }) => {
  const user = await resolveUser(env, request, ctx);
  if (!user) return unauthorized();
  const image = await env.DB.prepare("SELECT * FROM images WHERE public_id = ?")
    .bind(params.slug)
    .first();
  if (!image || image.deleted || image.user_id !== user.id) {
    return json({ error: "not_found" }, 404, securityHeaders());
  }
  const shares = (await listSharesForImage(env, image.id)).map((s) => ({
    id: s.id,
    url: `/s/${s.token}`,
    expires_at: s.expires_at,
    views: s.views,
    created_at: s.created_at,
  }));
  return json({ shares }, 200, securityHeaders());
});

/** DELETE /api/shares/:id — revoke a share the caller created. */
add("DELETE", "/api/shares/(?<id>\\d+)", async ({ request, env, ctx, params }) => {
  const user = await resolveUser(env, request, ctx);
  if (!user) return unauthorized();
  const ok = await revokeShare(env, user.id, params.id);
  if (!ok) return json({ error: "not_found" }, 404, securityHeaders());
  logAudit(env, ctx, { action: "share_revoke", userId: user.id, email: user.email, target: params.id });
  return json({ ok: true, id: Number(params.id) }, 200, securityHeaders());
});

/** GET /shares — management page for the caller's active shares. */
add("GET", "/shares", async ({ request, env, ctx }) => {
  const user = await getSessionUser(env, request);
  if (!user) return redirect("/login");
  const shares = await listSharesForUser(env, user.id);
  return html(sharesPage(user, shares));
});

/* ---------------- v1.17: session / device management ---------------- */

add("GET", "/sessions", async ({ request, env, url }) => {
  const user = await getSessionUser(env, request);
  if (!user) return redirect("/login");
  const sessions = await listSessions(env, user.id);
  const m = url.searchParams.get("msg");
  const msg = m === "revoked" ? "已注销该设备" : m === "others" ? "已注销其他所有设备" : "";
  return html(sessionsPage(user, sessions, user.session_id, msg));
});

add("POST", "/sessions/(?<id>\\d+)/revoke", async ({ request, env, ctx, params }) => {
  if (!sameOrigin(request)) return badRequest("cross-origin post rejected");
  const user = await getSessionUser(env, request);
  if (!user) return redirect("/login");
  const ok = await revokeSession(env, user.id, params.id);
  if (ok) logAudit(env, ctx, { action: "session_revoke", userId: user.id, email: user.email, target: params.id, ip: getClientIp(request) });
  return redirect(ok ? "/sessions?msg=revoked" : "/sessions");
});

add("POST", "/sessions/revoke-others", async ({ request, env, ctx }) => {
  if (!sameOrigin(request)) return badRequest("cross-origin post rejected");
  const user = await getSessionUser(env, request);
  if (!user) return redirect("/login");
  const n = await revokeOtherSessions(env, user.id, user.session_id);
  logAudit(env, ctx, { action: "session_revoke_others", userId: user.id, email: user.email, detail: `${n} 个设备`, ip: getClientIp(request) });
  return redirect("/sessions?msg=others");
});

/* ---------------- v1.18: audit log ---------------- */

add("GET", "/audit", async ({ request, env, url }) => {
  const user = await getSessionUser(env, request);
  if (!user) return redirect("/login");
  const isAdmin = user.role === "admin";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const filters = {
    action: (url.searchParams.get("action") || "").slice(0, 60),
    q: (url.searchParams.get("q") || "").trim().slice(0, 100),
  };
  // v1.20: listing + action histogram in one batched round trip.
  const opts = {
    page,
    perPage: 50,
    action: filters.action,
    q: filters.q,
    userId: isAdmin ? url.searchParams.get("user_id") || "" : user.id,
  };
  const [listRes, actRes] = await env.DB.batch([
    auditListStatement(env, opts),
    auditActionsStatement(env),
  ]);
  let data = auditResultShape(listRes, opts);
  if (data.unknown) data = await listAudit(env, opts); // rare: page past the end
  const actions = isAdmin ? actRes.results || [] : [];
  return html(auditPage(user, data, actions, filters, isAdmin));
});

add("GET", "/api/admin/relay-config", async ({ request, env, ctx }) => {
  const gate = await adminApi(env, request, ctx);
  if (gate.error) return gate.error;
  return json(
    {
      relay_max_mb: Math.floor((await relayMaxBytes(env)) / 1048576),
      relay_chunk_mb: Math.floor((await relayChunkBytes(env)) / 1048576),
      env_override_mb: Number(env.RELAY_MAX_MB) || 0,
    },
    200,
    securityHeaders(),
  );
});

add("POST", "/api/admin/relay-config", async ({ request, env, ctx }) => {
  const gate = await adminApi(env, request, ctx);
  if (gate.error) return gate.error;
  const body = await readJson(request);
  const maxMb = Number.parseInt(body?.relay_max_mb, 10);
  const chunkMb = Number.parseInt(body?.relay_chunk_mb, 10);
  if (Number.isFinite(maxMb) && maxMb >= 1 && maxMb <= 200) {
    await setSetting(env, "relay_max_mb", String(maxMb));
  }
  if (Number.isFinite(chunkMb) && chunkMb >= 1 && chunkMb <= 16) {
    await setSetting(env, "relay_chunk_mb", String(chunkMb));
  }
  return json(
    {
      ok: true,
      relay_max_mb: Math.floor((await relayMaxBytes(env)) / 1048576),
      relay_chunk_mb: Math.floor((await relayChunkBytes(env)) / 1048576),
    },
    200,
    securityHeaders(),
  );
});

add("GET", "/api/admin/audit", async ({ request, env, ctx, url }) => {
  const gate = await adminApi(env, request, ctx);
  if (gate.error) return gate.error;
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(url.searchParams.get("per_page") || "50", 10) || 50));
  const data = await listAudit(env, {
    page,
    perPage,
    action: (url.searchParams.get("action") || "").slice(0, 60),
    q: (url.searchParams.get("q") || "").trim().slice(0, 100),
    userId: url.searchParams.get("user_id") || "",
  });
  return json(
    {
      logs: data.rows.map((r) => ({
        id: r.id,
        at: r.created_at,
        actor: r.actor_email,
        user_id: r.user_id,
        action: r.action,
        action_label: auditLabel(r.action),
        target: r.target,
        detail: r.detail,
        ip: r.ip,
      })),
      total: data.total,
      page: data.page,
      per_page: data.perPage,
      pages: data.pages,
    },
    200,
    securityHeaders(),
  );
});

add("GET", "/api/sessions", async ({ request, env, ctx }) => {
  const user = await resolveUser(env, request, ctx);
  if (!user) return unauthorized();
  const sessions = await listSessions(env, user.id);
  return json(
    {
      sessions: sessions.map((s) => ({
        id: s.id,
        device: s.device,
        ip: s.ip,
        created_at: s.created_at,
        last_seen_at: s.last_seen_at,
        expires_at: s.expires_at,
        active: s.active,
        current: Number(s.id) === Number(user.session_id),
      })),
      total: sessions.length,
    },
    200,
    securityHeaders(),
  );
});

add("DELETE", "/api/sessions/(?<id>\\d+)", async ({ request, env, ctx, params }) => {
  const user = await resolveUser(env, request, ctx);
  if (!user) return unauthorized();
  if (Number(params.id) === Number(user.session_id)) {
    return json({ error: "cannot_revoke_current", message: "当前会话请用退出登录" }, 400, securityHeaders());
  }
  const ok = await revokeSession(env, user.id, params.id);
  if (!ok) return json({ error: "not_found" }, 404, securityHeaders());
  logAudit(env, ctx, { action: "session_revoke", userId: user.id, email: user.email, target: params.id });
  return json({ ok: true, id: Number(params.id) }, 200, securityHeaders());
});

// Inline SVG favicon: avoids a 404 round trip on every page load.
add("GET", "/favicon.ico", () =>
  new Response(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#2563eb"/><rect x="6" y="8" width="20" height="16" rx="2" fill="#fff"/><circle cx="13" cy="14" r="2.6" fill="#2563eb"/><path d="M9 23l5-5 4 4 3-3 4 4v2H9z" fill="#2563eb"/></svg>`,
    { status: 200, headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } },
  ),
);

/* ---------------- upload (v0.4) ---------------- */

add("GET", "/upload", async ({ request, env }) => {
  const user = await getSessionUser(env, request);
  if (!user) return redirect("/login");
  // v1.6: quota bar + client-side projection constants (server stays authoritative)
  const usedPct = user.quota_bytes > 0 ? Math.min(100, (user.used_bytes / user.quota_bytes) * 100) : 0;
  const remain = Math.max(0, user.quota_bytes - user.used_bytes);
  const qColor = usedPct >= 95 ? "#dc2626" : usedPct >= 80 ? "#f59e0b" : "#2563eb";
  const qbar = `<div class="qbar">
  <div class="qrow">已用 <b>${fmtBytesLocal(user.used_bytes)}</b> / 配额 <b>${fmtBytesLocal(user.quota_bytes)}</b> · 剩余 <b style="color:${usedPct >= 80 ? "#dc2626" : "#15803d"}">${fmtBytesLocal(remain)}</b></div>
  <div class="bar"><div class="fill" style="width:${usedPct.toFixed(1)}%;background:${qColor}"></div></div>
</div>`;
  return html(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>上传 · cf2gdrive</title>
<link rel="icon" href="/favicon.ico" type="image/svg+xml">
<style>
body{font-family:system-ui,-apple-system,"PingFang SC",sans-serif;background:#f6f7f9;margin:0;padding:40px}
.card{background:#fff;border:1px solid #e3e6ea;border-radius:12px;padding:24px;max-width:560px;margin:0 auto}
.drop{border:2px dashed #c7cdd4;border-radius:10px;padding:36px;text-align:center;color:#666;cursor:pointer;margin:16px 0}
.drop.over{border-color:#2563eb;background:#eff6ff;color:#2563eb}
.vis{display:flex;gap:10px;margin:14px 0 0}
.vis label{flex:1;display:flex;gap:8px;align-items:flex-start;border:1px solid #e3e6ea;border-radius:8px;padding:10px 12px;cursor:pointer;font-size:13px;line-height:1.5}
.vis label:hover{border-color:#2563eb}
.vis input{margin-top:2px}
.vis b{display:block;font-size:14px;color:#1f2328}
.vis small{color:#6b7280}
.frow{border:1px solid #e3e6ea;border-radius:8px;padding:12px 14px;margin-top:12px;font-size:13px}
.frow .fname{font-weight:600;word-break:break-all;margin-bottom:6px}
.bar{height:8px;background:#eef1f4;border-radius:99px;overflow:hidden}
.bar .fill{height:100%;width:0;background:#2563eb;border-radius:99px;transition:width .15s}
.frow .fst{color:#6b7280;margin-top:6px}
.frow .fst.ok{color:#15803d}
.frow .fst.err{color:#dc2626}
.frow .fst.warn{color:#b45309}
.qbar{background:#fff;border:1px solid #e3e6ea;border-radius:10px;padding:12px 16px;margin-bottom:16px;font-size:13px;color:#6b7280}
.qbar .qrow{margin-bottom:8px}
.qbar b{color:#1f2328}
.frow .res{margin-top:8px;display:flex;gap:10px;align-items:flex-start}
.frow .res img{width:64px;height:64px;object-fit:cover;border:1px solid #e3e6ea;border-radius:6px}
.frow .res .lk{flex:1;min-width:0}
.frow .res code{display:block;background:#f6f7f9;border:1px solid #e3e6ea;border-radius:6px;padding:6px 8px;font-size:12px;word-break:break-all}
.frow .res button{margin-top:6px;font-size:12px;padding:5px 12px;border:1px solid #ccd2d9;border-radius:6px;background:#fff;cursor:pointer}
.urlrow{display:flex;gap:8px;margin:0 0 4px}
.urlrow input{flex:1;padding:8px 10px;border:1px solid #ccd2d9;border-radius:6px;font-size:13px}
.urlrow button{padding:8px 14px;background:#2563eb;color:#fff;border:0;border-radius:6px;font-size:13px;cursor:pointer;white-space:nowrap}
a{color:#2563eb}
</style></head>
<body><div class="card">
<h2>上传图片</h2>
${qbar}
<div class="vis">
  <label><input type="radio" name="vis" value="private" checked><span><b>私有</b><small>仅自己登录后可访问（默认）</small></span></label>
  <label><input type="radio" name="vis" value="public"><span><b>公开</b><small>任何人拿到链接即可访问</small></span></label>
</div>
<div class="drop" id="drop">点击选择、拖入或按 Ctrl+V 粘贴图片（jpeg/png/gif/webp/avif，≤20MB）</div>
<input type="file" id="file" accept="image/*" hidden multiple>
<div class="urlrow"><input id="urlin" placeholder="或粘贴图片 URL（http/https）" autocomplete="off"><button type="button" onclick="urlUpload()">从 URL 上传</button></div>
<div id="list"></div>
<p style="font-size:12px;color:#888;margin:18px 0 0"><a href="/gallery">← 返回图库</a></p>
</div>
<script>
const drop = document.getElementById('drop'), fileInput = document.getElementById('file'), list = document.getElementById('list');
function curVis(){ return document.querySelector('input[name=vis]:checked').value; }
drop.onclick = () => fileInput.click();
drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); for (const f of e.dataTransfer.files) upload(f); };
fileInput.onchange = () => { for (const f of fileInput.files) upload(f); fileInput.value = ''; };
// v1.8: paste to upload (screenshots, copied images)
document.addEventListener('paste', e => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const it of items) {
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const f = it.getAsFile();
      if (f) upload(f);
    }
  }
});
// v1.9: upload from a remote URL
async function urlUpload() {
  const u = document.getElementById('urlin').value.trim();
  if (!u) return;
  const row = document.createElement('div'); row.className = 'frow';
  const nm = document.createElement('div'); nm.className = 'fname'; nm.textContent = u;
  const st = document.createElement('div'); st.className = 'fst'; st.textContent = '抓取中…';
  row.appendChild(nm); row.appendChild(st); list.prepend(row);
  try {
    const r = await fetch('/api/upload-url', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({url:u, visibility:curVis()})});
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.id) {
      st.textContent = '上传成功 · ' + fmtBytes(j.size_bytes || 0) + ' · ' + (j.mime_type || '') + (j.visibility === 'public' ? ' · 公开' : ' · 私有');
      st.className = 'fst ok';
      const res = document.createElement('div'); res.className = 'res';
      const img = document.createElement('img'); img.src = location.origin + '/t/' + j.id; img.alt = j.original_name || '';
      const lk = document.createElement('div'); lk.className = 'lk';
      const code = document.createElement('code'); code.textContent = location.origin + j.url;
      const btn = document.createElement('button'); btn.textContent = '复制链接';
      btn.onclick = () => { navigator.clipboard.writeText(location.origin + j.url).then(() => { btn.textContent = '已复制'; }, () => prompt('复制链接:', location.origin + j.url)); };
      lk.appendChild(code); lk.appendChild(btn);
      res.appendChild(img); res.appendChild(lk); row.appendChild(res);
      document.getElementById('urlin').value = '';
    } else {
      st.textContent = '失败: ' + (j.message || j.error || ('HTTP ' + r.status));
      st.className = 'fst err';
    }
  } catch {
    st.textContent = '网络错误，请重试';
    st.className = 'fst err';
  }
}
function fmtBytes(n){ if(n<1024) return n+' B'; if(n<1048576) return (n/1024).toFixed(1)+' KiB'; return (n/1048576).toFixed(2)+' MiB'; }
// v1.6: client-side quota projection (server remains authoritative)
const Q_USED = ${user.used_bytes}, Q_TOTAL = ${user.quota_bytes};
let queued = 0;
function upload(f) {
  if (Q_USED + queued + f.size > Q_TOTAL) {
    const skip = document.createElement('div'); skip.className = 'frow';
    const nm = document.createElement('div'); nm.className = 'fname'; nm.textContent = f.name + ' · ' + fmtBytes(f.size);
    const st = document.createElement('div'); st.className = 'fst warn';
    st.textContent = '已跳过：超出剩余配额（还需 ' + fmtBytes(Q_USED + queued + f.size - Q_TOTAL) + '）';
    skip.appendChild(nm); skip.appendChild(st); list.prepend(skip);
    return;
  }
  queued += f.size;
  const row = document.createElement('div'); row.className = 'frow';
  const nm = document.createElement('div'); nm.className = 'fname'; nm.textContent = f.name + ' · ' + fmtBytes(f.size) + ' · ' + curVis();
  const bar = document.createElement('div'); bar.className = 'bar';
  const fill = document.createElement('div'); fill.className = 'fill';
  const st = document.createElement('div'); st.className = 'fst'; st.textContent = '等待中…';
  bar.appendChild(fill); row.appendChild(nm); row.appendChild(bar); row.appendChild(st);
  list.prepend(row);
  const fd = new FormData();
  fd.append('file', f);
  fd.append('visibility', curVis());
  const xhr = new XMLHttpRequest();
  xhr.upload.onprogress = e => {
    if (e.lengthComputable) {
      const pct = Math.round(e.loaded / e.total * 100);
      fill.style.width = pct + '%';
      st.textContent = '上传中 ' + pct + '%（' + fmtBytes(e.loaded) + ' / ' + fmtBytes(e.total) + '）';
    } else {
      st.textContent = '上传中…';
    }
  };
  xhr.onload = () => {
    let j = {};
    try { j = JSON.parse(xhr.responseText); } catch {}
    if (xhr.status >= 200 && xhr.status < 300 && j.id) {
      fill.style.width = '100%';
      st.textContent = '上传成功 · ' + fmtBytes(j.size_bytes || f.size) + ' · ' + j.mime_type + (j.visibility === 'public' ? ' · 公开' : ' · 私有');
      st.className = 'fst ok';
      const res = document.createElement('div'); res.className = 'res';
      const img = document.createElement('img'); img.src = location.origin + '/t/' + j.id; img.alt = j.original_name || f.name;
      const lk = document.createElement('div'); lk.className = 'lk';
      const code = document.createElement('code'); code.textContent = location.origin + j.url;
      const btn = document.createElement('button'); btn.textContent = '复制链接';
      btn.onclick = () => { navigator.clipboard.writeText(location.origin + j.url).then(() => { btn.textContent = '已复制'; }, () => prompt('复制链接:', location.origin + j.url)); };
      lk.appendChild(code); lk.appendChild(btn);
      res.appendChild(img); res.appendChild(lk); row.appendChild(res);
    } else {
      queued -= f.size;
      fill.style.width = '100%'; fill.style.background = '#dc2626';
      st.textContent = '失败: ' + (j.message || j.error || ('HTTP ' + xhr.status));
      st.className = 'fst err';
    }
  };
  xhr.onerror = () => { queued -= f.size; st.textContent = '网络错误，请重试'; st.className = 'fst err'; };
  xhr.open('POST', '/api/upload');
  xhr.send(fd);
}
</script>
</body></html>`,
  );
});

/** v1.24: shard errors (507 storage_full / 503 storage_busy) carry the same
 *  { status, code } shape as UploadError, so they share one response path. */
function codedError(e) {
  return e instanceof UploadError || (e && typeof e.status === "number" && typeof e.code === "string");
}

function uploadFailure(e) {
  if (codedError(e)) return json({ error: e.code, message: e.message }, e.status, securityHeaders());
  return json({ error: "upload_failed", message: String(e.message).slice(0, 200) }, 500, securityHeaders());
}

add("POST", "/api/upload", async ({ request, env, ctx }) => {
  const user = await resolveUser(env, request, ctx);
  if (!user) return unauthorized();
  const rl = await rateLimit(env, `apiupload:${user.id}`, 60, 3600);
  if (!rl.allowed) {
    return json(
      { error: "rate_limited", retry_after: rl.retryAfter },
      429,
      securityHeaders(),
    );
  }
  const ct = request.headers.get("content-type") || "";
  if (!ct.includes("multipart/form-data")) {
    return json({ error: "expected_multipart" }, 400, securityHeaders());
  }
  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "bad_multipart" }, 400, securityHeaders());
  }
  const file = form.get("file");
  if (!file || typeof file === "string") {
    return json({ error: "missing_file" }, 400, securityHeaders());
  }
  const visibility = form.get("visibility") === "public" ? "public" : "private";
  try {
    const buffer = await file.arrayBuffer();
    const row = await uploadImage(env, user, {
      buffer,
      originalName: file.name,
      visibility,
    });
    logAudit(env, ctx, {
      action: "upload",
      userId: user.id,
      email: user.email,
      target: row.public_id,
      detail: `${row.original_name} · ${row.size_bytes}B · ${visibility}`,
      ip: getClientIp(request),
    });
    return json(
      {
        id: row.public_id,
        url: row.url,
        original_name: row.original_name,
        mime_type: row.mime_type,
        size_bytes: row.size_bytes,
        visibility: row.visibility,
        created_at: row.created_at,
      },
      201,
      securityHeaders(),
    );
  } catch (e) {
    return uploadFailure(e);
  }
});

/* ---------------- 文件中转 / file relay (v1.26) ---------------- */

/** Files landing in the relay: never blocks a response, never throws. */
function relayFailure(e) {
  if (e instanceof RelayError || e?.name === "RelayError") {
    return json({ error: e.code, message: e.message }, e.status, securityHeaders());
  }
  const detail = e?.message ? String(e.message).slice(0, 300) : "upload failed";
  return json({ error: "internal", message: detail }, e?.status && typeof e.status === "number" ? e.status : 500, securityHeaders());
}

add("POST", "/api/relay/upload", async ({ request, env, ctx }) => {
  const user = await resolveUser(env, request, ctx);
  if (!user) return unauthorized();
  const rl = await rateLimit(env, `relayupload:${user.id}`, 60, 3600);
  if (!rl.allowed) {
    return json({ error: "rate_limited", retry_after: rl.retryAfter }, 429, securityHeaders());
  }
  const ct = request.headers.get("content-type") || "";
  let buffer;
  let filename = "file";
  let visibility = "private";
  let clientSha256 = "";

  if (ct.includes("application/json")) {
    const body = await readJson(request);
    if (!body || typeof body !== "object") {
      return json({ error: "bad_json" }, 400, securityHeaders());
    }
    if (!body.url || typeof body.url !== "string") {
      return json({ error: "missing_url" }, 400, securityHeaders());
    }
    visibility = body.visibility === "public" ? "public" : "private";
    const maxBytes = (Number(env.RELAY_MAX_MB) || 20) * 1024 * 1024;
    try {
      const fetched = await fetchRemoteRelayFile(body.url, maxBytes);
      buffer = fetched.buffer;
      filename = fetched.name;
    } catch (e) {
      return relayFailure(e);
    }
  } else if (ct.includes("multipart/form-data")) {
    let form;
    try {
      form = await request.formData();
    } catch {
      return json({ error: "bad_multipart" }, 400, securityHeaders());
    }
    const file = form.get("file");
    if (!file || typeof file === "string") {
      return json({ error: "missing_file" }, 400, securityHeaders());
    }
    visibility = form.get("visibility") === "public" ? "public" : "private";
    filename = file.name;
    buffer = await file.arrayBuffer();
    // v2.18.0: optional client-declared checksum, verified server-side.
    const declared = form.get("client_sha256");
    if (typeof declared === "string" && declared) clientSha256 = declared;
  } else {
    return json({ error: "missing_file", message: "expected multipart/form-data or application/json" }, 400, securityHeaders());
  }

  try {
    const row = await uploadRelayFile(env, user, {
      buffer,
      originalName: filename,
      visibility,
      clientSha256,
    });
    logAudit(env, ctx, {
      action: "relay.upload",
      userId: user.id,
      email: user.email,
      target: String(row.id),
      detail: `${row.original_name} · ${row.size_bytes}B · ${visibility}`,
      ip: getClientIp(request),
    });
    return json({ ...relayJson(row) }, 201, securityHeaders());
  } catch (e) {
    // v2.26.0: record why an upload failed — without this, instability shows up
    // only as user complaints and never as data we can act on.
    logAudit(env, ctx, {
      action: "relay.upload_failed",
      userId: user.id,
      email: user.email,
      target: filename,
      detail: String(e?.code || e?.message || "unknown").slice(0, 160),
      ip: getClientIp(request),
    });
    return relayFailure(e);
  }
});

/* ---------------- chunked / resumable relay uploads (v2.19.0+) ---------------- */

// Drive requires every chunk except the last to be a multiple of 256 KiB.
const RELAY_CHUNK_SIZE = 4 * 1024 * 1024;

/** v2.28.0: effective single-file cap — env wins, then the admin setting. */
async function relayMaxBytes(env) {
  const cfgMb = await getSettingInt(env, "relay_max_mb", 1, 200).catch(() => 0);
  return (Number(env.RELAY_MAX_MB) || cfgMb || RELAY_MAX_MB) * 1024 * 1024;
}

/** v2.28.0: effective chunk size for resumable uploads. */
async function relayChunkBytes(env) {
  const cfgMb = await getSettingInt(env, "relay_chunk_mb", 1, 16).catch(() => 0);
  return (cfgMb || 4) * 1024 * 1024;
}

/**
 * v2.31.0: cap for the *chunked* upload path. A single request still honours
 * relayMaxBytes (20 MiB by default) because one huge multipart body is exactly
 * what the fragile link drops; a chunked upload is made of small requests, so
 * it may go up to the platform ceiling (Cloudflare request body limit).
 */
const RELAY_CHUNKED_MAX_MB = 100;

async function relayChunkedMaxBytes(env) {
  // Clamp generously: the real ceiling is Google Drive (5 TB), not this value.
  const cfgMb = await getSettingInt(env, "relay_chunked_max_mb", 1, 5000).catch(() => 0);
  return (cfgMb || RELAY_CHUNKED_MAX_MB) * 1024 * 1024;
}

function newUploadSessionId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function loadUploadSession(env, userId, sessionId) {
  return env.DB.prepare(
    "SELECT * FROM relay_upload_sessions WHERE id = ? AND user_id = ? AND status = 'active'",
  )
    .bind(sessionId, userId)
    .first();
}

async function finalizeRelaySession(env, user, session, driveFileId) {
  const path = userStoragePath(session.folder, session.storage_name);
  const res = await env.DB.prepare(
    `INSERT INTO relay_files (user_id, drive_file_id, name, original_name, mime_type, size_bytes, visibility, folder, storage_path, content_sha256)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      user.id,
      driveFileId,
      session.storage_name,
      session.original_name,
      session.mime_type,
      session.size_bytes,
      session.visibility,
      session.folder,
      path,
      session.client_sha256 || null,
    )
    .run();

  await env.DB.prepare("UPDATE users SET relay_used_bytes = relay_used_bytes + ? WHERE id = ?")
    .bind(session.size_bytes, user.id)
    .run();
  await env.DB.prepare("DELETE FROM relay_upload_sessions WHERE id = ?").bind(session.id).run();

  const row = await env.DB.prepare("SELECT * FROM relay_files WHERE id = ?")
    .bind(res.meta.last_row_id)
    .first();
  return { ...row, url: `/f/${row.id}` };
}

add("POST", "/api/relay/upload/init", async ({ request, env, ctx }) => {
  const user = await resolveUser(env, request, ctx);
  if (!user) return unauthorized();
  const body = await readJson(request);
  const rawName = String(body?.name || "").trim();
  const size = Number(body?.size);
  if (!rawName) return json({ error: "missing_name" }, 400, securityHeaders());
  if (!Number.isInteger(size) || size <= 0) {
    return json({ error: "bad_size" }, 400, securityHeaders());
  }
  // v2.31.0: chunked uploads are many small requests, so they may exceed the
  // single-request cap and go up to the platform ceiling instead.
  const maxBytes = await relayChunkedMaxBytes(env);
  if (size > maxBytes) {
    return json({ error: "too_large", message: `file exceeds ${maxBytes} bytes` }, 413, securityHeaders());
  }
  const used = Number(user.relay_used_bytes || 0);
  const quota = Number(user.relay_quota_bytes || 2147483648);
  if (used + size > quota) {
    return json({ error: "quota_exceeded", message: "relay storage quota exceeded" }, 413, securityHeaders());
  }

  const visibility = body?.visibility === "public" ? "public" : "private";
  const originalName = sanitizeFilename(rawName);
  const ext = originalName.includes(".") ? originalName.split(".").pop().toLowerCase() : "bin";
  const mime = String(body?.mime || "application/octet-stream").slice(0, 160);
  const clientSha =
    typeof body?.client_sha256 === "string"
      ? body.client_sha256.trim().toLowerCase().replace(/^sha256:/, "")
      : "";

  const folder = await resolveUserFolder(env, user.id, user.email);
  const storageName = newStorageName(ext);
  const chunkSize = await relayChunkBytes(env);
  const uploadUri = await startResumableUpload(env, {
    name: storageName,
    mime,
    size,
    parents: [folder.driveFolderId],
  });

  const sessionId = newUploadSessionId();
  await env.DB.prepare(
    `INSERT INTO relay_upload_sessions (id, user_id, original_name, mime_type, size_bytes, chunk_size, upload_uri, client_sha256, storage_name, folder, visibility)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      sessionId,
      user.id,
      originalName,
      mime,
      size,
      chunkSize,
      uploadUri,
      clientSha || null,
      storageName,
      folder.folder,
      visibility,
    )
    .run();

  return json(
    { session_id: sessionId, chunk_size: chunkSize, size, received: 0 },
    201,
    securityHeaders(),
  );
});

add("GET", "/api/relay/upload/status", async ({ request, env, ctx, url }) => {
  const user = await resolveUser(env, request, ctx);
  if (!user) return unauthorized();
  const sessionId = String(url.searchParams.get("session") || "");
  const session = await loadUploadSession(env, user.id, sessionId);
  if (!session) return json({ error: "session_not_found" }, 404, securityHeaders());

  // v2.21.0: Drive tells us exactly how many bytes survived, which turns a dead
  // upload into a resumable one.
  const st = await queryResumableStatus(session.upload_uri, session.size_bytes);
  const received = st.done ? session.size_bytes : st.received;
  await env.DB.prepare(
    "UPDATE relay_upload_sessions SET received_bytes = ?, updated_at = datetime('now') WHERE id = ?",
  )
    .bind(received, sessionId)
    .run();

  if (st.done) {
    const row = await finalizeRelaySession(env, user, session, st.file?.id);
    logAudit(env, ctx, {
      action: "relay.upload",
      userId: user.id,
      email: user.email,
      target: String(row.id),
      detail: `${row.original_name} · ${row.size_bytes}B · chunked · ${session.visibility}`,
      ip: getClientIp(request),
    });
    return json(
      { done: true, received, size: session.size_bytes, file: relayJson(row) },
      200,
      securityHeaders(),
    );
  }
  return json(
    { done: false, received, size: session.size_bytes, chunk_size: session.chunk_size },
    200,
    securityHeaders(),
  );
});

add("POST", "/api/relay/upload/chunk", async ({ request, env, ctx, url }) => {
  const user = await resolveUser(env, request, ctx);
  if (!user) return unauthorized();
  const sessionId = String(url.searchParams.get("session") || "");
  const session = await loadUploadSession(env, user.id, sessionId);
  if (!session) return json({ error: "session_not_found" }, 404, securityHeaders());

  const bytes = await request.arrayBuffer();
  if (!bytes || bytes.byteLength === 0) {
    return json({ error: "empty_chunk" }, 400, securityHeaders());
  }
  const offset = Number(session.received_bytes || 0);
  if (offset + bytes.byteLength > session.size_bytes) {
    return json({ error: "chunk_overflow" }, 400, securityHeaders());
  }

  const res = await putResumableChunk(session.upload_uri, bytes, offset, session.size_bytes);
  const received = res.done ? session.size_bytes : res.received;
  await env.DB.prepare(
    "UPDATE relay_upload_sessions SET received_bytes = ?, updated_at = datetime('now') WHERE id = ?",
  )
    .bind(received, sessionId)
    .run();

  if (!res.done) {
    return json({ done: false, received, size: session.size_bytes }, 200, securityHeaders());
  }

  const row = await finalizeRelaySession(env, user, session, res.file?.id);
  logAudit(env, ctx, {
    action: "relay.upload",
    userId: user.id,
    email: user.email,
    target: String(row.id),
    detail: `${row.original_name} · ${row.size_bytes}B · chunked · ${session.visibility}`,
    ip: getClientIp(request),
  });
  return json(
    { done: true, received, size: session.size_bytes, file: relayJson(row) },
    201,
    securityHeaders(),
  );
});

/**
 * v2.32.0: download plan for a relay file. Any client that cannot hold a whole
 * file in one request (CLI tools, flaky links) can walk this manifest with
 * Range requests and reassemble the parts locally.
 */
add("GET", `/api/relay/(?<id>\\d+)/manifest`, async ({ request, env, ctx, params, url }) => {
  const user = await resolveUser(env, request, ctx);
  if (!user) return unauthorized();
  const row = await getRelayFile(env, params.id);
  if (!row || row.deleted) return json({ error: "not_found" }, 404, securityHeaders());
  if (row.visibility !== "public" && row.user_id !== user.id) {
    return json({ error: "forbidden" }, 403, securityHeaders());
  }

  // Small default keeps memory low; large files are far more efficient with
  // bigger parts, so the caller may ask for up to 16 MiB per request.
  const wantMb = Number(url.searchParams.get("chunk_mb"));
  const CH = (Number.isFinite(wantMb) && wantMb >= 1 && wantMb <= 16 ? Math.floor(wantMb) : 2) * 1024 * 1024;
  const total = Number(row.size_bytes) || 0;
  const count = Math.max(1, Math.ceil(total / CH));
  const chunks = [];
  for (let i = 0; i < count; i++) {
    const start = i * CH;
    const end = Math.min(start + CH - 1, Math.max(0, total - 1));
    chunks.push({ index: i, start, end, bytes: end - start + 1 });
  }
  return json(
    {
      id: row.id,
      name: row.original_name,
      mime: row.mime_type,
      size: total,
      chunk_size: CH,
      count,
      checksum: row.content_sha256 ? `sha256:${row.content_sha256}` : null,
      supports_range: true,
      chunks,
    },
    200,
    securityHeaders(),
  );
});

add("GET", "/api/relay/stats", async ({ request, env, ctx }) => {
  const user = await resolveUser(env, request, ctx);
  if (!user) return unauthorized();
  const rows = await env.DB.prepare(
    `SELECT action, COUNT(*) c FROM audit_log
      WHERE user_id = ? AND action IN ('relay.upload', 'relay.upload_failed')
        AND created_at > datetime('now', '-30 days')
      GROUP BY action`,
  )
    .bind(user.id)
    .all();
  const out = { uploaded: 0, failed: 0, pending_sessions: 0 };
  for (const r of rows?.results || []) {
    if (r.action === "relay.upload") out.uploaded = Number(r.c) || 0;
    else out.failed = Number(r.c) || 0;
  }
  const pending = await env.DB.prepare(
    "SELECT COUNT(*) c FROM relay_upload_sessions WHERE user_id = ? AND status = 'active'",
  )
    .bind(user.id)
    .first();
  out.pending_sessions = Number(pending?.c || 0);
  // resolveUser returns a slim session principal, so read the real counters.
  const quotaRow = await env.DB.prepare(
    "SELECT relay_quota_bytes, relay_used_bytes FROM users WHERE id = ?",
  )
    .bind(user.id)
    .first();
  out.relay_used_bytes = Number(quotaRow?.relay_used_bytes || 0);
  out.relay_quota_bytes = Number(quotaRow?.relay_quota_bytes || 0);
  return json(out, 200, securityHeaders());
});

add("GET", "/api/relay", async ({ request, env, ctx, url }) => {
  const user = await resolveUser(env, request, ctx);
  if (!user) return unauthorized();
  const data = await listRelayFiles(env, user.id, {
    page: url.searchParams.get("page") || 1,
    perPage: url.searchParams.get("per_page") || 24,
    filter: url.searchParams.get("filter") === "trash" ? "trash" : "live",
    q: url.searchParams.get("q") || "",
    sort: url.searchParams.get("sort") || "created_desc",
    visibility: url.searchParams.get("visibility") || "all",
  });
  return json(
    {
      files: data.rows.map(relayJson),
      page: data.page,
      per_page: data.perPage,
      total_pages: data.totalPages,
      total: data.total,
    },
    200,
    securityHeaders(),
  );
});

add("GET", "/files", async ({ request, env, ctx, url }) => {
  const user = await getSessionUser(env, request);
  if (!user) return redirect("/login");
  const filter = url.searchParams.get("filter") === "trash" ? "trash" : "live";
  const q = url.searchParams.get("q") || "";
  const sort = url.searchParams.get("sort") || "created_desc";
  const vis = url.searchParams.get("visibility") || "all";
  const page = url.searchParams.get("page") || 1;

  const data = await listRelayFiles(env, user.id, {
    page,
    perPage: 24,
    filter,
    q,
    sort,
    visibility: vis,
  });
  const folder = userFolderName(user.email);
  return html(
    relayPage(user, data.rows, data.page, data.totalPages, data.total, filter, folder, { q, sort, vis }),
    200,
    securityHeaders(),
  );
});

/** Load a relay file owned by the acting user (or 404/403). */
async function loadOwnRelay(env, request, id, ctx, raw = false) {
  const user = await resolveUser(env, request, ctx);
  if (!user) return { error: unauthorized() };
  const row = await loadOwnRelayFile(env, user.id, id, raw);
  if (!row) return { error: json({ error: "not_found" }, 404, securityHeaders()) };
  return { user, row };
}

add("GET", `/api/relay/(?<id>\\d+)`, async ({ request, env, ctx, params }) => {
  const { error, row } = await loadOwnRelay(env, request, params.id, ctx, true);
  if (error) return error;
  return json(relayJson(row), 200, securityHeaders());
});

add("PATCH", `/api/relay/(?<id>\\d+)`, async ({ request, env, ctx, params }) => {
  const { error, user, row } = await loadOwnRelay(env, request, params.id, ctx);
  if (error) return error;
  const body = (await readJson(request)) || {};
  let newName = row.original_name;
  let newVis = row.visibility;

  if (body.name != null) {
    try {
      newName = await renameRelayFile(env, row, body.name);
    } catch (e) {
      return relayFailure(e);
    }
  }
  if (body.visibility === "public" || body.visibility === "private") {
    newVis = body.visibility;
    await env.DB.prepare("UPDATE relay_files SET visibility = ? WHERE id = ?").bind(newVis, row.id).run();
  }
  return json({ ok: true, id: row.id, name: newName, visibility: newVis }, 200, securityHeaders());
});

add("DELETE", `/api/relay/(?<id>\\d+)`, async ({ request, env, ctx, params }) => {
  const { error, user, row } = await loadOwnRelay(env, request, params.id, ctx);
  if (error) return error;
  if (row.deleted) return json({ error: "not_live" }, 400, securityHeaders());
  await softDeleteRelayFile(env, user, row);
  logAudit(env, ctx, {
    action: "relay.delete",
    userId: user.id,
    email: user.email,
    target: String(row.id),
    detail: row.original_name,
    ip: getClientIp(request),
  });
  return json({ ok: true, id: row.id }, 200, securityHeaders());
});

add("POST", `/api/relay/(?<id>\\d+)/delete`, async ({ request, env, ctx, params }) => {
  const { error, user, row } = await loadOwnRelay(env, request, params.id, ctx);
  if (error) return error;
  if (row.deleted) return json({ error: "not_live" }, 400, securityHeaders());
  await softDeleteRelayFile(env, user, row);
  logAudit(env, ctx, {
    action: "relay.delete",
    userId: user.id,
    email: user.email,
    target: String(row.id),
    detail: row.original_name,
    ip: getClientIp(request),
  });
  return json({ ok: true, id: row.id }, 200, securityHeaders());
});

add("POST", `/api/relay/(?<id>\\d+)/restore`, async ({ request, env, ctx, params }) => {
  const { error, user, row } = await loadOwnRelay(env, request, params.id, ctx, true);
  if (error) return error;
  if (!row.deleted) return json({ error: "not_in_trash" }, 400, securityHeaders());
  try {
    await restoreRelayFile(env, user, row);
  } catch (e) {
    return relayFailure(e);
  }
  logAudit(env, ctx, {
    action: "relay.restore",
    userId: user.id,
    email: user.email,
    target: String(row.id),
    detail: row.original_name,
    ip: getClientIp(request),
  });
  return json({ ok: true, id: row.id }, 200, securityHeaders());
});

add("POST", `/api/relay/(?<id>\\d+)/purge`, async ({ request, env, ctx, params }) => {
  const { error, user, row } = await loadOwnRelay(env, request, params.id, ctx, true);
  if (error) return error;
  await purgeRelayFile(env, row);
  logAudit(env, ctx, {
    action: "relay.purge",
    userId: user.id,
    email: user.email,
    target: String(row.id),
    detail: row.original_name,
    ip: getClientIp(request),
  });
  return json({ ok: true, id: row.id }, 200, securityHeaders());
});

add("POST", `/api/relay/(?<id>\\d+)/rename`, async ({ request, env, ctx, params }) => {
  const { error, user, row } = await loadOwnRelay(env, request, params.id, ctx);
  if (error) return error;
  const form = await readForm(request);
  let name;
  try {
    name = await renameRelayFile(env, row, form?.name);
  } catch (e) {
    return relayFailure(e);
  }
  logAudit(env, ctx, {
    action: "relay.rename",
    userId: user.id,
    email: user.email,
    target: String(row.id),
    detail: name,
    ip: getClientIp(request),
  });
  return json({ ok: true, id: row.id, name }, 200, securityHeaders());
});

add("POST", "/api/relay/batch-visibility", async ({ request, env, ctx }) => {
  const user = await resolveUser(env, request, ctx);
  if (!user) return unauthorized();
  const body = await readJson(request);
  const ids = Array.isArray(body?.ids) ? body.ids.slice(0, 100).map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  if (!ids.length) return json({ error: "no_ids" }, 400, securityHeaders());
  const vis = body?.visibility === "public" ? "public" : "private";
  let count = 0;
  for (const id of ids) {
    const res = await env.DB.prepare(
      "UPDATE relay_files SET visibility = ? WHERE id = ? AND user_id = ? AND deleted = 0",
    )
      .bind(vis, id, user.id)
      .run();
    if (res.meta?.changes) count++;
  }
  logAudit(env, ctx, {
    action: "relay.batch_visibility",
    userId: user.id,
    email: user.email,
    target: `${count} files`,
    detail: `visibility=${vis}`,
    ip: getClientIp(request),
  });
  return json({ ok: true, count, visibility: vis }, 200, securityHeaders());
});

add("POST", "/api/relay/batch-delete", async ({ request, env, ctx }) => {
  const user = await resolveUser(env, request, ctx);
  if (!user) return unauthorized();
  const body = await readJson(request);
  const ids = Array.isArray(body?.ids) ? body.ids.slice(0, 100).map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  if (!ids.length) return json({ error: "no_ids" }, 400, securityHeaders());
  let deleted = 0;
  for (const id of ids) {
    const row = await loadOwnRelayFile(env, user.id, id);
    if (!row) continue;
    await softDeleteRelayFile(env, user, row);
    deleted++;
  }
  return json({ ok: true, deleted }, 200, securityHeaders());
});

add("POST", "/api/relay/batch-restore", async ({ request, env, ctx }) => {
  const user = await resolveUser(env, request, ctx);
  if (!user) return unauthorized();
  const body = await readJson(request);
  const ids = Array.isArray(body?.ids) ? body.ids.slice(0, 100).map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  if (!ids.length) return json({ error: "no_ids" }, 400, securityHeaders());
  let restored = 0;
  for (const id of ids) {
    const row = await loadOwnRelayFile(env, user.id, id, true);
    if (!row || !row.deleted) continue;
    try {
      await restoreRelayFile(env, user, row);
      restored++;
    } catch {
      // quota exceeded for this row: skip it, keep going
    }
  }
  return json({ ok: true, restored }, 200, securityHeaders());
});

add("POST", "/api/relay/batch-purge", async ({ request, env, ctx }) => {
  const user = await resolveUser(env, request, ctx);
  if (!user) return unauthorized();
  const body = await readJson(request);
  const ids = Array.isArray(body?.ids) ? body.ids.slice(0, 100).map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  if (!ids.length) return json({ error: "no_ids" }, 400, securityHeaders());
  let purged = 0;
  for (const id of ids) {
    const row = await loadOwnRelayFile(env, user.id, id, true);
    if (!row) continue;
    await purgeRelayFile(env, row);
    purged++;
  }
  return json({ ok: true, purged }, 200, securityHeaders());
});

add("GET", `/f/(?<id>\\d+)`, async ({ request, env, ctx, params }) => {
  const user = await getSessionUser(env, request);
  const row = await getRelayFile(env, params.id);
  return serveRelayFile(env, row, request, user?.id || null, ctx);
});

add("POST", `/api/relay/(?<id>\\d+)/share`, async ({ request, env, ctx, params }) => {
  const { error, user, row } = await loadOwnRelay(env, request, params.id, ctx);
  if (error) return error;
  const body = (await readJson(request)) || {};
  let days = Number(body?.days ?? 7);
  if (body?.days === 0 || body?.never === true) days = 0;
  else if (!Number.isInteger(days) || days < 1 || days > 365) days = 7;
  const share = await createRelayShare(env, user.id, row.id, days);
  logAudit(env, ctx, {
    action: "relay.share",
    userId: user.id,
    email: user.email,
    target: String(row.id),
    detail: `token=${share.token} days=${days}`,
    ip: getClientIp(request),
  });
  return json(share, 201, securityHeaders());
});

add("GET", `/api/relay/(?<id>\\d+)/shares`, async ({ request, env, ctx, params }) => {
  const { error, row } = await loadOwnRelay(env, request, params.id, ctx);
  if (error) return error;
  const shares = await listRelayShares(env, row.id);
  return json({ shares }, 200, securityHeaders());
});

add("DELETE", `/api/relay/shares/(?<id>\\d+)`, async ({ request, env, ctx, params }) => {
  const user = await resolveUser(env, request, ctx);
  if (!user) return unauthorized();
  const ok = await revokeRelayShare(env, user.id, params.id);
  if (!ok) return json({ error: "not_found" }, 404, securityHeaders());
  return json({ ok: true }, 200, securityHeaders());
});

add("GET", `/f/s/(?<token>[A-Za-z0-9_-]{22})`, async ({ request, env, ctx, params }) => {
  try {
    const resolved = await resolveRelayShare(env, params.token);
    if (resolved.error) {
      return json({ error: resolved.message }, resolved.error, securityHeaders());
    }
    const { row } = resolved;
    const etag = `W/"fshare-${row.token}-${row.size_bytes}"`;
    if (request.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { etag, ...securityHeaders() } });
    }

    const upstream = await downloadFile(env, row.drive_file_id, request.headers.get("range"));
    if (upstream.status === 404) return json({ error: "not_found" }, 404, securityHeaders());

    const headers = new Headers(upstream.headers);
    headers.set("content-type", row.mime_type || "application/octet-stream");
    headers.set("etag", etag);
    headers.set("x-content-type-options", "nosniff");

    const url = new URL(request.url);
    const forceDownload = url.searchParams.get("download") === "1";
    const isSafeRaster = !forceDownload && /^(image\/(jpeg|png|gif|webp|avif))$/i.test(row.mime_type);
    if (isSafeRaster) {
      headers.set("content-disposition", "inline");
    } else {
      headers.set("content-disposition", formatContentDisposition("attachment", row.original_name));
    }
    headers.set("cache-control", "public, max-age=3600");
    for (const [k, v] of Object.entries(securityHeaders())) headers.set(k, v);

    if (ctx?.waitUntil) {
      ctx.waitUntil(
        env.DB.prepare("UPDATE relay_shares SET views = views + 1 WHERE id = ?").bind(row.id).run(),
      );
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (e) {
    return json({ error: "share_failed", message: String(e.message || e) }, 500, securityHeaders());
  }
});

/* ---------------- remote URL upload (v1.9) ---------------- */

add("POST", "/api/upload-url", async ({ request, env, ctx }) => {
  const user = await resolveUser(env, request, ctx);
  if (!user) return unauthorized();
  const rl = await rateLimit(env, `apiupload:${user.id}`, 60, 3600);
  if (!rl.allowed) {
    return json({ error: "rate_limited", retry_after: rl.retryAfter }, 429, securityHeaders());
  }
  const body = await readJson(request);
  const url = String(body?.url || "").trim();
  if (!url) return badRequest("url is required");
  const visibility = body?.visibility === "public" ? "public" : "private";
  const maxBytes = (Number(env.MAX_UPLOAD_MB) || 20) * 1024 * 1024;
  try {
    const remote = await fetchRemoteImage(url, maxBytes);
    const row = await uploadImage(env, user, {
      buffer: remote.buffer,
      originalName: remote.name,
      visibility,
    });
    return json(
      {
        id: row.public_id,
        url: row.url,
        original_name: row.original_name,
        mime_type: row.mime_type,
        size_bytes: row.size_bytes,
        visibility: row.visibility,
        created_at: row.created_at,
        source: "url",
      },
      201,
      securityHeaders(),
    );
  } catch (e) {
    return uploadFailure(e);
  }
});

/* ---------------- data portability (v1.22) ---------------- */

add("GET", "/api/export", async ({ request, env, ctx, url }) => {
  const user = await resolveUser(env, request, ctx);
  if (!user) return unauthorized();
  const rows = await exportRows(env, user.id);
  const format = url.searchParams.get("format") === "csv" ? "csv" : "json";
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === "csv") {
    // BOM so Excel opens UTF-8 filenames correctly.
    const csv = "\uFEFF" + toCsv(rows);
    return new Response(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="cf2gdrive-${stamp}.csv"`,
        ...securityHeaders(),
      },
    });
  }
  return new Response(
    JSON.stringify(
      {
        name: "cf2gdrive",
        version: VERSION,
        exported_at: new Date().toISOString(),
        account: { email: user.email, images: rows.length, bytes: sumBytes(rows) },
        items: rows,
      },
      null,
      2,
    ),
    {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="cf2gdrive-${stamp}.json"`,
        ...securityHeaders(),
      },
    },
  );
});

add("POST", "/api/import", async ({ request, env, ctx }) => {
  const user = await resolveUser(env, request, ctx);
  if (!user) return unauthorized();
  const rl = await rateLimit(env, `apiimport:${user.id}`, 20, 3600);
  if (!rl.allowed) {
    return json({ error: "rate_limited", retry_after: rl.retryAfter }, 429, securityHeaders());
  }
  const body = await readJson(request);
  const defaultVis = body?.visibility === "public" ? "public" : "private";
  const parsed = body?.items
    ? { items: Array.isArray(body.items) ? body.items : [], skipped: 0, error: null }
    : parseImport(body?.text, defaultVis);
  if (parsed.error) return json({ error: parsed.error }, 400, securityHeaders());
  const items = parsed.items.slice(0, 50);
  if (!items.length) return json({ error: "no_items" }, 400, securityHeaders());

  const maxBytes = (Number(env.MAX_UPLOAD_MB) || 20) * 1024 * 1024;
  const results = [];
  let ok = 0;
  for (const item of items) {
    const url0 = String(typeof item === "string" ? item : item?.url || "").trim();
    const vis = item?.visibility === "public" ? "public" : item?.visibility === "private" ? "private" : defaultVis;
    if (!url0) {
      results.push({ url: "", ok: false, error: "bad_url" });
      continue;
    }
    if (user.used_bytes + Number(sumImportedBytes(results)) > user.quota_bytes) {
      results.push({ url: url0, ok: false, error: "quota_exceeded" });
      continue;
    }
    try {
      const remote = await fetchRemoteImage(url0, maxBytes);
      const row = await uploadImage(env, user, {
        buffer: remote.buffer,
        originalName: item?.name ? String(item.name) : remote.name,
        visibility: vis,
      });
      ok++;
      logAudit(env, ctx, { action: "upload", userId: user.id, email: user.email, target: row.public_id, detail: `${row.original_name} (import)` });
      results.push({ url: url0, ok: true, id: row.public_id, name: row.original_name, size_bytes: row.size_bytes });
    } catch (e) {
      results.push({
        url: url0,
        ok: false,
        error: codedError(e) ? e.code : "upload_failed",
        message: String(e.message || "").slice(0, 160),
      });
    }
  }
  const skippedQuota = results.filter((r) => r.error === "quota_exceeded").length;
  return json(
    { ok: true, requested: items.length, imported: ok, failed: items.length - ok, skipped_quota: skippedQuota, results },
    200,
    securityHeaders(),
  );
});

/** Bytes already consumed by successfully imported items in this batch. */
function sumImportedBytes(results) {
  return results.reduce((acc, r) => acc + (r.ok ? Number(r.size_bytes) || 0 : 0), 0);
}

/* ---------------- REST API (v0.7) ---------------- */


function imageJson(im) {
  let exif = null;
  if (im.exif) {
    try {
      exif = JSON.parse(im.exif);
    } catch {
      exif = null;
    }
  }
  return {
    id: im.public_id,                 // v1.25: the only id clients ever see
    url: `/i/${im.public_id}`,
    thumbnail: `/t/${im.public_id}`,
    original_name: im.original_name,
    mime_type: im.mime_type,
    size_bytes: im.size_bytes,
    visibility: im.visibility,
    views: im.views,
    created_at: im.created_at,
    deleted: !!im.deleted,
    exif,
    storage_path: im.storage_path || null, // v1.24: "<prefix>/<bucket>/<name>"
  };
}

add("GET", "/api/images", async ({ request, env, ctx, url }) => {
  const user = await resolveUser(env, request, ctx);
  if (!user) return unauthorized();
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(url.searchParams.get("per_page") || "30", 10) || 30));
  const filters = parseImageFilters(url);
  const q = imageListQuery(filters, user.id);
  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM images WHERE ${q.where}`,
  )
    .bind(...q.binds)
    .first();
  const total = countRow?.c || 0;
  const { results } = await env.DB.prepare(
    `SELECT * FROM images WHERE ${q.where}
     ORDER BY ${q.order} LIMIT ? OFFSET ?`,
  )
    .bind(...q.binds, perPage, (page - 1) * perPage)
    .all();
  return json(
    {
      images: (results || []).map(imageJson),
      total,
      page,
      per_page: perPage,
      pages: Math.max(1, Math.ceil(total / perPage)),
      query: { q: filters.q, visibility: filters.vis, sort: filters.sort },
    },
    200,
    securityHeaders(),
  );
});

add("GET", `/api/images/(?<slug>${SLUG_PATTERN})`, async ({ request, env, ctx, params }) => {
  const user = await resolveUser(env, request, ctx);
  if (!user) return unauthorized();
  const image = await env.DB.prepare("SELECT * FROM images WHERE public_id = ?")
    .bind(params.slug)
    .first();
  if (!image || image.deleted || image.user_id !== user.id) {
    return json({ error: "not_found" }, 404, securityHeaders());
  }
  return json(imageJson(image), 200, securityHeaders());
});

add("DELETE", `/api/images/(?<slug>${SLUG_PATTERN})`, async ({ request, env, ctx, params }) => {
  const { error, user, image } = await loadOwnImage(env, request, params.slug, ctx);
  if (error) return error;
  await softDeleteImage(env, user, image);
  return json({ ok: true, id: image.public_id }, 200, securityHeaders());
});

/** v1.19: PATCH accepts name and/or visibility (at least one). */
add("PATCH", `/api/images/(?<slug>${SLUG_PATTERN})`, async ({ request, env, ctx, params }) => {
  const { error, user, image } = await loadOwnImage(env, request, params.slug, ctx);
  if (error) return error;
  const body = await readJson(request);
  const hasName = body && body.name !== undefined;
  const hasVis = body && body.visibility !== undefined;
  if (!hasName && !hasVis) return json({ error: "no_fields" }, 400, securityHeaders());

  let safe = image.original_name;
  if (hasName) {
    const raw = String(body.name || "").trim();
    if (!raw || raw.length > 120) return json({ error: "bad_name" }, 400, securityHeaders());
    safe = raw.replace(/[\x00-\x1f\x7f]/g, "").replace(/[\\/]/g, "_").slice(0, 120);
  }
  let vis = image.visibility;
  if (hasVis) {
    if (body.visibility !== "public" && body.visibility !== "private") {
      return json({ error: "bad_visibility" }, 400, securityHeaders());
    }
    vis = body.visibility;
  }
  await env.DB.prepare("UPDATE images SET original_name = ?, visibility = ? WHERE id = ?")
    .bind(safe, vis, image.id)
    .run();
  return json({ ok: true, id: image.public_id, name: safe, visibility: vis }, 200, securityHeaders());
});

/** v1.19: batch visibility toggle — {ids:[...], visibility:"public"|"private"}. */
add("POST", "/api/images/batch-visibility", async ({ request, env, ctx }) => {
  const user = await resolveUser(env, request, ctx);
  if (!user) return unauthorized();
  const body = await readJson(request);
  const ids = idList(body, 100);
  const vis = body?.visibility;
  if (!ids.length) return json({ error: "no_ids" }, 400, securityHeaders());
  if (vis !== "public" && vis !== "private") return json({ error: "bad_visibility" }, 400, securityHeaders());
  let updated = 0;
  for (const id of ids) {
    const res = await env.DB.prepare(
      "UPDATE images SET visibility = ? WHERE public_id = ? AND user_id = ? AND deleted = 0",
    )
      .bind(vis, String(id), user.id)
      .run();
    updated += res.meta?.changes || 0;
  }
  return json({ ok: true, updated, visibility: vis }, 200, securityHeaders());
});

/** v1.19: batch restore from trash — {ids:[...]}. */
add("POST", "/api/images/batch-restore", async ({ request, env, ctx }) => {
  const user = await resolveUser(env, request, ctx);
  if (!user) return unauthorized();
  const body = await readJson(request);
  const ids = idList(body, 100);
  if (!ids.length) return json({ error: "no_ids" }, 400, securityHeaders());
  let restored = 0;
  for (const id of ids) {
    const image = await env.DB.prepare(
      "SELECT * FROM images WHERE public_id = ? AND user_id = ? AND deleted = 1",
    )
      .bind(String(id), user.id)
      .first();
    if (!image) continue;
    // Quota re-check: a restore can push the account over its limit.
    if (user.used_bytes + image.size_bytes > user.quota_bytes) continue;
    await env.DB.prepare("UPDATE images SET deleted = 0, deleted_at = NULL WHERE id = ?")
      .bind(image.id)
      .run();
    await env.DB.prepare("UPDATE users SET used_bytes = used_bytes + ? WHERE id = ?")
      .bind(image.size_bytes, user.id)
      .run();
    restored++;
  }
  return json({ ok: true, restored }, 200, securityHeaders());
});

/** v1.19: batch permanent delete from trash — {ids:[...]}. */
add("POST", "/api/images/batch-purge", async ({ request, env, ctx }) => {
  const user = await resolveUser(env, request, ctx);
  if (!user) return unauthorized();
  const body = await readJson(request);
  const ids = idList(body, 100);
  if (!ids.length) return json({ error: "no_ids" }, 400, securityHeaders());
  let purged = 0;
  for (const id of ids) {
    const image = await env.DB.prepare(
      "SELECT * FROM images WHERE public_id = ? AND user_id = ? AND deleted = 1",
    )
      .bind(String(id), user.id)
      .first();
    if (!image) continue;
    await purgeImage(env, image);
    purged++;
  }
  return json({ ok: true, purged }, 200, securityHeaders());
});

/** v1.19: service descriptor — version, limits, enumerations, error codes. */
add("GET", "/api/meta", ({ env }) => {
  const maxMb = Number(env.MAX_UPLOAD_MB) || 20;
  return json(
    {
      name: "cf2gdrive",
      version: VERSION,
      limits: {
        upload_max_bytes: maxMb * 1024 * 1024,
        remote_fetch_max_bytes: maxMb * 1024 * 1024,
        remote_fetch_timeout_ms: 15000,
        remote_fetch_max_redirects: 5,
        batch_max_ids: 100,
        list_per_page_max: 100,
        name_max_chars: 120,
        share_expiry_days_max: 3650,
      },
      enums: {
        visibility: ["private", "public"],
        sorts: Object.keys(IMAGE_SORTS),
        share_expiry: ["1", "7", "30", "never"],
        audit_actions: Object.keys(AUDIT_LABELS),
      },
      endpoints: {
        upload: "POST /api/upload (multipart: file, visibility)",
        upload_url: "POST /api/upload-url (json: url, visibility)",
        list: "GET /api/images?q=&vis=&sort=&page=&per_page=",
        patch: "PATCH /api/images/:id (json: name?, visibility?)",
        batch: [
          "POST /api/images/batch-delete",
          "POST /api/images/batch-restore",
          "POST /api/images/batch-purge",
          "POST /api/images/batch-visibility",
        ],
        share: "POST /api/images/:id/share (json: expires_in_days | never)",
        sessions: "GET /api/sessions · DELETE /api/sessions/:id",
        stats: "GET /api/stats",
        data: [
          "GET /api/export?format=csv|json",
          "POST /api/import (json: text | items[], visibility)",
        ],
        explore: ["GET /explore?page=", "GET /api/public/images?page=&per_page="],
        relay: {
          page: "GET /files (web page)",
          upload: "POST /api/relay/upload (multipart: file, visibility? | json: url, visibility?)",
          list: "GET /api/relay?q=&visibility=&sort=&page=&per_page=&filter=",
          get: "GET /api/relay/:id",
          patch: "PATCH /api/relay/:id (json: name?, visibility?)",
          delete: "DELETE /api/relay/:id · POST /api/relay/:id/delete",
          restore: "POST /api/relay/:id/restore",
          purge: "POST /api/relay/:id/purge",
          batch: [
            "POST /api/relay/batch-delete",
            "POST /api/relay/batch-restore",
            "POST /api/relay/batch-purge",
          ],
          shares: [
            "POST /api/relay/:id/share (json: days)",
            "GET /api/relay/:id/shares",
            "DELETE /api/relay/shares/:id",
          ],
          serve: "GET /f/:id (direct) · GET /f/s/:token (temporary share token)",
          note: "Dedicated file relay subsystem with its own table, quota, and per-user email directory",
        },
      },
      auth: ["session cookie (browser)", "Authorization: Bearer <api key>"],
      ids: {
        format: "12 lowercase hex characters (48 bit random) — the `id` field in every response and the token in every image URL",
        example: "/i/9f3c2d1e4a5b",
        pattern: SLUG_PATTERN,
        note: "integer row ids are internal only: /i/65 and /api/images/65 return 404, so images cannot be enumerated",
      },
      storage: {
        layout: "<drive_root>/<md5(email)[0:4]>/<bucket 1-255>/<8-char id>.<ext>",
        shard_key: "md5(username)[0:4] where username = the account email (lowercased)",
        max_files_per_dir: MAX_FILES_PER_DIR,
        max_dirs_per_prefix: MAX_DIRS,
        capacity_per_user: MAX_DIRS * MAX_FILES_PER_DIR,
        id_chars: ID_LEN,
        note: "counters are cached in D1 storage_dirs; directories are created on first use",
      },
      security: {
        csrf: "cookie-authenticated writes require a same-origin Origin/Referer (403 cross_origin otherwise); Bearer calls are exempt",
        cookie: "picbed_session; HttpOnly; Secure; SameSite=Lax; Path=/",
        headers: [
          "content-security-policy",
          "strict-transport-security",
          "x-content-type-options",
          "x-frame-options",
          "referrer-policy",
          "permissions-policy",
        ],
        upload_types: ["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"],
        api_key_expiry_days_max: 3650,
        rate_limits: {
          login: "10 / 5min per IP",
          register: "5 / hour per IP",
          api_upload: "60 / hour per user",
          api_key_create: "10 / hour per user",
          invite_create: "60 / hour per admin",
        },
      },
    },
    200,
    securityHeaders(),
  );
});

add("GET", "/api/stats", async ({ request, env, ctx }) => {
  const user = await resolveUser(env, request, ctx);
  if (!user) return unauthorized();
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM images WHERE user_id = ? AND deleted = 0) AS images,
       (SELECT COALESCE(SUM(size_bytes),0) FROM images WHERE user_id = ? AND deleted = 0) AS bytes,
       (SELECT COUNT(*) FROM images WHERE user_id = ? AND deleted = 1) AS trashed,
       (SELECT COUNT(*) FROM images WHERE user_id = ? AND deleted = 0 AND visibility = 'public') AS pub,
       (SELECT COUNT(*) FROM images WHERE user_id = ? AND deleted = 0 AND visibility = 'private') AS priv,
       (SELECT COUNT(*) FROM images WHERE user_id = ? AND deleted = 0 AND created_at >= datetime('now','-30 days')) AS recent,
       (SELECT COUNT(*) FROM share_links WHERE created_by = ? AND revoked = 0) AS shares,
       (SELECT COUNT(*) FROM sessions WHERE user_id = ?) AS sessions`,
  )
    .bind(user.id, user.id, user.id, user.id, user.id, user.id, user.id, user.id)
    .first();
  return json(
    {
      images: row.images,
      used_bytes: user.used_bytes,
      quota_bytes: user.quota_bytes,
      trashed: row.trashed,
      public_count: row.pub,
      private_count: row.priv,
      uploaded_last_30d: row.recent,
      active_shares: row.shares,
      active_sessions: row.sessions,
    },
    200,
    securityHeaders(),
  );
});

/* ---------------- API keys (v0.7) ---------------- */

add("GET", "/api/keys", async ({ request, env, ctx }) => {
  const user = await resolveUser(env, request, ctx);
  if (!user) return unauthorized();
  const keys = await listApiKeys(env, user.id);
  return json({ keys }, 200, securityHeaders());
});

add("POST", "/api/keys", async ({ request, env, ctx }) => {
  const user = await resolveUser(env, request, ctx);
  if (!user) return unauthorized();
  const rl = await rateLimit(env, `apikey:${user.id}`, 10, 3600);
  if (!rl.allowed) {
    return json({ error: "rate_limited", retry_after: rl.retryAfter }, 429, securityHeaders());
  }
  const body = (await readJson(request)) || {};
  const existing = await listApiKeys(env, user.id);
  if (existing.length >= 10) {
    return json({ error: "too_many_keys", max: 10 }, 400, securityHeaders());
  }
  const created = await createApiKey(env, user.id, body.name, body.expires_in_days);
  return json(
    {
      id: created.id,
      key: created.key, // shown once
      prefix: created.prefix,
      name: created.name,
      expires_at: created.expires_at,
      warning: "store this key now; it cannot be retrieved later",
    },
    201,
    securityHeaders(),
  );
});

add("DELETE", "/api/keys/(?<id>\\d+)", async ({ request, env, ctx, params }) => {
  const user = await resolveUser(env, request, ctx);
  if (!user) return unauthorized();
  const ok = await revokeApiKey(env, user.id, params.id);
  if (!ok) return json({ error: "not_found" }, 404, securityHeaders());
  return json({ ok: true, id: Number(params.id) }, 200, securityHeaders());
});

/* ---------------- keys management page (v0.7) ---------------- */

add("GET", "/keys", async ({ request, env, ctx }) => {
  const user = await getSessionUser(env, request);
  if (!user) return redirect("/login");
  const keys = await listApiKeys(env, user.id);
  const rows = keys.length
    ? keys
        .map(
          (k) => `<tr>
      <td>${escapeHtml(k.name)}</td>
      <td><code>${escapeHtml(k.key_prefix)}…</code></td>
      <td>${escapeHtml((k.created_at || "").slice(0, 19))}</td>
      <td>${k.expires_at ? escapeHtml(String(k.expires_at).slice(0, 19)) + (k.expired ? ' <b style="color:#dc2626">已过期</b>' : "") : "永不过期"}</td>
      <td>${escapeHtml((k.last_used_at || "从未").slice(0, 19))}</td>
      <td><button onclick="revoke(${k.id})">吊销</button></td>
    </tr>`,
        )
        .join("")
    : `<tr><td colspan="6" style="color:#6b7280">还没有密钥，在下方创建第一个</td></tr>`;
  return html(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>API 密钥 · cf2gdrive</title>
<style>
body{font-family:system-ui,sans-serif;background:#f6f7f9;margin:0}
header{background:#fff;border-bottom:1px solid #e3e6ea;padding:0 20px;height:52px;display:flex;align-items:center;gap:18px}
header .brand{font-weight:700;color:#2563eb;text-decoration:none}
header a{color:#1f2328;text-decoration:none;font-size:14px}
main{max-width:860px;margin:24px auto;padding:0 16px}
.card{background:#fff;border:1px solid #e3e6ea;border-radius:10px;padding:20px;margin-bottom:16px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #eef1f4}
button{padding:6px 12px;border:1px solid #e3e6ea;border-radius:6px;background:#fff;cursor:pointer;font-size:13px}
.create{display:flex;gap:8px}
.create input{flex:1;padding:8px 10px;border:1px solid #ccd2d9;border-radius:6px;font-size:14px}
.create select{padding:8px 10px;border:1px solid #ccd2d9;border-radius:6px;font-size:14px;background:#fff}
.create button{background:#2563eb;color:#fff;border:0}
.newkey{background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:12px;margin-top:12px;word-break:break-all;font-family:ui-monospace,monospace;font-size:13px;display:none}
</style></head>
<body>
<header><a class="brand" href="/">cf2gdrive</a><a href="/gallery">图库</a><a href="/keys">API 密钥</a><a href="/docs">API 文档</a></header>
<main>
<div class="card">
  <h3 style="margin-top:0">API 密钥</h3>
  <p style="font-size:13px;color:#6b7280">用 <code>Authorization: Bearer &lt;key&gt;</code> 调用 API。密钥只在创建时展示一次。</p>
  <table><thead><tr><th>名称</th><th>前缀</th><th>创建时间</th><th>有效期</th><th>最近使用</th><th></th></tr></thead>
  <tbody>${rows}</tbody></table>
</div>
<div class="card">
  <h3 style="margin-top:0">创建新密钥</h3>
  <div class="create">
    <input id="kname" placeholder="密钥名称（如：pico-uploader）" maxlength="60">
    <select id="kexp">
      <option value="0">永不过期</option>
      <option value="30">30 天</option>
      <option value="90">90 天</option>
      <option value="365">1 年</option>
    </select>
    <button onclick="create()">创建</button>
  </div>
  <div class="newkey" id="newkey"></div>
</div>
</main>
<script>
async function create() {
  const name = document.getElementById('kname').value.trim();
  const days = Number(document.getElementById('kexp').value) || 0;
  const r = await fetch('/api/keys', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({name, expires_in_days: days})});
  const j = await r.json();
  if (!r.ok) { alert('创建失败: ' + (j.error || '')); return; }
  const box = document.getElementById('newkey');
  box.style.display = 'block';
  box.textContent = j.key + '\\n\\n（已复制到剪贴板，请妥善保存' + (j.expires_at ? '；有效期至 ' + j.expires_at.slice(0,10) : '') + '）';
  navigator.clipboard.writeText(j.key);
  setTimeout(() => location.reload(), 3000);
}
async function revoke(id) {
  if (!confirm('确定吊销该密钥？使用它的调用将立即失效。')) return;
  const r = await fetch('/api/keys/' + id, {method:'DELETE'});
  if (r.ok) location.reload(); else alert('吊销失败');
}
</script>
</body></html>`,
  );
});

/* ---------------- trash / restore / purge (v0.8) ---------------- */

/** Like loadOwnImage but also finds soft-deleted images. */
async function loadOwnImageRaw(env, request, id, ctx) {
  const user = await resolveUser(env, request, ctx);
  if (!user) return { error: unauthorized() };
  const image = await env.DB.prepare("SELECT * FROM images WHERE public_id = ?")
    .bind(String(id))
    .first();
  if (!image || image.user_id !== user.id) {
    return { error: json({ error: "not_found" }, 404, securityHeaders()) };
  }
  return { user, image };
}

async function restoreImage(env, user, image) {
  const fresh = await env.DB.prepare(
    "SELECT quota_bytes, used_bytes FROM users WHERE id = ?",
  )
    .bind(user.id)
    .first();
  if (fresh.used_bytes + image.size_bytes > fresh.quota_bytes) {
    return { error: json({ error: "quota_exceeded" }, 413, securityHeaders()) };
  }
  await env.DB.prepare("UPDATE images SET deleted = 0, deleted_at = NULL WHERE id = ?")
    .bind(image.id)
    .run();
  await env.DB.prepare("UPDATE users SET used_bytes = used_bytes + ? WHERE id = ?")
    .bind(image.size_bytes, user.id)
    .run();
  return { ok: true };
}

async function purgeImage(env, image) {
  try {
    await deleteFile(env, image.drive_file_id);
  } catch {
    // Drive copy already gone; proceed with metadata cleanup.
  }
  await env.DB.prepare("DELETE FROM images WHERE id = ?").bind(image.id).run();
  // v1.24: the shard slot is only freed when the bytes are gone.
  if (image.dir_id) await releaseStorageDir(env, image.dir_id);
}

/* ---------------- trash auto-cleanup (v1.11) ---------------- */

/** Trash retention in days (0 = never auto-purge). */
async function trashRetentionDays(env) {
  return getSettingInt(env, "trash_retention_days", 0, 3650);
}

/** v1.23: whether the anonymous public gallery is served. */
async function exploreEnabled(env) {
  return (await getSettingInt(env, "explore_enabled", 0, 1)) === 1;
}

/** Purge soft-deleted images whose deleted_at is older than `days`.
 *  Bounded per run (LIMIT) so one invocation stays within platform limits.
 *  Returns the number of purged rows. days <= 0 disables the sweep.
 *  NOTE: deleted_at is written in two shapes across the codebase (JS ISO
 *  "…T…Z" from the app, SQLite "… …" from raw SQL) — string comparison would
 *  silently mis-order them, so compare via julianday() which parses both. */
async function sweepTrash(env, days) {
  if (!days || days <= 0) return 0;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT id, drive_file_id FROM images
     WHERE deleted = 1 AND deleted_at IS NOT NULL AND julianday(deleted_at) < julianday(?)
     ORDER BY deleted_at LIMIT 200`,
  )
    .bind(cutoff)
    .all();
  for (const im of results || []) await purgeImage(env, im);
  return (results || []).length;
}

add("GET", "/trash", async ({ request, env, ctx }) => {
  const user = await getSessionUser(env, request);
  if (!user) return redirect("/login");
  const { results } = await env.DB.prepare(
    "SELECT * FROM images WHERE user_id = ? AND deleted = 1 ORDER BY deleted_at DESC",
  )
    .bind(user.id)
    .all();
  return html(trashPage(user, results || [], await trashRetentionDays(env)));
});

add("POST", `/images/(?<slug>${SLUG_PATTERN})/restore`, async ({ request, env, ctx, params }) => {
  const { error, user, image } = await loadOwnImageRaw(env, request, params.slug, ctx);
  if (error) return error;
  if (!image.deleted) return json({ error: "not_in_trash" }, 400, securityHeaders());
  const res = await restoreImage(env, user, image);
  if (res.error) return res.error;
  return json({ ok: true, id: image.public_id }, 200, securityHeaders());
});

add("POST", `/images/(?<slug>${SLUG_PATTERN})/purge`, async ({ request, env, ctx, params }) => {
  const { error, user, image } = await loadOwnImageRaw(env, request, params.slug, ctx);
  if (error) return error;
  await purgeImage(env, image);
  return json({ ok: true, id: image.public_id }, 200, securityHeaders());
});

add("POST", "/images/purge-all", async ({ request, env, ctx }) => {
  const user = await getSessionUser(env, request);
  if (!user) return unauthorized();
  const { results } = await env.DB.prepare(
    "SELECT * FROM images WHERE user_id = ? AND deleted = 1",
  )
    .bind(user.id)
    .all();
  let purged = 0;
  for (const im of results || []) {
    await purgeImage(env, im);
    purged++;
  }
  return json({ ok: true, purged }, 200, securityHeaders());
});

add("POST", "/api/images/batch-delete", async ({ request, env, ctx }) => {
  const user = await resolveUser(env, request, ctx);
  if (!user) return unauthorized();
  const body = await readJson(request);
  const ids = idList(body, 50);
  if (!ids.length) return json({ error: "no_ids" }, 400, securityHeaders());
  let deleted = 0;
  for (const id of ids) {
    const image = await env.DB.prepare(
      "SELECT * FROM images WHERE public_id = ? AND user_id = ? AND deleted = 0",
    )
      .bind(String(id), user.id)
      .first();
    if (image) {
      await softDeleteImage(env, user, image);
      deleted++;
    }
  }
  return json({ ok: true, deleted }, 200, securityHeaders());
});

add("GET", "/api/trash", async ({ request, env, ctx }) => {
  const user = await resolveUser(env, request, ctx);
  if (!user) return unauthorized();
  const { results } = await env.DB.prepare(
    "SELECT * FROM images WHERE user_id = ? AND deleted = 1 ORDER BY deleted_at DESC",
  )
    .bind(user.id)
    .all();
  return json({ images: (results || []).map(imageJson) }, 200, securityHeaders());
});

add("POST", `/api/images/(?<slug>${SLUG_PATTERN})/restore`, async ({ request, env, ctx, params }) => {
  const { error, user, image } = await loadOwnImageRaw(env, request, params.slug, ctx);
  if (error) return error;
  if (!image.deleted) return json({ error: "not_in_trash" }, 400, securityHeaders());
  const res = await restoreImage(env, user, image);
  if (res.error) return res.error;
  return json({ ok: true, id: image.public_id }, 200, securityHeaders());
});

add("DELETE", `/api/images/(?<slug>${SLUG_PATTERN})/purge`, async ({ request, env, ctx, params }) => {
  const { error, user, image } = await loadOwnImageRaw(env, request, params.slug, ctx);
  if (error) return error;
  await purgeImage(env, image);
  return json({ ok: true, id: image.public_id }, 200, securityHeaders());
});

/* ---------------- admin (v0.8 / invites v1.2) ---------------- */

/** Resolve the acting admin from the session, or a ready-made 403/redirect. */
async function requireAdmin(env, request) {
  const user = await getSessionUser(env, request);
  if (!user) return { redirect: redirect("/login") };
  if (user.role !== "admin") {
    return {
      forbidden: html(
        `<!doctype html><html><body style="font-family:system-ui;padding:60px;text-align:center">
         <h2>403 — 需要管理员权限</h2><p><a href="/gallery">返回图库</a></p></body></html>`,
        403,
      ),
    };
  }
  return { user };
}

add("GET", "/admin", async ({ request, env, ctx, url }) => {
  const gate = await requireAdmin(env, request);
  if (gate.redirect) return gate.redirect;
  if (gate.forbidden) return gate.forbidden;
  const user = gate.user;

  // v1.16: user list filters (q on email/display_name, status whitelist)
  const uq = (url.searchParams.get("q") || "").trim().slice(0, 100);
  const ustatus = url.searchParams.get("status");
  const uFilters = { q: uq, status: ustatus === "active" || ustatus === "disabled" ? ustatus : "" };
  let uwhere = "1 = 1";
  const ubinds = [];
  if (uFilters.q) {
    const like = `%${uFilters.q.replace(/[%_\\]/g, (c) => "\\" + c)}%`;
    uwhere += " AND (u.email LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\')";
    ubinds.push(like, like);
  }
  if (uFilters.status) {
    uwhere += " AND u.status = ?";
    ubinds.push(uFilters.status);
  }
  // v1.20: user list + site totals + invite codes in one batched round trip
  // (previously three sequential D1 calls; settings come from a 30s cache).
  const [usersRes, sysRes, invitesRes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT u.id, u.email, u.display_name, u.role, u.status, u.quota_bytes, u.used_bytes,
              u.created_at,
              (SELECT COUNT(*) FROM images i WHERE i.user_id = u.id AND i.deleted = 0) AS images,
              (SELECT COALESCE(SUM(size_bytes),0) FROM images i WHERE i.user_id = u.id AND i.deleted = 0) AS bytes
       FROM users u WHERE ${uwhere} ORDER BY u.id`,
    ).bind(...ubinds),
    env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM users) AS users,
              (SELECT COUNT(*) FROM images WHERE deleted = 0) AS images,
              (SELECT COALESCE(SUM(size_bytes),0) FROM images WHERE deleted = 0) AS bytes`,
    ),
    inviteListStatement(env),
  ]);
  const users = usersRes.results || [];
  const sys = sysRes.results?.[0] || { users: 0, images: 0, bytes: 0 };
  const invites = (invitesRes.results || []).map((i) => ({ ...i, status: inviteStatus(i) }));
  const defaultQuota = await getSettingBytes(env, "default_quota_bytes");
  const trashRetention = await trashRetentionDays(env);
  const NOTICE = {
    settings_saved: { ok: "设置已保存（默认配额影响此后注册的新用户；回收站策略立即生效）" },
    quota_saved: { ok: "用户配额已更新" },
    bad_quota: { err: "配额格式不正确，请使用如 500G / 1.5T 的写法" },
    bad_retention: { err: "回收站保留天数需为 0–3650 的整数（0 = 永不自动清理）" },
    no_user: { err: "目标用户不存在" },
    quota_below_used: { err: "配额不能小于该用户当前已用空间" },
    self_lock: { err: "不能对自己执行该操作" },
    last_admin: { err: "至少需要保留一名活跃管理员" },
    user_disabled: { ok: "用户已禁用，其所有会话已立即失效" },
    user_enabled: { ok: "用户已启用" },
    user_deleted: { ok: "用户及其全部数据已删除（云端文件后台清理中）" },
  };
  const msgKey = url.searchParams.get("msg");
  let notice = NOTICE[msgKey] || NOTICE[url.searchParams.get("err")] || null;
  if (msgKey === "trash_swept") {
    const n = Math.max(0, parseInt(url.searchParams.get("n") || "0", 10) || 0);
    notice = { ok: `回收站清理完成：已彻底删除 ${n} 项（含 Drive 云端文件，不可恢复）` };
  }
  return html(adminPage(user, users || [], sys, invites, url.searchParams.get("invite") || "", defaultQuota, trashRetention, notice, uFilters, await exploreEnabled(env)));
});

add("POST", "/admin/settings", async ({ request, env, ctx }) => {
  if (!sameOrigin(request)) return badRequest("cross-origin post rejected");
  const gate = await requireAdmin(env, request);
  if (gate.redirect) return gate.redirect;
  if (gate.forbidden) return gate.forbidden;

  const form = await readForm(request);
  // v1.11: the settings form carries both fields; each is optional so the
  // quota-only and retention-only posts both work.
  if (form?.default_quota) {
    const quota = parseSize(form.default_quota);
    if (!quota) return redirect(adminUsersUrl(request, "err=bad_quota"));
    await setSetting(env, "default_quota_bytes", quota);
  }
  const rawDays = String(form?.trash_retention_days ?? "").trim();
  if (rawDays !== "") {
    const d = Number.parseInt(rawDays, 10);
    if (!Number.isFinite(d) || d < 0 || d > 3650) return redirect("/admin?err=bad_retention");
    await setSetting(env, "trash_retention_days", d);
  }
  // v1.23: public gallery switch (1 = on, 0 = off)
  const rawExplore = String(form?.explore_enabled ?? "").trim();
  if (rawExplore !== "") {
    if (rawExplore !== "0" && rawExplore !== "1") return redirect("/admin?err=bad_explore");
    await setSetting(env, "explore_enabled", rawExplore === "1" ? 1 : 0);
  }
  if (!form?.default_quota && rawDays === "" && rawExplore === "") return redirect("/admin?err=bad_quota");
  logAudit(env, ctx, { action: "admin.settings", userId: gate.user.id, email: gate.user.email, detail: `默认配额 ${form?.default_quota || "-"} · 保留 ${rawDays || "-"} 天 · 公开画廊 ${rawExplore === "1" ? "开" : rawExplore === "0" ? "关" : "-"}`, ip: getClientIp(request) });
  return redirect("/admin?msg=settings_saved");
});

add("POST", "/admin/trash-sweep", async ({ request, env, ctx }) => {
  if (!sameOrigin(request)) return badRequest("cross-origin post rejected");
  const gate = await requireAdmin(env, request);
  if (gate.redirect) return gate.redirect;
  if (gate.forbidden) return gate.forbidden;
  const days = await trashRetentionDays(env);
  const n = await sweepTrash(env, days);
  logAudit(env, ctx, { action: "admin.trash_sweep", userId: gate.user.id, email: gate.user.email, detail: `清理 ${n} 项（保留 ${days} 天）`, ip: getClientIp(request) });
  return redirect(`/admin?msg=trash_swept&n=${n}`);
});

/* ---------------- sharded storage admin (v1.24) ---------------- */

const STORAGE_NOTICE = {
  recounted: { ok: "分片计数已按 images 表重新统计" },
  no_legacy: { err: "没有待整理的历史文件（全部图片已位于分片目录）" },
  bad_limit: { err: "每批数量需为 1–100 的整数" },
};

/** Move a batch of pre-v1.24 flat files into their shard and rename them.
 *  Bounded per call: each image costs one Drive PATCH plus shard setup. */
async function migrateLegacyImages(env, limit) {
  const { results } = await env.DB.prepare(
    `SELECT i.id, i.drive_file_id, i.name, i.user_id, u.email
       FROM images i JOIN users u ON u.id = i.user_id
      WHERE i.dir_id IS NULL
      ORDER BY i.id LIMIT ?`,
  )
    .bind(limit)
    .all();
  const rows = results || [];
  let moved = 0;
  let failed = 0;
  for (const im of rows) {
    const prefix = ownerPrefix(im.email);
    let dir;
    try {
      dir = await resolveStorageDir(env, prefix);
    } catch {
      failed++;
      continue;
    }
    const ext = (/\.([a-z0-9]{1,6})$/i.exec(im.name || "") || [])[1];
    const newName = newStorageName(ext ? ext.toLowerCase() : undefined);
    try {
      await moveFile(env, im.drive_file_id, {
        addParents: dir.folderId,
        removeParents: env.DRIVE_FOLDER_ID,
        name: newName,
      });
    } catch {
      failed++;
      await releaseStorageDir(env, dir.dirId);
      continue;
    }
    try {
      await env.DB.prepare("UPDATE images SET name = ?, dir_id = ?, storage_path = ? WHERE id = ?")
        .bind(newName, dir.dirId, storagePath(prefix, dir.bucket, newName), im.id)
        .run();
    } catch {
      failed++;
      // The bytes are already in the shard; the counter stays reserved so a
      // later recount lines the numbers up again.
      continue;
    }
    moved++;
  }
  return { scanned: rows.length, moved, failed };
}

add("GET", "/admin/storage/guide", async ({ request, env }) => {
  const gate = await requireAdmin(env, request);
  if (gate.redirect) return gate.redirect;
  if (gate.forbidden) return gate.forbidden;
  return html(storageGuidePage(gate.user));
});

add("POST", "/api/admin/gdrive/parse-client", async ({ request, env, ctx }) => {
  const gate = await adminApi(env, request, ctx);
  if (gate.error) return gate.error;

  let body = await readJson(request).catch(() => null);
  if (!body) return json({ error: "bad_json", message: "Invalid JSON format" }, 400, securityHeaders());

  let raw = body.raw_json ? body.raw_json : body;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return json({ error: "bad_json", message: "Failed to parse JSON string" }, 400, securityHeaders());
    }
  }

  const node = raw.installed || raw.web || raw;
  const clientId = String(node.client_id || "").trim();
  const clientSecret = String(node.client_secret || "").trim();
  const projectId = String(node.project_id || "").trim();

  if (!clientId || !clientSecret) {
    return json({
      error: "missing_fields",
      message: "JSON must contain client_id and client_secret",
    }, 400, securityHeaders());
  }

  // Encrypt client_secret before storing in D1
  const encSecret = await encryptSecret(env.SESSION_SECRET, clientSecret);
  await setSetting(env, "gdrive_client_id", clientId);
  await setSetting(env, "gdrive_client_secret_enc", encSecret);
  if (projectId) await setSetting(env, "gdrive_project_id", projectId);

  logAudit(env, ctx, {
    action: "admin.gdrive_credentials",
    userId: gate.user.id,
    email: gate.user.email,
    detail: `Client ID: ${clientId.slice(0, 15)}... (Project: ${projectId || "n/a"})`,
    ip: getClientIp(request),
  });

  return json({
    ok: true,
    client_id: clientId,
    project_id: projectId,
  }, 200, securityHeaders());
});

add("POST", "/api/admin/gdrive/auth-url", async ({ request, env, ctx }) => {
  const gate = await adminApi(env, request, ctx);
  if (gate.error) return gate.error;

  try {
    const res = await generateAuthUrl(env);
    return json(res, 200, securityHeaders());
  } catch (e) {
    return json({ error: "auth_url_failed", message: e.message }, 400, securityHeaders());
  }
});

add("POST", "/api/admin/gdrive/exchange", async ({ request, env, ctx }) => {
  const gate = await adminApi(env, request, ctx);
  if (gate.error) return gate.error;

  const body = (await readJson(request).catch(() => null)) || {};
  try {
    const res = await exchangeCallback(env, body);
    logAudit(env, ctx, {
      action: "admin.gdrive_bind",
      userId: gate.user.id,
      email: gate.user.email,
      detail: `Bound Google Account: ${res.email}`,
      ip: getClientIp(request),
    });
    return json(res, 200, securityHeaders());
  } catch (e) {
    return json({ error: "exchange_failed", message: e.message }, 400, securityHeaders());
  }
});

add("GET", "/api/admin/gdrive/folders", async ({ request, env, ctx }) => {
  const gate = await adminApi(env, request, ctx);
  if (gate.error) return gate.error;
  try {
    const folders = await listDriveFolders(env);
    return json({ folders }, 200, securityHeaders());
  } catch (e) {
    return json({ error: "list_failed", message: e.message }, 400, securityHeaders());
  }
});

add("POST", "/api/admin/gdrive/init-folder", async ({ request, env, ctx }) => {
  const gate = await adminApi(env, request, ctx);
  if (gate.error) return gate.error;
  try {
    // Creates a dedicated folder named "cf2gdrive" in user's root My Drive
    const folderId = await createFolder(env, "cf2gdrive", "root");
    await setSetting(env, "gdrive_folder_id", folderId);
    await setSetting(env, "gdrive_folder_name", "cf2gdrive");

    logAudit(env, ctx, {
      action: "admin.gdrive_folder",
      userId: gate.user.id,
      email: gate.user.email,
      detail: `Created and bound root folder: cf2gdrive (${folderId})`,
      ip: getClientIp(request),
    });

    return json({ ok: true, folder_id: folderId, folder_name: "cf2gdrive" }, 200, securityHeaders());
  } catch (e) {
    // v2.39.0: translate the most common Google error into an actionable hint.
    const raw = String(e.message || "");
    const message = raw.includes("insufficient authentication scopes")
      ? "当前令牌没有 Drive 写入权限（403 insufficient authentication scopes）。请到 Google Cloud 控制台 →「API 和服务 → OAuth 同意屏幕 → 数据访问 (Scopes)」添加 https://www.googleapis.com/auth/drive 并保存，然后回到存储页第 2 步重新授权一次再重试。若 Google 始终不授予该受限范围，参见「查看完整图文指引」中的降级方案。"
      : raw;
    return json({ error: "init_failed", message }, 400, securityHeaders());
  }
});

add("POST", "/api/admin/gdrive/bind-folder", async ({ request, env, ctx }) => {
  const gate = await adminApi(env, request, ctx);
  if (gate.error) return gate.error;
  const body = (await readJson(request).catch(() => null)) || {};
  const folderId = String(body.folder_id || "").trim();
  const folderName = String(body.folder_name || folderId).trim();
  if (!folderId) return json({ error: "missing_folder_id" }, 400, securityHeaders());

  await setSetting(env, "gdrive_folder_id", folderId);
  await setSetting(env, "gdrive_folder_name", folderName);

  logAudit(env, ctx, {
    action: "admin.gdrive_folder",
    userId: gate.user.id,
    email: gate.user.email,
    detail: `Bound existing root folder: ${folderName} (${folderId})`,
    ip: getClientIp(request),
  });

  return json({ ok: true, folder_id: folderId, folder_name: folderName }, 200, securityHeaders());
});

add("POST", "/api/admin/gdrive/unbind", async ({ request, env, ctx }) => {
  const gate = await adminApi(env, request, ctx);
  if (gate.error) return gate.error;

  await env.DB.prepare(
    "DELETE FROM settings WHERE key IN ('gdrive_refresh_token_enc', 'gdrive_account_email', 'gdrive_account_picture', 'gdrive_folder_id', 'gdrive_folder_name')",
  ).run();

  logAudit(env, ctx, {
    action: "admin.gdrive_unbind",
    userId: gate.user.id,
    email: gate.user.email,
    detail: "Unbound Google Drive account",
    ip: getClientIp(request),
  });

  return json({ ok: true }, 200, securityHeaders());
});

add("GET", "/admin/storage", async ({ request, env, url }) => {
  const gate = await requireAdmin(env, request);
  if (gate.redirect) return gate.redirect;
  if (gate.forbidden) return gate.forbidden;
  const [dirs, summary, gdriveConfig] = await Promise.all([
    listStorageDirs(env),
    storageSummary(env),
    getDriveConfig(env),
  ]);
  const msg = url.searchParams.get("msg");
  const err = url.searchParams.get("err");
  let notice = STORAGE_NOTICE[msg] || STORAGE_NOTICE[err] || null;
  if (msg === "migrated") {
    const m = Number(url.searchParams.get("m") || 0);
    const f = Number(url.searchParams.get("f") || 0);
    notice = { ok: `已整理 ${m} 个历史文件${f ? `，${f} 个失败（可再次执行重试）` : ""}` };
  }
  return html(storagePage(gate.user, dirs, summary, notice, gdriveConfig));
});

add("POST", "/admin/storage/recount", async ({ request, env, ctx }) => {
  if (!sameOrigin(request)) return badRequest("cross-origin post rejected");
  const gate = await requireAdmin(env, request);
  if (gate.redirect) return gate.redirect;
  if (gate.forbidden) return gate.forbidden;
  const n = await recountStorageDirs(env);
  logAudit(env, ctx, {
    action: "admin.storage_recount",
    userId: gate.user.id,
    email: gate.user.email,
    detail: `重算 ${n} 个分片目录`,
    ip: getClientIp(request),
  });
  return redirect("/admin/storage?msg=recounted");
});

add("POST", "/admin/storage/migrate", async ({ request, env, ctx }) => {
  if (!sameOrigin(request)) return badRequest("cross-origin post rejected");
  const gate = await requireAdmin(env, request);
  if (gate.redirect) return gate.redirect;
  if (gate.forbidden) return gate.forbidden;
  const form = await readForm(request);
  const raw = Number(form?.limit ?? 20);
  if (!Number.isInteger(raw) || raw < 1 || raw > 100) return redirect("/admin/storage?err=bad_limit");
  const r = await migrateLegacyImages(env, raw);
  if (!r.scanned) return redirect("/admin/storage?err=no_legacy");
  logAudit(env, ctx, {
    action: "admin.storage_migrate",
    userId: gate.user.id,
    email: gate.user.email,
    detail: `整理 ${r.moved} 个历史文件（失败 ${r.failed}）`,
    ip: getClientIp(request),
  });
  return redirect(`/admin/storage?msg=migrated&m=${r.moved}&f=${r.failed}`);
});

add("POST", "/admin/users/(?<id>\\d+)/quota", async ({ request, env, ctx, params }) => {
  if (!sameOrigin(request)) return badRequest("cross-origin post rejected");
  const gate = await requireAdmin(env, request);
  if (gate.redirect) return gate.redirect;
  if (gate.forbidden) return gate.forbidden;

  const form = await readForm(request);
  const quota = parseSize(form?.quota);
  if (!quota) return redirect("/admin?err=bad_quota");
  const target = await env.DB.prepare("SELECT id, used_bytes FROM users WHERE id = ?")
    .bind(Number(params.id))
    .first();
  if (!target) return redirect(adminUsersUrl(request, "err=no_user"));
  // Never set a quota below current usage: the user would be instantly over.
  if (quota < target.used_bytes) return redirect(adminUsersUrl(request, "err=quota_below_used"));
  await env.DB.prepare("UPDATE users SET quota_bytes = ? WHERE id = ?")
    .bind(quota, target.id)
    .run();
  logAudit(env, ctx, { action: "admin.quota", userId: gate.user.id, email: gate.user.email, target: target.id, detail: `配额 ${quota} 字节`, ip: getClientIp(request) });
  return redirect(adminUsersUrl(request, "msg=quota_saved"));
});

/* ---------------- v1.16: user management (status / delete / search) ---------------- */

/** Preserve the current user-list filters when redirecting back to /admin.
 *  Drops any stale msg/err from the referer; `extra` appends the new notice key. */
function adminUsersUrl(request, extra = "") {
  const ref = request.headers.get("referer") || "";
  const i = ref.indexOf("/admin");
  let base = i >= 0 ? ref.slice(i) : "/admin";
  const qi = base.indexOf("?");
  if (qi >= 0) {
    const path = base.slice(0, qi);
    const kept = base
      .slice(qi + 1)
      .split("&")
      .filter((kv) => kv && !kv.startsWith("msg=") && !kv.startsWith("err="))
      .join("&");
    base = kept ? `${path}?${kept}` : path;
  }
  const sep = base.includes("?") ? "&" : "?";
  return extra ? base + sep + extra : base;
}

add("POST", "/admin/users/(?<id>\\d+)/status", async ({ request, env, ctx, params }) => {
  if (!sameOrigin(request)) return badRequest("cross-origin post rejected");
  const gate = await requireAdmin(env, request);
  if (gate.redirect) return gate.redirect;
  if (gate.forbidden) return gate.forbidden;

  const id = Number(params.id);
  if (id === gate.user.id) return redirect(adminUsersUrl(request, "err=self_lock"));
  const target = await env.DB.prepare("SELECT id, role, status FROM users WHERE id = ?").bind(id).first();
  if (!target) return redirect(adminUsersUrl(request, "err=no_user"));
  const form = await readForm(request);
  const next = form?.status === "active" ? "active" : "disabled";
  // Never disable the last active admin: the instance would be unadministrable.
  if (next === "disabled" && target.role === "admin") {
    const admins = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND status = 'active' AND id != ?",
    )
      .bind(id)
      .first();
    if (!admins || admins.c === 0) return redirect(adminUsersUrl(request, "err=last_admin"));
  }
  await env.DB.prepare("UPDATE users SET status = ? WHERE id = ?").bind(next, id).run();
  // Disabled users lose every live session immediately.
  if (next === "disabled") {
    await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id).run();
  }
  logAudit(env, ctx, { action: next === "active" ? "admin.user_enable" : "admin.user_disable", userId: gate.user.id, email: gate.user.email, target: id, ip: getClientIp(request) });
  return redirect(adminUsersUrl(request, next === "active" ? "msg=user_enabled" : "msg=user_disabled"));
});

add("POST", "/admin/users/(?<id>\\d+)/delete", async ({ request, env, ctx, params }) => {
  if (!sameOrigin(request)) return badRequest("cross-origin post rejected");
  const gate = await requireAdmin(env, request);
  if (gate.redirect) return gate.redirect;
  if (gate.forbidden) return gate.forbidden;

  const id = Number(params.id);
  if (id === gate.user.id) return redirect(adminUsersUrl(request, "err=self_lock"));
  const target = await env.DB.prepare("SELECT id, role FROM users WHERE id = ?").bind(id).first();
  if (!target) return redirect(adminUsersUrl(request, "err=no_user"));
  if (target.role === "admin") {
    const admins = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND id != ?",
    )
      .bind(id)
      .first();
    if (!admins || admins.c === 0) return redirect(adminUsersUrl(request, "err=last_admin"));
  }
  // Collect Drive files first so cleanup can run after the metadata is gone.
  const { results: files } = await env.DB.prepare(
    "SELECT drive_file_id FROM images WHERE user_id = ? AND drive_file_id IS NOT NULL",
  )
    .bind(id)
    .all();
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM api_keys WHERE user_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM share_links WHERE created_by = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM share_links WHERE image_id IN (SELECT id FROM images WHERE user_id = ?)").bind(id).run();
  await env.DB.prepare("DELETE FROM images WHERE user_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM rate_limits WHERE bucket LIKE ?").bind(`%:${id}`).run();
  await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
  // v1.24: the shard counters of this user are now stale — recount from truth.
  await recountStorageDirs(env);
  // Drive copies are best-effort: metadata is already gone.
  const ids = (files || []).map((f) => f.drive_file_id).filter(Boolean);
  if (ids.length) {
    ctx.waitUntil(
      (async () => {
        for (const fid of ids) {
          try {
            await deleteFile(env, fid);
          } catch {
            // already gone or unreachable; D1 is the source of truth
          }
        }
      })(),
    );
  }
  logAudit(env, ctx, { action: "admin.user_delete", userId: gate.user.id, email: gate.user.email, target: id, detail: `${ids.length} 个云端文件`, ip: getClientIp(request) });
  return redirect(adminUsersUrl(request, "msg=user_deleted"));
});

add("POST", "/admin/invites", async ({ request, env, ctx }) => {
  if (!sameOrigin(request)) return badRequest("cross-origin post rejected");
  const gate = await requireAdmin(env, request);
  if (gate.redirect) return gate.redirect;
  if (gate.forbidden) return gate.forbidden;

  const ip = getClientIp(request);
  const rl = await rateLimit(env, `invite-create:${gate.user.id}`, 60, 3600);
  if (!rl.allowed) return redirect("/admin");

  const form = await readForm(request);
  const { code } = await createInvite(env, gate.user.id, {
    note: form?.note,
    maxUses: form?.max_uses,
    expiresInDays: form?.expires_days,
  });
  logAudit(env, ctx, { action: "admin.invite_create", userId: gate.user.id, email: gate.user.email, target: code, detail: `次数 ${form?.max_uses || 1}`, ip: getClientIp(request) });
  return redirect(`/admin?invite=${encodeURIComponent(code)}`);
});

add("POST", "/admin/invites/(?<id>\\d+)/revoke", async ({ request, env, ctx, params }) => {
  if (!sameOrigin(request)) return badRequest("cross-origin post rejected");
  const gate = await requireAdmin(env, request);
  if (gate.redirect) return gate.redirect;
  if (gate.forbidden) return gate.forbidden;
  await revokeInvite(env, params.id);
  return redirect("/admin");
});

/* ---- admin API (Bearer key or session; role must be admin) ---- */

async function adminApi(env, request, ctx) {
  const user = await resolveUser(env, request, ctx);
  if (!user) return { error: json({ error: "unauthorized" }, 401, securityHeaders()) };
  if (user.role !== "admin") {
    return { error: json({ error: "forbidden" }, 403, securityHeaders()) };
  }
  return { user };
}

add("GET", "/api/admin/invites", async ({ request, env, ctx }) => {
  const gate = await adminApi(env, request, ctx);
  if (gate.error) return gate.error;
  const invites = await listInvites(env);
  return json(
    { invites: invites.map((i) => ({ ...i, status: inviteStatus(i) })) },
    200,
    securityHeaders(),
  );
});

add("POST", "/api/admin/invites", async ({ request, env, ctx }) => {
  if (!sameOrigin(request)) return badRequest("cross-origin post rejected");
  const gate = await adminApi(env, request, ctx);
  if (gate.error) return gate.error;
  const body = await readJson(request).catch(() => null);
  if (!body || typeof body !== "object") return badRequest("invalid body");
  const { code, max_uses, expires_at } = await createInvite(env, gate.user.id, {
    note: body.note,
    maxUses: body.max_uses,
    expiresInDays: body.expires_in_days,
  });
  return json({ code, max_uses, expires_at }, 201, securityHeaders());
});

add("DELETE", "/api/admin/invites/(?<id>\\d+)", async ({ request, env, ctx, params }) => {
  const gate = await adminApi(env, request, ctx);
  if (gate.error) return gate.error;
  const ok = await revokeInvite(env, params.id);
  if (!ok) return json({ error: "not_found" }, 404, securityHeaders());
  return json({ ok: true, id: Number(params.id) }, 200, securityHeaders());
});

add("GET", "/api/admin/settings", async ({ request, env, ctx }) => {
  const gate = await adminApi(env, request, ctx);
  if (gate.error) return gate.error;
  const defaultQuota = await getSettingBytes(env, "default_quota_bytes");
  const trashRetention = await trashRetentionDays(env);
  return json(
    {
      default_quota_bytes: defaultQuota,
      default_quota_human: formatSize(defaultQuota),
      trash_retention_days: trashRetention,
      explore_enabled: (await exploreEnabled(env)) ? 1 : 0,
    },
    200,
    securityHeaders(),
  );
});

add("PUT", "/api/admin/settings", async ({ request, env, ctx }) => {
  const gate = await adminApi(env, request, ctx);
  if (gate.error) return gate.error;
  const body = await readJson(request).catch(() => null);
  if (body?.default_quota != null) {
    const quota = parseSize(body.default_quota);
    if (!quota) return badRequest("default_quota must be a size like 500G or 2T");
    await setSetting(env, "default_quota_bytes", quota);
  }
  if (body?.trash_retention_days != null) {
    const d = Number(body.trash_retention_days);
    if (!Number.isInteger(d) || d < 0 || d > 3650) {
      return badRequest("trash_retention_days must be an integer 0-3650 (0 = never)");
    }
    await setSetting(env, "trash_retention_days", d);
  }
  if (body?.explore_enabled != null) {
    const v = Number(body.explore_enabled);
    if (v !== 0 && v !== 1) return badRequest("explore_enabled must be 0 or 1");
    await setSetting(env, "explore_enabled", v);
  }
  if (body?.default_quota == null && body?.trash_retention_days == null && body?.explore_enabled == null) {
    return badRequest("nothing to update");
  }
  return json(
    {
      ok: true,
      default_quota_bytes: await getSettingBytes(env, "default_quota_bytes"),
      trash_retention_days: await trashRetentionDays(env),
    },
    200,
    securityHeaders(),
  );
});

add("PATCH", "/api/admin/users/(?<id>\\d+)/quota", async ({ request, env, ctx, params }) => {
  const gate = await adminApi(env, request, ctx);
  if (gate.error) return gate.error;
  const body = await readJson(request).catch(() => null);
  const quota = parseSize(body?.quota);
  if (!quota) return badRequest("quota must be a size like 500G or 2T");
  const target = await env.DB.prepare("SELECT id, used_bytes FROM users WHERE id = ?")
    .bind(Number(params.id))
    .first();
  if (!target) return json({ error: "not_found" }, 404, securityHeaders());
  if (quota < target.used_bytes) {
    return json({ error: "quota_below_used", used_bytes: target.used_bytes }, 400, securityHeaders());
  }
  await env.DB.prepare("UPDATE users SET quota_bytes = ? WHERE id = ?")
    .bind(quota, target.id)
    .run();
  return json({ ok: true, id: target.id, quota_bytes: quota }, 200, securityHeaders());
});

/* ---------------- docs + settings (v0.9) ---------------- */

add("GET", "/docs", async ({ request, env, ctx }) => {
  const user = await getSessionUser(env, request);
  return html(docsPage(user));
});

/* ---------------- public gallery (v1.23) ---------------- */

const EXPLORE_PAGE_SIZE = 24;

add("GET", "/explore", async ({ request, env, url }) => {
  const viewer = await getSessionUser(env, request);
  if (!(await exploreEnabled(env))) {
    return html(explorePage(viewer, [], 1, 1, 0, false));
  }
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const { results } = await env.DB.prepare(
    `SELECT id, original_name, size_bytes, visibility, views, created_at,
            COUNT(*) OVER () AS total_count
     FROM images WHERE deleted = 0 AND visibility = 'public'
     ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
  )
    .bind(EXPLORE_PAGE_SIZE, (page - 1) * EXPLORE_PAGE_SIZE)
    .all();
  const images = results || [];
  const totalCount = images.length ? images[0].total_count : 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / EXPLORE_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  if (safePage !== page) return redirect(`/explore?page=${safePage}`);
  return html(explorePage(viewer, images, safePage, totalPages, totalCount, true));
});

add("GET", "/api/public/images", async ({ env, url }) => {
  if (!(await exploreEnabled(env))) {
    return json({ error: "explore_disabled" }, 403, securityHeaders());
  }
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(url.searchParams.get("per_page") || "30", 10) || 30));
  const { results } = await env.DB.prepare(
    `SELECT id, public_id, original_name, mime_type, size_bytes, views, created_at,
            COUNT(*) OVER () AS total_count
     FROM images WHERE deleted = 0 AND visibility = 'public'
     ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
  )
    .bind(perPage, (page - 1) * perPage)
    .all();
  const rows = results || [];
  const total = rows.length ? rows[0].total_count : 0;
  return json(
    {
      page,
      per_page: perPage,
      total,
      pages: Math.max(1, Math.ceil(total / perPage)),
      items: rows.map((r) => ({
        id: r.public_id,
        name: r.original_name,
        mime_type: r.mime_type,
        size_bytes: r.size_bytes,
        views: r.views,
        created_at: r.created_at,
        url: `/i/${r.public_id}`,
        thumbnail: `/t/${r.public_id}`,
      })),
    },
    200,
    securityHeaders(),
  );
});

add("GET", "/data", async ({ request, env }) => {
  const user = await getSessionUser(env, request);
  if (!user) return redirect("/login");
  const row = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM images WHERE user_id = ? AND deleted = 0) AS images,
            (SELECT COALESCE(SUM(size_bytes),0) FROM images WHERE user_id = ? AND deleted = 0) AS bytes,
            (SELECT COUNT(*) FROM share_links s JOIN images i ON i.id = s.image_id
               WHERE i.user_id = ? AND i.deleted = 0 AND s.revoked = 0) AS shares`,
  )
    .bind(user.id, user.id, user.id)
    .first();
  return html(dataPage(user, { images: row?.images || 0, bytes: row?.bytes || 0, shares: row?.shares || 0 }));
});

add("GET", "/settings", async ({ request, env, ctx, url }) => {
  const user = await getSessionUser(env, request);
  if (!user) return redirect("/login");
  const msg = url.searchParams.get("msg");
  const text =
    msg === "profile_saved"
      ? "资料已保存"
      : msg === "password_changed"
        ? "密码已修改"
        : "";
  return html(settingsPage(user, text));
});

add("POST", "/settings/profile", async ({ request, env, ctx }) => {
  if (!sameOrigin(request)) return badRequest("cross-origin post rejected");
  const user = await getSessionUser(env, request);
  if (!user) return redirect("/login");
  const form = await readForm(request);
  const name = String(form?.display_name || "").trim().slice(0, 60);
  if (!name) return badRequest("display_name required");
  await env.DB.prepare("UPDATE users SET display_name = ? WHERE id = ?")
    .bind(name, user.id)
    .run();
  return redirect("/settings?msg=profile_saved");
});

add("POST", "/settings/password", async ({ request, env, ctx }) => {
  if (!sameOrigin(request)) return badRequest("cross-origin post rejected");
  const user = await getSessionUser(env, request);
  if (!user) return redirect("/login");
  const form = await readForm(request);
  const oldPw = String(form?.old_password || "");
  const newPw = String(form?.new_password || "");
  if (newPw.length < 8) return badRequest("new password must be at least 8 characters");
  const row = await env.DB.prepare("SELECT password_hash, password_salt FROM users WHERE id = ?")
    .bind(user.id)
    .first();
  const ok = await verifyPassword(oldPw, row.password_salt, row.password_hash);
  if (!ok) return badRequest("current password is incorrect");
  const salt = randomToken(16);
  const hash = await hashPassword(newPw, salt);
  await env.DB.prepare("UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?")
    .bind(hash, salt, user.id)
    .run();
  return redirect("/settings?msg=password_changed");
});

export default {
  async fetch(request, env, ctx) {
    try {
      return await dispatch(request, env, ctx);
    } catch (e) {
      console.error("unhandled:", e);
      return html(
        errorPage(500, "服务器内部错误", "请稍后重试；如持续出现请联系管理员。"),
        500,
      );
    }
  },
};
