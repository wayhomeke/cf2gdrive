/** Server-rendered pages: layout, gallery, stats. */
import { escapeHtml } from "./util.js";
import { formatSize } from "./settings.js";
import { shareExpiryText } from "./shares.js";
import { auditLabel } from "./audit.js";

function layout(title, bodyHtml, user) {
  const nav = user
    ? `<a href="/gallery">图库</a><a href="/files">文件中转</a><a href="/explore">发现</a><a href="/trash">回收站</a><a href="/shares">分享</a><a href="/keys">API 密钥</a><a href="/docs">API 文档</a>${user.role === "admin" ? '<a href="/admin">管理</a><a href="/admin/storage">存储配置</a>' : ""}<a href="/data">导入导出</a><a href="/sessions">设备</a><a href="/settings">设置</a><button id="themebtn" type="button" onclick="toggleTheme()" title="切换深色/浅色模式">🌓</button><span class="me">${escapeHtml(user.email)}</span><form method="post" action="/logout" class="nb"><button>退出</button></form>`
    : `<a href="/login">登录</a><a href="/register">注册</a>`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · cf2gdrive</title>
<link rel="icon" href="/favicon.ico" type="image/svg+xml">
<script>(function(){try{var t=localStorage.getItem('picbed_theme');if(t!=='dark'&&t!=='light')t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme='light'}})()</script>
<style>
:root{--bg:#f6f7f9;--card:#fff;--line:#e3e6ea;--txt:#1f2328;--mut:#6b7280;--acc:#2563eb;--dan:#dc2626;
--ph:#eef1f4;--inp:#ccd2d9;--inp-bg:#fff;--ok:#15803d;--warn:#b45309;--acc-bg:#eff6ff;--del-line:#fecaca;
--label:#444;--pre-bg:#f6f7f9;--toast-bg:#111827;--inv-line:#bfdbfe;--teal:#059691;
--nt-ok-bg:#f0fdf4;--nt-ok-line:#bbf7d0;--nt-err-bg:#fef2f2;--nt-err-line:#fecaca}
html[data-theme="dark"]{--bg:#0f1115;--card:#171a21;--line:#2a2f3a;--txt:#e5e7eb;--mut:#9ca3af;--acc:#3b82f6;--dan:#f87171;
--ph:#1f2937;--inp:#374151;--inp-bg:#111827;--ok:#4ade80;--warn:#fbbf24;--acc-bg:rgba(59,130,246,.15);--del-line:#7f1d1d;
--label:#9ca3af;--pre-bg:#111827;--toast-bg:#374151;--inv-line:#1e40af;--teal:#2dd4bf;
--nt-ok-bg:rgba(34,197,94,.12);--nt-ok-line:#166534;--nt-err-bg:rgba(248,113,113,.12);--nt-err-line:#7f1d1d}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--txt);margin:0}
header{background:var(--card);border-bottom:1px solid var(--line);padding:0 20px;height:52px;display:flex;align-items:center;gap:18px;position:sticky;top:0;z-index:10}
header .brand{font-weight:700;color:var(--acc);text-decoration:none;font-size:16px}
header a{color:var(--txt);text-decoration:none;font-size:14px}
header a:hover{color:var(--acc)}
header .me{color:var(--mut);font-size:13px;margin-left:auto}
header form{margin:0}
header button{background:none;border:1px solid var(--line);border-radius:6px;padding:5px 10px;font-size:13px;cursor:pointer}
main{max-width:1100px;margin:24px auto;padding:0 16px}
.stats{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:18px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 18px;font-size:13px;color:var(--mut)}
.stat b{display:block;font-size:20px;color:var(--txt);margin-top:2px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px}
.cell{background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;position:relative}
.cell .ph{height:150px;background:var(--ph);display:flex;align-items:center;justify-content:center;overflow:hidden}
.cell img{max-width:100%;max-height:150px;display:block}
.cell .meta{padding:10px 12px;font-size:12px;color:var(--mut)}
.cell .meta .nm{color:var(--txt);font-size:13px;word-break:break-all;margin-bottom:4px}
.cell .acts{display:flex;gap:6px;padding:0 12px 12px}
.cell .acts button,.cell .acts a{flex:1;font-size:12px;padding:6px 0;border-radius:6px;border:1px solid var(--line);background:var(--card);cursor:pointer;text-align:center;text-decoration:none;color:var(--txt)}
.cell .acts .del{color:var(--dan);border-color:var(--del-line)}
.badge{position:absolute;top:8px;right:8px;font-size:11px;padding:2px 8px;border-radius:99px;background:rgba(0,0,0,.55);color:#fff}
.empty{background:var(--card);border:1px dashed var(--line);border-radius:12px;padding:60px;text-align:center;color:var(--mut)}
.pager{display:flex;gap:8px;justify-content:center;margin:22px 0}
.pager a,.pager span{padding:6px 12px;border:1px solid var(--line);border-radius:6px;font-size:13px;text-decoration:none;color:var(--txt);background:var(--card)}
.pager .cur{background:var(--acc);color:#fff;border-color:var(--acc)}
.pager .gap{border:0;background:none;color:var(--mut);padding:6px 2px}
.filterbar{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;margin-bottom:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.filterbar input[type=search]{flex:1;min-width:180px;padding:7px 10px;border:1px solid var(--inp);background:var(--inp-bg);color:var(--txt);border-radius:6px;font-size:13px}
.filterbar select{padding:7px 8px;border:1px solid var(--inp);border-radius:6px;font-size:13px;background:var(--inp-bg);color:var(--txt)}
.filterbar button{padding:7px 16px;background:var(--acc);color:#fff;border:0;border-radius:6px;font-size:13px;cursor:pointer}
.filterbar .clear{font-size:13px;color:var(--mut);text-decoration:none}
.filterbar .clear:hover{color:var(--dan)}
.resultline{font-size:13px;color:var(--mut);margin-bottom:14px}
.resultline b{color:var(--txt)}
.uploadbar{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:18px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.uploadbar .drop{flex:1;min-width:220px;border:2px dashed var(--inp);border-radius:8px;padding:14px;text-align:center;color:var(--mut);cursor:pointer;font-size:13px}
.vispick{display:flex;gap:12px;font-size:13px;color:var(--txt)}
.vispick label{display:flex;gap:5px;align-items:center;cursor:pointer;white-space:nowrap}
#prog{flex-basis:100%;display:none}
#prog:not(:empty){display:block}
.prow{border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin-top:10px;font-size:13px}
.prow .pnm{font-weight:600;word-break:break-all;margin-bottom:6px}
.pbar{height:8px;background:var(--ph);border-radius:99px;overflow:hidden}
.pbar .pfill{height:100%;width:0;background:var(--acc);border-radius:99px;transition:width .15s}
.prow .pst{color:var(--mut);margin-top:6px}
.prow .pst.ok{color:var(--ok);font-weight:600}
.prow .pst.err{color:var(--dan);font-weight:600}
.prow .pst.warn{color:var(--warn);font-weight:600}
.uploadbar .drop.over{border-color:var(--acc);color:var(--acc);background:var(--acc-bg)}
.upform{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:18px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.upzone{background:var(--card);border:2px dashed var(--line);border-radius:10px;padding:22px;margin-bottom:18px;text-align:center;transition:border-color .2s,background .2s;cursor:pointer}
.upzone.dragover{border-color:var(--acc);background:var(--acc-bg)}
.upzone-title{font-size:15px;font-weight:600;color:var(--txt);margin-bottom:6px}
.upzone-hint{font-size:12px;color:var(--mut)}
.up-row{display:flex;gap:12px;align-items:center;justify-content:center;margin-top:14px;flex-wrap:wrap}
.up-row input[type=file]{display:none}
.up-row button,.up-row .btn{border:1px solid var(--line);background:var(--card);color:var(--txt);border-radius:8px;padding:7px 14px;font-size:13px;cursor:pointer;text-decoration:none}
.up-row button.pri{background:var(--acc);border-color:var(--acc);color:#fff}
.up-url-box{display:none;margin-top:12px;display:flex;gap:8px;max-width:540px;margin-left:auto;margin-right:auto}
.up-url-box input{flex:1;padding:7px 10px;border:1px solid var(--inp);background:var(--inp-bg);color:var(--txt);border-radius:6px;font-size:13px}
.up-queue{margin-top:12px;display:flex;flex-direction:column;gap:6px;text-align:left;max-width:540px;margin-left:auto;margin-right:auto}
.up-item{font-size:12px;background:var(--inp-bg);border:1px solid var(--line);border-radius:6px;padding:6px 10px;display:flex;align-items:center;gap:8px}
.up-item .prog{flex:1;height:5px;background:var(--line);border-radius:3px;overflow:hidden}
.up-item .prog-bar{height:100%;background:var(--acc);width:0%;transition:width .1s}
.upform input[type=file]{flex:1;min-width:220px;font-size:13px}
.upform .vis{display:flex;gap:6px;align-items:center;font-size:13px;color:var(--txt);white-space:nowrap;cursor:pointer}
.upform button,.tabs a{border:1px solid var(--line);background:var(--card);color:var(--txt);border-radius:8px;padding:8px 14px;font-size:13px;cursor:pointer;text-decoration:none}
.upform button{background:var(--acc);border-color:var(--acc);color:#fff}
.tabs{display:flex;gap:8px;margin-bottom:16px}
.tabs a.on{background:var(--acc);border-color:var(--acc);color:#fff}
.toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%);background:var(--toast-bg);color:#fff;padding:10px 18px;border-radius:8px;font-size:13px;opacity:0;transition:opacity .2s;z-index:99;max-width:80vw;word-break:break-all}
.lightbox{position:fixed;inset:0;background:rgba(0,0,0,.92);display:none;z-index:200;flex-direction:column}
.lightbox.on{display:flex}
.lb-stage{flex:1;display:flex;align-items:center;justify-content:center;min-height:0;position:relative}
.lb-stage img{max-width:92vw;max-height:82vh;object-fit:contain;border-radius:4px}
.lb-nav{position:absolute;top:50%;transform:translateY(-50%);background:rgba(255,255,255,.14);color:#fff;border:0;font-size:28px;width:48px;height:48px;border-radius:99px;cursor:pointer;line-height:1}
.lb-nav:hover{background:rgba(255,255,255,.28)}
.lb-prev{left:16px}
.lb-next{right:16px}
.lb-bar{display:flex;align-items:center;gap:14px;padding:10px 18px;color:#e5e7eb;font-size:13px;background:rgba(0,0,0,.4)}
.lb-bar .lb-name{font-weight:600;word-break:break-all;flex:1;min-width:0}
.lb-bar .lb-meta{color:#9ca3af;white-space:nowrap}
.lb-bar .lb-exif{color:#a5b4fc;font-size:12px}
.shmodal{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;z-index:50}
.shmodal.on{display:flex}
.shmodal .shbox{background:var(--card);border-radius:12px;padding:22px;width:min(420px,92vw);color:var(--txt)}
.shmodal h3{margin:0 0 6px}
.shmodal .shopts{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}
.shmodal .shopts button{flex:1;min-width:70px;padding:9px 0;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--txt);font-size:13px;cursor:pointer}
.shmodal .shopts button:hover{border-color:var(--acc);color:var(--acc)}
.shmodal #shresult{display:none;gap:8px;margin-bottom:12px}
.shmodal #shresult input{flex:1;padding:8px 10px;border:1px solid var(--inp);background:var(--inp-bg);color:var(--txt);border-radius:6px;font-size:13px}
.shmodal #shresult button{padding:8px 14px;background:var(--acc);color:#fff;border:0;border-radius:6px;font-size:13px;cursor:pointer}
.shmodal .shclose{width:100%;padding:9px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--txt);font-size:13px;cursor:pointer}
.lb-bar button{background:rgba(255,255,255,.14);color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:13px;cursor:pointer}
.lb-bar button:hover{background:rgba(255,255,255,.28)}
.lb-hidden .lb-info{display:none}
/* v1.20: multi-select (batch operations) */
.pick{position:absolute;top:8px;left:8px;z-index:3;width:18px;height:18px;margin:0;cursor:pointer;accent-color:var(--acc)}
.cell.sel{border-color:var(--acc);box-shadow:0 0 0 2px var(--acc) inset}
.selbar{display:none;align-items:center;flex-wrap:wrap;gap:8px;background:var(--acc-bg);border:1px solid var(--acc);border-radius:8px;padding:8px 12px;margin-bottom:12px;font-size:13px;color:var(--txt)}
.selbar.on{display:flex}
.selbar b{color:var(--acc)}
.selbar .spacer{flex:1}
.selbar button{padding:5px 11px;border:1px solid var(--inp);border-radius:6px;background:var(--card);color:var(--txt);font-size:12px;cursor:pointer}
.selbar button:hover{border-color:var(--acc);color:var(--acc)}
.selbar button.danger{color:var(--dan);border-color:var(--del-line)}
.selbar button.danger:hover{border-color:var(--dan);color:var(--dan)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px;margin-bottom:16px}
.card h3{margin-top:0}
.btnlike{display:inline-block;padding:8px 16px;background:var(--acc);color:#fff;border-radius:6px;font-size:13px;text-decoration:none}
.notice-ok{background:var(--nt-ok-bg);border:1px solid var(--nt-ok-line);border-radius:8px;padding:10px 16px;margin-bottom:16px;font-size:14px;color:var(--ok)}
.notice-err{background:var(--nt-err-bg);border:1px solid var(--nt-err-line);border-radius:8px;padding:10px 16px;margin-bottom:16px;font-size:14px;color:var(--dan)}
html[data-theme="dark"] input,html[data-theme="dark"] textarea,html[data-theme="dark"] select{background:var(--inp-bg);color:var(--txt);border-color:var(--inp)}
html[data-theme="dark"] .stat b{color:var(--txt)}
html[data-theme="dark"] header button{background:var(--card);color:var(--txt)}
html[data-theme="dark"] .cell img{background:var(--ph)}
#themebtn{background:none;border:1px solid var(--line);border-radius:6px;padding:5px 9px;font-size:13px;cursor:pointer;line-height:1}
.tablewrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
@media (max-width:640px){
  header{overflow-x:auto;white-space:nowrap;gap:12px;padding:0 12px}
  header .brand{margin-right:2px}
  header .me{font-size:12px}
  main{margin:16px auto;padding:0 10px}
  .stats{gap:10px}
  .stat{padding:10px 14px}
  .grid{grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px}
  .cell .ph{height:110px}
  .cell img{max-height:110px}
  .filterbar,.uploadbar{padding:10px 12px}
  .filterbar input[type=search]{min-width:120px}
  .empty{padding:36px 16px}
  .shmodal .shbox{width:94vw;padding:18px}
  .lb-nav{width:38px;height:38px;font-size:22px}
  .lb-prev{left:8px}
  .lb-next{right:8px}
  .lb-bar{flex-wrap:wrap;gap:6px 12px;font-size:12px;padding:8px 12px}
  .toast{bottom:20px;max-width:92vw}
  .card{padding:16px}
  .pager{flex-wrap:wrap}
  .pick{width:22px;height:22px}
  .selbar{gap:6px;padding:8px 10px}
  .selbar button{padding:5px 8px}
}
</style>
</head>
<body>
<header>
  <a class="brand" href="/">cf2gdrive</a>
  ${nav}
</header>
<main>${bodyHtml}</main>
<div class="toast" id="toast"></div>
<script>
function toast(msg){const t=document.getElementById('toast');t.textContent=msg;t.style.opacity=1;clearTimeout(t._h);t._h=setTimeout(()=>t.style.opacity=0,2600);}
// v1.14: dark mode toggle (persists in localStorage; system preference is the default)
function toggleTheme(){const cur=document.documentElement.dataset.theme==='dark'?'dark':'light';const next=cur==='dark'?'light':'dark';document.documentElement.dataset.theme=next;try{localStorage.setItem('picbed_theme',next)}catch(e){}const b=document.getElementById('themebtn');if(b)b.textContent=next==='dark'?'☀️':'🌓';}
(function(){const b=document.getElementById('themebtn');if(b)b.textContent=document.documentElement.dataset.theme==='dark'?'☀️':'🌓';})();
</script>
</body>
</html>`;
}

function fmtBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KiB";
  if (n < 1073741824) return (n / 1048576).toFixed(2) + " MiB";
  return (n / 1073741824).toFixed(2) + " GiB";
}

function fmtDate(iso) {
  try {
    return new Date(iso + (iso.length === 19 ? "Z" : "")).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return iso;
  }
}

/** Pagination with ellipsis truncation (v1.5): 1 … 4 5 6 … 99.
 *  v1.10: active search/filter/sort params are preserved in every link. */
function pagerHtml(page, totalPages, filters, base = "/gallery") {
  if (totalPages <= 1) return "";
  const keep = new Set([1, totalPages, page, page - 1, page + 1]);
  const parts = [];
  let last = 0;
  for (let p = 1; p <= totalPages; p++) {
    if (!keep.has(p)) continue;
    if (p - last > 1) parts.push('<span class="gap">…</span>');
    parts.push(
      p === page
        ? `<span class="cur">${p}</span>`
        : `<a href="${base}${filterQs(filters, p)}">${p}</a>`,
    );
    last = p;
  }
  return `<div class="pager">${parts.join("")}</div>`;
}

/** Query string for gallery page N with active filters preserved. */
function filterQs(filters, page) {
  const qs = new URLSearchParams();
  qs.set("page", String(page));
  if (filters?.q) qs.set("q", filters.q);
  if (filters?.vis && filters.vis !== "all") qs.set("vis", filters.vis);
  if (filters?.sort && filters.sort !== "newest") qs.set("sort", filters.sort);
  return `?${qs.toString()}`;
}

const SORT_LABELS = { newest: "最新上传", oldest: "最早上传", largest: "体积最大", smallest: "体积最小", views: "浏览最多" };

export function galleryPage(user, images, page, totalPages, totalCount, filters = { q: "", vis: "all", sort: "newest" }) {
  const usedPct = user.quota_bytes > 0 ? Math.min(100, (user.used_bytes / user.quota_bytes) * 100) : 0;
  const remain = Math.max(0, user.quota_bytes - user.used_bytes);
  const pctColor = usedPct >= 95 ? "var(--dan)" : usedPct >= 80 ? "var(--warn)" : "var(--txt)";
  const filtersActive = !!(filters.q || filters.vis !== "all" || filters.sort !== "newest");

  const stats = `<div class="stats">
    <div class="stat">图片总数<b>${totalCount}</b></div>
    <div class="stat">已用空间<b>${fmtBytes(user.used_bytes)}</b></div>
    <div class="stat">配额<b>${fmtBytes(user.quota_bytes)}</b></div>
    <div class="stat">配额使用<b style="color:${pctColor}">${usedPct.toFixed(1)}%</b></div>
    <div class="stat">剩余空间<b>${fmtBytes(remain)}</b></div>
  </div>`;

  const uploadBar = `<div class="uploadbar">
    <div class="drop" id="drop">点击选择、拖入或按 Ctrl+V 粘贴图片上传（jpeg/png/gif/webp/avif，≤20MB）</div>
    <input type="file" id="file" accept="image/*" hidden multiple>
    <div class="vispick">
      <label><input type="radio" name="vis" value="private" checked> 私有</label>
      <label><input type="radio" name="vis" value="public"> 公开</label>
    </div>
    <input id="urlin" placeholder="图片 URL（http/https）" style="flex:1;min-width:160px;padding:7px 10px;border:1px solid var(--inp);border-radius:6px;font-size:13px">
    <button type="button" onclick="urlUpload()" style="padding:7px 14px;background:var(--acc);color:#fff;border:0;border-radius:6px;font-size:13px;cursor:pointer;white-space:nowrap">从 URL 上传</button>
    <div class="qremain" style="flex-basis:100%;font-size:12px;color:${usedPct >= 80 ? "var(--dan)" : "var(--mut)"}">剩余配额 ${fmtBytes(remain)}${usedPct >= 80 ? " · 配额即将用尽，注意清理" : ""}</div>
    <div id="prog"></div>
  </div>`;

  // v1.10: search + visibility filter + sort bar
  const filterBar = `<form class="filterbar" method="get" action="/gallery">
    <input type="search" name="q" value="${escapeHtml(filters.q)}" placeholder="搜索文件名…">
    <select name="vis" onchange="this.form.submit()">
      <option value="all"${filters.vis === "all" ? " selected" : ""}>全部</option>
      <option value="private"${filters.vis === "private" ? " selected" : ""}>私有</option>
      <option value="public"${filters.vis === "public" ? " selected" : ""}>公开</option>
    </select>
    <select name="sort" onchange="this.form.submit()">
      ${Object.entries(SORT_LABELS).map(([v, l]) => `<option value="${v}"${filters.sort === v ? " selected" : ""}>${l}</option>`).join("")}
    </select>
    <button type="submit">筛选</button>
    ${filtersActive ? '<a class="clear" href="/gallery">清除筛选</a>' : ""}
  </form>`;

  const filterDesc = [
    filters.q ? `关键词「${escapeHtml(filters.q)}」` : "",
    filters.vis !== "all" ? (filters.vis === "public" ? "仅公开" : "仅私有") : "",
    filters.sort !== "newest" ? SORT_LABELS[filters.sort] : "",
  ].filter(Boolean).join(" · ");
  const resultLine = `<div class="resultline">共 <b>${totalCount}</b> 张图片${filterDesc ? ` · 筛选条件：${filterDesc}` : ""}</div>`;

  const cells = images.length
    ? `<div class="grid" id="grid">${images
        .map(
          (im, idx) => `
      <div class="cell" data-id="${im.public_id}">
        <input type="checkbox" class="pick" value="${im.public_id}" onclick="pickClick(event)" title="选择">
        <span class="badge">${im.visibility === "public" ? "公开" : "私有"}</span>
        <div class="ph"><a href="/i/${im.public_id}" target="_blank" onclick="openLb(${idx});return false"><img loading="lazy" decoding="async" src="/t/${im.public_id}" alt="${escapeHtml(im.original_name)}"></a></div>
        <div class="meta">
          <div class="nm">${escapeHtml(im.original_name)}</div>
          <div>${fmtBytes(im.size_bytes)} · ${fmtDate(im.created_at)} · ${im.views} 次浏览</div>
        </div>
        <div class="acts">
          <a href="#" onclick="copyLink('${im.public_id}');return false">复制链接</a>
          <a href="#" onclick="shareImg('${im.public_id}');return false">分享</a>
          <a href="#" onclick="renameImg('${im.public_id}');return false">重命名</a>
          <button class="del" onclick="delImg('${im.public_id}')">删除</button>
        </div>
      </div>`,
        )
        .join("")}</div>`
    : filtersActive
      ? `<div class="empty">没有匹配的图片${filterDesc ? `（${filterDesc}）` : ""}<br><br><a href="/gallery" style="color:var(--acc)">清除筛选条件，查看全部图片</a></div>`
      : `<div class="empty">还没有图片，把图片拖到上方区域开始上传</div>`;

  // v1.20: selection toolbar — shown only when at least one card is picked.
  const selBar = images.length
    ? `<div class="selbar" id="selbar">
    <b>已选 <span id="seln">0</span> 张</b>
    <button type="button" onclick="selAll()">全选本页</button>
    <button type="button" onclick="selInvert()">反选</button>
    <button type="button" onclick="selClear()">清除</button>
    <span class="spacer"></span>
    <button type="button" onclick="batchVis('public')">设为公开</button>
    <button type="button" onclick="batchVis('private')">设为私有</button>
    <button type="button" class="danger" onclick="batchDel()">删除</button>
  </div>`
    : "";

  const lightbox = images.length
    ? `<div class="lightbox" id="lightbox">
  <div class="lb-stage">
    <img id="lbimg" src="" alt="">
    <button class="lb-nav lb-prev" onclick="lbStep(-1)" title="上一张（←）">‹</button>
    <button class="lb-nav lb-next" onclick="lbStep(1)" title="下一张（→）">›</button>
  </div>
  <div class="lb-bar">
    <span class="lb-counter" id="lbcounter"></span>
    <span class="lb-info"><span class="lb-name" id="lbname"></span> <span class="lb-meta" id="lbmeta"></span><br><span class="lb-exif" id="lbexif" style="display:none"></span></span>
    <button onclick="lbToggleInfo()" title="显示/隐藏信息（i）">信息</button>
    <button onclick="copyLink(lbIdx>=0?IMGS[lbIdx].id:0);return false">复制链接</button>
    <button onclick="closeLb()" title="关闭（Esc）">关闭</button>
  </div>
</div>`
    : "";

  const pager = pagerHtml(page, totalPages, filters);

  // v1.13: share-link modal (create time-limited /s/<token> links)
  const shareModal = `<div class="shmodal" id="shmodal" onclick="if(event.target===this)closeShare()">
  <div class="shbox">
    <h3>创建分享链接</h3>
    <p style="font-size:13px;color:var(--mut);margin:0" id="shname"></p>
    <div class="shopts">
      <button type="button" onclick="shareCreate(1)">1 天</button>
      <button type="button" onclick="shareCreate(7)">7 天</button>
      <button type="button" onclick="shareCreate(30)">30 天</button>
      <button type="button" onclick="shareCreate(0)">永久</button>
    </div>
    <div id="shresult"><input id="shurl" readonly onclick="this.select()"><button type="button" onclick="copyShareUrl()">复制</button></div>
    <button type="button" class="shclose" onclick="closeShare()">关闭</button>
  </div>
</div>`;

  // v1.7: lightbox dataset (JSON-safe: escape '<' so a filename can't break out of <script>)
  // v1.12: exif parsed server-side and passed along for the info bar.
  const lbData = JSON.stringify(
    images.map((im) => {
      let exif = null;
      if (im.exif) {
        try {
          exif = JSON.parse(im.exif);
        } catch {
          exif = null;
        }
      }
      return {
        id: im.public_id,
        name: im.original_name,
        size: im.size_bytes,
        vis: im.visibility,
        views: im.views,
        at: im.created_at,
        exif,
      };
    }),
  ).replace(/</g, "\\u003c");

  const js = `
<script>
const IMGS = ${lbData};
let lbIdx = -1;
const drop = document.getElementById('drop'), fileInput = document.getElementById('file'), prog = document.getElementById('prog');
function curVis(){ return document.querySelector('input[name=vis]:checked').value; }
function fmtBytes(n){ if(n<1024) return n+' B'; if(n<1048576) return (n/1024).toFixed(1)+' KiB'; return (n/1048576).toFixed(2)+' MiB'; }
// v1.6: client-side quota projection (server remains authoritative)
const Q_USED = ${user.used_bytes}, Q_TOTAL = ${user.quota_bytes};
let queued = 0;
let pending = 0;
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
// v1.9: upload from a remote URL (size unknown upfront; server stays authoritative)
async function urlUpload() {
  const u = document.getElementById('urlin').value.trim();
  if (!u) return;
  pending++;
  const row = document.createElement('div'); row.className = 'prow';
  const nm = document.createElement('div'); nm.className = 'pnm'; nm.textContent = u;
  const st = document.createElement('div'); st.className = 'pst'; st.textContent = '抓取中…';
  row.appendChild(nm); row.appendChild(st); prog.appendChild(row);
  let ok = false, msg = '';
  try {
    const r = await fetch('/api/upload-url', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({url:u, visibility:curVis()})});
    const j = await r.json().catch(() => ({}));
    ok = r.ok && !!j.id;
    msg = ok ? ('已上传: ' + (j.original_name || u) + (j.visibility === 'public' ? '（公开）' : '')) : ('失败: ' + (j.message || j.error || ('HTTP ' + r.status)));
  } catch { msg = '网络错误'; }
  st.textContent = msg;
  st.className = 'pst ' + (ok ? 'ok' : 'err');
  toast(msg);
  pending--;
  if (pending <= 0) setTimeout(() => location.reload(), 900);
}
function upload(f) {
  if (Q_USED + queued + f.size > Q_TOTAL) {
    const skip = document.createElement('div'); skip.className = 'prow';
    const nm = document.createElement('div'); nm.className = 'pnm'; nm.textContent = f.name + ' · ' + fmtBytes(f.size);
    const st = document.createElement('div'); st.className = 'pst warn';
    st.textContent = '已跳过：超出剩余配额（还需 ' + fmtBytes(Q_USED + queued + f.size - Q_TOTAL) + '）';
    skip.appendChild(nm); skip.appendChild(st); prog.appendChild(skip);
    toast(st.textContent);
    return;
  }
  queued += f.size;
  pending++;
  const row = document.createElement('div'); row.className = 'prow';
  const nm = document.createElement('div'); nm.className = 'pnm'; nm.textContent = f.name + ' · ' + fmtBytes(f.size) + ' · ' + curVis();
  const bar = document.createElement('div'); bar.className = 'pbar';
  const fill = document.createElement('div'); fill.className = 'pfill';
  const st = document.createElement('div'); st.className = 'pst'; st.textContent = '上传中 0%';
  bar.appendChild(fill); row.appendChild(nm); row.appendChild(bar); row.appendChild(st);
  prog.appendChild(row);
  const fd = new FormData(); fd.append('file', f); fd.append('visibility', curVis());
  const xhr = new XMLHttpRequest();
  xhr.upload.onprogress = e => {
    if (e.lengthComputable) {
      const pct = Math.round(e.loaded / e.total * 100);
      fill.style.width = pct + '%';
      st.textContent = '上传中 ' + pct + '%（' + fmtBytes(e.loaded) + ' / ' + fmtBytes(e.total) + '）';
    } else { st.textContent = '上传中…'; }
  };
  function settle(msg, ok, f) {
    pending--;
    if (!ok && f) queued -= f.size;
    st.textContent = msg;
    st.className = 'pst ' + (ok ? 'ok' : 'err');
    fill.style.width = '100%';
    if (!ok) fill.style.background = 'var(--dan)';
    toast(msg);
    if (pending <= 0) setTimeout(() => location.reload(), 900);
  }
  xhr.onload = () => {
    let j = {};
    try { j = JSON.parse(xhr.responseText); } catch {}
    if (xhr.status >= 200 && xhr.status < 300 && j.id) settle('已上传: ' + (j.original_name || f.name) + (j.visibility === 'public' ? '（公开）' : ''), true);
    else settle('失败: ' + f.name + ' — ' + (j.message || j.error || ('HTTP ' + xhr.status)), false, f);
  };
  xhr.onerror = () => settle('网络错误: ' + f.name, false, f);
  xhr.open('POST', '/api/upload');
  xhr.send(fd);
}
function copyLink(id) {
  const url = location.origin + '/i/' + id;
  navigator.clipboard.writeText(url).then(() => toast('链接已复制: ' + url), () => prompt('复制链接:', url));
}
/* ---- v1.13 share links ---- */
let shareImgId = 0;
function shareImg(id) {
  shareImgId = id;
  document.getElementById('shname').textContent = '为图片 #' + id + '创建带有效期的分享链接（私有图片不会变公开）';
  document.getElementById('shresult').style.display = 'none';
  document.getElementById('shmodal').classList.add('on');
}
function closeShare() { document.getElementById('shmodal').classList.remove('on'); }
async function shareCreate(days) {
  const body = days > 0 ? { expires_in_days: days } : { never: true };
  let j = {};
  try {
    const r = await fetch('/api/images/' + shareImgId + '/share', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    j = await r.json().catch(() => ({}));
    if (r.ok && j.url) {
      document.getElementById('shurl').value = location.origin + j.url;
      document.getElementById('shresult').style.display = 'flex';
      toast('分享链接已创建' + (j.expires_at ? '（' + j.expires_at.slice(0, 10) + ' 到期）' : '（永久有效）'));
      return;
    }
  } catch {}
  toast('创建失败: ' + (j.message || j.error || '网络错误'));
}
function copyShareUrl() {
  const u = document.getElementById('shurl').value;
  navigator.clipboard.writeText(u).then(() => toast('链接已复制'), () => prompt('复制链接:', u));
}
/* ---- v1.7 lightbox ---- */
const lb = document.getElementById('lightbox');
let touchX = null;
function lbRender() {
  const im = IMGS[lbIdx];
  if (!im) return;
  document.getElementById('lbimg').src = '/i/' + im.id;
  document.getElementById('lbimg').alt = im.name;
  document.getElementById('lbcounter').textContent = (lbIdx + 1) + ' / ' + IMGS.length;
  document.getElementById('lbname').textContent = im.name;
  document.getElementById('lbmeta').textContent = fmtBytes(im.size) + ' · ' + (im.vis === 'public' ? '公开' : '私有') + ' · ' + im.views + ' 次浏览';
  // v1.12: EXIF line (camera/shot settings/dimensions), hidden when absent
  const ex = document.getElementById('lbexif');
  const e = im.exif;
  if (e) {
    const parts = [];
    if (e.width && e.height) parts.push(e.width + '×' + e.height);
    if (e.camera) parts.push(e.camera);
    if (e.taken_at) parts.push('拍摄于 ' + e.taken_at);
    const settings = [e.exposure, e.fnumber, e.iso != null ? 'ISO ' + e.iso : null, e.focal].filter(Boolean).join(' · ');
    if (settings) parts.push(settings);
    if (e.lens) parts.push(e.lens);
    if (e.gps) parts.push('GPS ' + e.gps[0].toFixed(4) + ', ' + e.gps[1].toFixed(4));
    ex.textContent = parts.join(' · ');
    ex.style.display = parts.length ? 'block' : 'none';
  } else {
    ex.style.display = 'none';
  }
}
function openLb(i) {
  if (i < 0 || i >= IMGS.length) return;
  lbIdx = i;
  lbRender();
  lb.classList.add('on');
  document.body.style.overflow = 'hidden';
}
function closeLb() {
  lb.classList.remove('on');
  document.body.style.overflow = '';
  lbIdx = -1;
}
function lbStep(d) {
  if (lbIdx < 0) return;
  lbIdx = (lbIdx + d + IMGS.length) % IMGS.length;
  lbRender();
}
function lbToggleInfo() { lb.classList.toggle('lb-hidden'); }
document.addEventListener('keydown', e => {
  if (lbIdx < 0) return;
  if (e.key === 'Escape') closeLb();
  else if (e.key === 'ArrowRight') lbStep(1);
  else if (e.key === 'ArrowLeft') lbStep(-1);
  else if (e.key === 'i' || e.key === 'I') lbToggleInfo();
});
const lbStage = lb.querySelector('.lb-stage');
lbStage.addEventListener('click', e => { if (e.target === lbStage) closeLb(); });
lb.addEventListener('touchstart', e => { touchX = e.touches[0].clientX; }, {passive:true});
lb.addEventListener('touchend', e => {
  if (touchX === null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  if (dx > 50) lbStep(-1); else if (dx < -50) lbStep(1);
  touchX = null;
}, {passive:true});
async function renameImg(id) {
  const name = prompt('新文件名：');
  if (!name) return;
  const fd = new FormData(); fd.append('name', name);
  const r = await fetch('/images/' + id + '/rename', { method: 'POST', body: fd });
  const j = await r.json();
  if (r.ok) { toast('已重命名'); setTimeout(() => location.reload(), 500); }
  else toast('失败: ' + (j.message || j.error));
}
async function delImg(id) {
  if (!confirm('确定删除这张图片？删除后可在回收站恢复。')) return;
  const r = await fetch('/images/' + id + '/delete', { method: 'POST' });
  const j = await r.json();
  if (r.ok) { toast('已删除'); setTimeout(() => location.reload(), 500); }
  else toast('失败: ' + (j.message || j.error));
}
/* ---- v1.20 multi-select + batch actions ---- */
let lastPick = -1;
function pickBoxes() { return Array.from(document.querySelectorAll('.pick')); }
function selIds() { return pickBoxes().filter(b => b.checked).map(b => String(b.value)); }
function syncSel() {
  const bar = document.getElementById('selbar');
  if (!bar) return;
  const n = selIds().length;
  document.getElementById('seln').textContent = n;
  bar.classList.toggle('on', n > 0);
  pickBoxes().forEach(b => { const c = b.closest('.cell'); if (c) c.classList.toggle('sel', b.checked); });
}
function pickClick(e) {
  const boxes = pickBoxes();
  const i = boxes.indexOf(e.target);
  if (e.shiftKey && lastPick >= 0 && lastPick !== i) {
    const on = e.target.checked;
    for (let k = Math.min(lastPick, i); k <= Math.max(lastPick, i); k++) boxes[k].checked = on;
  }
  lastPick = i;
  syncSel();
}
function selAll() { pickBoxes().forEach(b => { b.checked = true; }); syncSel(); }
function selInvert() { pickBoxes().forEach(b => { b.checked = !b.checked; }); syncSel(); }
function selClear() { pickBoxes().forEach(b => { b.checked = false; }); lastPick = -1; syncSel(); }
async function batchPost(path, payload) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  let j = {};
  try { j = await r.json(); } catch {}
  return { ok: r.ok, j };
}
async function batchVis(v) {
  const ids = selIds();
  if (!ids.length) return;
  const { ok, j } = await batchPost('/api/images/batch-visibility', { ids, visibility: v });
  toast(ok ? '已更新 ' + (j.updated || 0) + ' 张为' + (v === 'public' ? '公开' : '私有') : '失败: ' + (j.message || j.error));
  if (ok) setTimeout(() => location.reload(), 700);
}
async function batchDel() {
  const ids = selIds();
  if (!ids.length) return;
  if (!confirm('确定删除选中的 ' + ids.length + ' 张图片？删除后可在回收站恢复。')) return;
  const { ok, j } = await batchPost('/api/images/batch-delete', { ids });
  toast(ok ? '已删除 ' + (j.deleted != null ? j.deleted : ids.length) + ' 张' : '失败: ' + (j.message || j.error));
  if (ok) setTimeout(() => location.reload(), 700);
}
(function initSel() {
  const bar = document.getElementById('selbar');
  if (!bar) return;
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && lbIdx < 0) selClear(); });
  syncSel();
})();
</script>`;

  return layout("图库", stats + uploadBar + filterBar + resultLine + selBar + cells + pager + lightbox + shareModal + js, user);
}

/** Parse a D1 timestamp in either stored shape (JS ISO "…T…Z" or SQLite
 *  "YYYY-MM-DD HH:MM:SS"); both are UTC. Returns epoch ms or NaN. */
function parseDbTime(s) {
  const t = String(s || "").trim();
  if (!t) return NaN;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(t)) return new Date(t).getTime();
  return new Date(t.replace(" ", "T") + "Z").getTime();
}

/** v1.11: when this trashed item will be auto-purged (human text). */
function trashExpiryHint(deletedAt, days) {
  if (!days || days <= 0) return "长期保留";
  const at = parseDbTime(deletedAt);
  if (!Number.isFinite(at)) return "长期保留";
  const ms = at + days * 86400000 - Date.now();
  if (ms <= 0) return "已过期，将被自动清除";
  const d = Math.ceil(ms / 86400000);
  return `${d} 天后自动清除`;
}

export function trashPage(user, images, trashRetention = 30) {
  const rows = images.length
    ? images
        .map(
          (im) => `
      <div class="cell" data-id="${im.public_id}">
        <input type="checkbox" class="pick" value="${im.public_id}" onclick="pickClick(event)" title="选择">
        <div class="ph"><img loading="lazy" decoding="async" src="/t/${im.public_id}" alt="${escapeHtml(im.original_name)}"></div>
        <div class="meta">
          <div class="nm">${escapeHtml(im.original_name)}</div>
          <div>${fmtBytes(im.size_bytes)} · 删除于 ${fmtDate(im.deleted_at || "")}</div>
          <div style="color:var(--warn)">${trashExpiryHint(im.deleted_at, trashRetention)}</div>
        </div>
        <div class="acts">
          <a href="#" onclick="restoreImg('${im.public_id}');return false">恢复</a>
          <button class="del" onclick="purgeImg('${im.public_id}')">彻底删除</button>
        </div>
      </div>`,
        )
        .join("")
    : `<div class="empty">回收站是空的</div>`;

  // v1.20: batch restore / batch purge over the current page.
  const selBar = images.length
    ? `<div class="selbar" id="selbar">
    <b>已选 <span id="seln">0</span> 项</b>
    <button type="button" onclick="selAll()">全选本页</button>
    <button type="button" onclick="selInvert()">反选</button>
    <button type="button" onclick="selClear()">清除</button>
    <span class="spacer"></span>
    <button type="button" onclick="batchRestore()">批量恢复</button>
    <button type="button" class="danger" onclick="batchPurge()">批量彻底删除</button>
  </div>`
    : "";

  const policy = trashRetention > 0
    ? `当前策略：回收站保留 <b>${trashRetention}</b> 天，到期项目可由管理员在「管理 → 立即清理回收站」彻底删除（含 Drive 文件）；v2.38 起不再每日自动执行`
    : "当前策略：回收站不自动清理，所有项目长期保留";

  const js = `
<script>
async function restoreImg(id) {
  const r = await fetch('/images/' + id + '/restore', { method: 'POST' });
  const j = await r.json();
  toast(r.ok ? '已恢复' : '失败: ' + (j.message || j.error));
  if (r.ok) setTimeout(() => location.reload(), 500);
}
async function purgeImg(id) {
  if (!confirm('彻底删除将同时删除云端文件，不可恢复。确定？')) return;
  const r = await fetch('/images/' + id + '/purge', { method: 'POST' });
  const j = await r.json();
  toast(r.ok ? '已彻底删除' : '失败: ' + (j.message || j.error));
  if (r.ok) setTimeout(() => location.reload(), 500);
}
async function emptyTrash() {
  if (!confirm('确定清空回收站？所有云端文件将被永久删除。')) return;
  const r = await fetch('/images/purge-all', { method: 'POST' });
  const j = await r.json();
  toast(r.ok ? '回收站已清空（' + (j.purged || 0) + ' 个文件）' : '失败: ' + (j.message || j.error));
  if (r.ok) setTimeout(() => location.reload(), 800);
}
/* ---- v1.20 multi-select + batch actions ---- */
let lastPick = -1;
function pickBoxes() { return Array.from(document.querySelectorAll('.pick')); }
function selIds() { return pickBoxes().filter(b => b.checked).map(b => String(b.value)); }
function syncSel() {
  const bar = document.getElementById('selbar');
  if (!bar) return;
  const n = selIds().length;
  document.getElementById('seln').textContent = n;
  bar.classList.toggle('on', n > 0);
  pickBoxes().forEach(b => { const c = b.closest('.cell'); if (c) c.classList.toggle('sel', b.checked); });
}
function pickClick(e) {
  const boxes = pickBoxes();
  const i = boxes.indexOf(e.target);
  if (e.shiftKey && lastPick >= 0 && lastPick !== i) {
    const on = e.target.checked;
    for (let k = Math.min(lastPick, i); k <= Math.max(lastPick, i); k++) boxes[k].checked = on;
  }
  lastPick = i;
  syncSel();
}
function selAll() { pickBoxes().forEach(b => { b.checked = true; }); syncSel(); }
function selInvert() { pickBoxes().forEach(b => { b.checked = !b.checked; }); syncSel(); }
function selClear() { pickBoxes().forEach(b => { b.checked = false; }); lastPick = -1; syncSel(); }
async function batchPost(path, payload) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  let j = {};
  try { j = await r.json(); } catch {}
  return { ok: r.ok, j };
}
async function batchRestore() {
  const ids = selIds();
  if (!ids.length) return;
  const { ok, j } = await batchPost('/api/images/batch-restore', { ids });
  if (!ok) return toast('失败: ' + (j.message || j.error));
  const n = j.restored || 0;
  toast('已恢复 ' + n + ' 张' + (n < ids.length ? '（' + (ids.length - n) + ' 张因超出配额已跳过）' : ''));
  setTimeout(() => location.reload(), 800);
}
async function batchPurge() {
  const ids = selIds();
  if (!ids.length) return;
  if (!confirm('彻底删除选中的 ' + ids.length + ' 项？云端文件将一并删除，不可恢复。')) return;
  const { ok, j } = await batchPost('/api/images/batch-purge', { ids });
  toast(ok ? '已彻底删除 ' + (j.purged || 0) + ' 项' : '失败: ' + (j.message || j.error));
  if (ok) setTimeout(() => location.reload(), 800);
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') selClear(); });
if (document.getElementById('selbar')) syncSel();
</script>`;

  return layout(
    "回收站",
    `<div class="stats"><div class="stat">回收站文件<b>${images.length}</b></div></div>
     <div class="resultline">${policy}</div>
     ${images.length ? '<div class="uploadbar"><button onclick="emptyTrash()" style="color:var(--dan);border-color:var(--del-line)">清空回收站</button></div>' : ""}
     ${selBar}<div class="grid" id="grid">${rows}</div>${js}`,
    user,
  );
}

const INVITE_STATUS_TEXT = {
  active: "可用",
  used_up: "已用完",
  expired: "已过期",
  revoked: "已吊销",
};

/** v1.13: share-link management page. */
export function sharesPage(user, shares) {
  const rows = shares.length
    ? shares
        .map(
          (s) => `
      <div class="cell" data-id="${s.id}" style="height:auto">
        <div class="ph"><img loading="lazy" decoding="async" src="/t/${s.image_public_id}" alt="${escapeHtml(s.original_name || "")}"></div>
        <div class="meta">
          <div class="nm">${escapeHtml(s.original_name || "")}${s.image_deleted ? ' <span style="color:var(--dan)">（原图已删除）</span>' : ""}</div>
          <div><code style="user-select:all;font-size:11px">/s/${escapeHtml(s.token)}</code></div>
          <div>${shareExpiryText(s)} · ${s.views} 次访问</div>
        </div>
        <div class="acts">
          <a href="#" onclick="copyShare(${s.id});return false">复制链接</a>
          <button class="del" onclick="revokeShare(${s.id})">吊销</button>
        </div>
      </div>`,
        )
        .join("")
    : `<div class="empty">还没有分享链接。在图库中点图片下方的「分享」即可创建带有效期的链接。</div>`;

  const js = `
<script>
const SHARE_URLS = {${shares.map((s) => `${s.id}: ${JSON.stringify("/s/" + s.token)}`).join(",")}};
function copyShare(id) {
  const url = location.origin + (SHARE_URLS[id] || '');
  if (!SHARE_URLS[id]) return;
  navigator.clipboard.writeText(url).then(() => toast('链接已复制'), () => prompt('复制链接:', url));
}
async function revokeShare(id) {
  if (!confirm('吊销后该链接立即失效，确定？')) return;
  const r = await fetch('/api/shares/' + id, { method: 'DELETE' });
  const j = await r.json().catch(() => ({}));
  toast(r.ok ? '已吊销' : '失败: ' + (j.message || j.error));
  if (r.ok) setTimeout(() => location.reload(), 500);
}
</script>`;

  return layout(
    "分享管理",
    `<div class="stats"><div class="stat">有效分享链接<b>${shares.length}</b></div></div>
     <div class="resultline">分享链接按创建时设定的有效期自动失效；吊销立即生效。私有图片通过分享链接访问时不会变为公开。</div>
     <div class="grid">${rows}</div>${js}`,
    user,
  );
}

export function sessionsPage(user, sessions, currentId, msg = "") {
  const rows = sessions.length
    ? sessions
        .map((s) => {
          const cur = Number(s.id) === Number(currentId);
          return `
      <tr>
        <td>${cur ? '<b style="color:var(--ok)">当前设备</b>' : s.device}</td>
        <td>${cur ? escapeHtml(s.device) + ' · 当前' : escapeHtml(s.device)}</td>
        <td>${escapeHtml(s.ip || "—")}</td>
        <td>${s.last_seen_at ? fmtDate(s.last_seen_at) : fmtDate(s.created_at)}</td>
        <td>${fmtDate(s.created_at)}</td>
        <td>${s.active ? '<span style="color:var(--ok)">活跃</span>' : '<span style="color:var(--mut)">已过期</span>'}</td>
        <td>${cur ? '<span style="color:var(--mut)">—</span>' : `<form method="post" action="/sessions/${s.id}/revoke" style="margin:0" onsubmit="return confirm('注销该设备？该设备需重新登录。')"><button style="font-size:12px;padding:3px 10px;border:1px solid var(--del-line);border-radius:5px;background:var(--card);color:var(--dan);cursor:pointer">注销</button></form>`}</td>
      </tr>`;
        })
        .join("")
    : `<tr><td colspan="7" style="color:var(--mut);padding:16px;text-align:center">没有活跃会话</td></tr>`;
  const noticeHtml = msg ? `<div class="notice-ok">${escapeHtml(msg)}</div>` : "";
  const others = sessions.filter((s) => Number(s.id) !== Number(currentId)).length;
  return layout(
    "登录设备",
    `${noticeHtml}
     <div class="stats"><div class="stat">活跃会话<b>${sessions.length}</b></div></div>
     <div class="card">
       <h3>登录设备</h3>
       <p style="font-size:13px;color:var(--mut);margin:0 0 12px">同一账号在所有设备上的登录记录。注销后该设备需重新登录；「当前设备」不可在此注销（请直接用退出登录）。</p>
       ${others ? `<form method="post" action="/sessions/revoke-others" style="margin:0 0 12px" onsubmit="return confirm('注销其他 ${others} 个设备？')"><button style="padding:8px 16px;background:var(--dan);color:#fff;border:0;border-radius:6px;font-size:13px;cursor:pointer">注销其他所有设备（${others}）</button></form>` : ""}
       <div class="tablewrap"><table style="width:100%;border-collapse:collapse;font-size:13px">
         <thead><tr><th>设备</th><th>客户端</th><th>IP</th><th>最后活跃</th><th>登录时间</th><th>状态</th><th>操作</th></tr></thead>
         <tbody>${rows}</tbody>
       </table></div>
     </div>`,
    user,
  );
}

export function adminPage(user, users, sysStats, invites = [], newInviteCode = "", defaultQuota = 1073741824, trashRetention = 30, notice = null, uFilters = {}, exploreOn = true) {
  const noticeHtml = notice
    ? notice.ok
      ? `<div class="notice-ok">${escapeHtml(notice.ok)}</div>`
      : `<div class="notice-err">${escapeHtml(notice.err)}</div>`
    : "";
  // v1.16: preserve user-list filters across action posts (quota/status/delete)
  const uq = uFilters.q || "";
  const ustatus = uFilters.status || "";
  const uKeep = `${uq ? `q=${encodeURIComponent(uq)}&` : ""}${ustatus ? `status=${encodeURIComponent(ustatus)}&` : ""}`.replace(/&$/, "");
  const uAct = uKeep ? `/admin?${uKeep}` : "/admin";
  const uRows = users
    .map(
      (u) => `<tr>
      <td>${u.id}</td>
      <td>${escapeHtml(u.email)}${u.role === "admin" ? ' <b style="color:var(--acc)">[管理员]</b>' : ""}</td>
      <td>${escapeHtml(u.display_name)}</td>
      <td>${u.status === "active" ? '<b style="color:var(--ok)">正常</b>' : '<b style="color:var(--dan)">已禁用</b>'}</td>
      <td>${u.images}</td>
      <td>${fmtBytes(u.bytes)}</td>
      <td>
        <span>${fmtBytes(u.quota_bytes)}</span>
        <form method="post" action="/admin/users/${u.id}/quota" style="display:inline-flex;gap:4px;margin-left:8px">
          <input name="quota" placeholder="如 500G / 2T" size="9" style="padding:3px 6px;border:1px solid var(--inp);background:var(--inp-bg);color:var(--txt);border-radius:5px;font-size:12px">
          <button style="font-size:12px;padding:3px 10px;border:1px solid var(--line);border-radius:5px;background:var(--card);color:var(--txt);cursor:pointer">设配额</button>
        </form>
      </td>
      <td>${escapeHtml((u.created_at || "").slice(0, 10))}</td>
      <td style="white-space:nowrap">
        <form method="post" action="/admin/users/${u.id}/status" style="display:inline">
          <input type="hidden" name="status" value="${u.status === "active" ? "disabled" : "active"}">
          <button style="font-size:12px;padding:3px 10px;border:1px solid var(--line);border-radius:5px;background:var(--card);color:var(--txt);cursor:pointer">${u.status === "active" ? "禁用" : "启用"}</button>
        </form>
        ${u.id === user.id ? "" : `<form method="post" action="/admin/users/${u.id}/delete" style="display:inline" onsubmit="return confirm('删除用户 ${escapeHtml(u.email)} 将同时删除其全部图片、会话、密钥与分享链接（云端文件后台清理），不可恢复。确定？')"><button style="font-size:12px;padding:3px 10px;border:1px solid var(--del-line);border-radius:5px;background:var(--card);color:var(--dan);cursor:pointer">删除</button></form>`}
      </td>
    </tr>`,
    )
    .join("");
  const rows = uRows;
  const flash = newInviteCode
    ? `<div style="background:#eff6ff;border:1px solid var(--inv-line);border-radius:8px;padding:12px 16px;margin-bottom:16px;font-size:14px">
       新邀请码已生成（仅本次显示，请立即复制分发）：
       <code id="newcode" style="user-select:all;font-size:15px;letter-spacing:1px">${escapeHtml(newInviteCode)}</code>
       <button type="button" onclick="navigator.clipboard.writeText(document.getElementById('newcode').textContent).then(()=>{this.textContent='已复制';})" style="margin-left:10px;padding:4px 12px;border:1px solid var(--inv-line);border-radius:6px;background:#fff;cursor:pointer;font-size:13px">复制</button>
     </div>`
    : "";
  const inviteRows = (invites || [])
    .map((i) => {
      const st = i.status || "active";
      const stColor = st === "active" ? "var(--ok)" : st === "used_up" ? "var(--mut)" : "var(--dan)";
      const exp = i.expires_at ? escapeHtml(i.expires_at.slice(0, 10)) : "永久";
      const usedBy = i.used_by ? `#${i.used_by}` : "—";
      return `<tr>
      <td><code style="user-select:all">${escapeHtml(i.code)}</code></td>
      <td>${escapeHtml(i.note || "")}</td>
      <td>${i.used_count}/${i.max_uses}</td>
      <td>${usedBy}</td>
      <td>${exp}</td>
      <td style="color:${stColor};font-weight:600">${INVITE_STATUS_TEXT[st] || st}</td>
      <td>${escapeHtml((i.created_at || "").slice(0, 10))}</td>
      <td>${escapeHtml(i.creator_email || "")}</td>
      <td>${st === "active" ? `<form method="post" action="/admin/invites/${i.id}/revoke" style="margin:0"><button style="font-size:12px;padding:4px 10px;border:1px solid var(--del-line);border-radius:6px;background:var(--card);color:var(--dan);cursor:pointer">吊销</button></form>` : ""}</td>
    </tr>`;
    })
    .join("");
  return layout(
    "管理后台",
    `${flash}${noticeHtml}<div class="stats">
      <div class="stat">注册用户<b>${sysStats.users}</b></div>
      <div class="stat">图片总数<b>${sysStats.images}</b></div>
      <div class="stat">占用空间<b>${fmtBytes(sysStats.bytes)}</b></div>
      <div class="stat">邀请码<b>${(invites || []).length}</b></div>
    </div>
    <div class="card">
    <h3 style="margin-top:0">全局设置</h3>
    <p style="margin:0 0 12px"><a href="/audit" style="font-size:13px">查看审计日志 →</a><a href="/admin/storage" style="font-size:13px;margin-left:16px">存储分片 →</a></p>
    <form method="post" action="/admin/settings" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
      <label style="font-size:13px;color:var(--label)">新用户默认配额<input name="default_quota" required placeholder="如 500G / 1T" style="display:block;margin-top:4px;padding:7px 10px;border:1px solid var(--inp);border-radius:6px;font-size:14px;width:160px"></label>
      <label style="font-size:13px;color:var(--label)">回收站保留天数（0=永不清理）<input name="trash_retention_days" type="number" min="0" max="3650" value="${trashRetention}" style="display:block;margin-top:4px;padding:7px 10px;border:1px solid var(--inp);border-radius:6px;font-size:14px;width:160px"></label>
      <label style="font-size:13px;color:var(--label)">公开画廊 /explore
        <select name="explore_enabled" style="display:block;margin-top:4px;padding:7px 10px;border:1px solid var(--inp);border-radius:6px;font-size:14px;width:160px">
          <option value="1"${exploreOn ? " selected" : ""}>开启（匿名可见公开图）</option>
          <option value="0"${exploreOn ? "" : " selected"}>关闭</option>
        </select>
      </label>
      <button type="submit" style="padding:8px 18px;background:var(--acc);color:#fff;border:0;border-radius:6px;font-size:14px;cursor:pointer">保存设置</button>
    </form>
    <p style="font-size:12px;color:var(--mut);margin:10px 0 0">当前默认配额：<b>${fmtBytes(defaultQuota)}</b>（${formatSize(defaultQuota)}），只影响<b>新注册</b>用户，已有用户请在下方用户表单独调整。回收站策略：删除超过 <b>${trashRetention}</b> 天的图片属于过期项，在下方点「立即清理回收站」时彻底删除（含 Drive 文件）；v2.38 起已移除每日定时清扫（Pages Functions 无 cron），需管理员手动触发。公开画廊：<b>${exploreOn ? "开启" : "关闭"}</b>（<a href="/explore" style="color:var(--acc)">查看</a>）——只展示被标记为公开的图片，不显示所有者信息。</p>
    </div>
    <div class="card">
    <h3 style="margin-top:0">回收站清理（v1.11；v2.38 起改为手动触发）</h3>
    <form method="post" action="/admin/trash-sweep" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <button type="submit" style="padding:8px 18px;background:var(--dan);color:#fff;border:0;border-radius:6px;font-size:14px;cursor:pointer">立即清理回收站</button>
      <span style="font-size:12px;color:var(--mut)">按当前保留天数（${trashRetention} 天）立即彻底删除所有过期项（含 Drive 云端文件，不可恢复）；0 天策略下不清理任何内容。</span>
    </form>
    </div>
    <div class="card">
    <h3 style="margin-top:0">邀请码（注册唯一入口，仅管理员可生成/分发）</h3>
    <form method="post" action="/admin/invites" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px">
      <label style="font-size:13px;color:var(--label)">备注<input name="note" maxlength="120" placeholder="给谁用/用途" style="display:block;margin-top:4px;padding:7px 10px;border:1px solid var(--inp);border-radius:6px;font-size:14px;width:200px"></label>
      <label style="font-size:13px;color:var(--label)">可用次数<input name="max_uses" type="number" min="1" max="100" value="1" style="display:block;margin-top:4px;padding:7px 10px;border:1px solid var(--inp);border-radius:6px;font-size:14px;width:90px"></label>
      <label style="font-size:13px;color:var(--label)">有效期（天，空=永久）<input name="expires_days" type="number" min="1" max="365" placeholder="30" style="display:block;margin-top:4px;padding:7px 10px;border:1px solid var(--inp);border-radius:6px;font-size:14px;width:90px"></label>
      <button type="submit" style="padding:8px 18px;background:var(--acc);color:#fff;border:0;border-radius:6px;font-size:14px;cursor:pointer">生成邀请码</button>
    </form>
    <div class="tablewrap"><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr><th>邀请码</th><th>备注</th><th>用量</th><th>使用者</th><th>到期</th><th>状态</th><th>创建</th><th>创建者</th><th></th></tr></thead>
    <tbody>${inviteRows || '<tr><td colspan="9" style="color:var(--mut);padding:16px;text-align:center">还没有邀请码</td></tr>'}</tbody></table></div>
    </div>
    <div class="card">
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px">
      <form method="get" action="/admin" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
        <label style="font-size:13px;color:var(--label)">搜索用户<input name="q" value="${escapeHtml(uq)}" placeholder="邮箱或名称" style="display:block;margin-top:4px;padding:7px 10px;border:1px solid var(--inp);background:var(--inp-bg);color:var(--txt);border-radius:6px;font-size:14px;width:200px"></label>
        <label style="font-size:13px;color:var(--label)">状态<select name="status" style="display:block;margin-top:4px;padding:7px 10px;border:1px solid var(--inp);background:var(--inp-bg);color:var(--txt);border-radius:6px;font-size:14px;width:110px"><option value="">全部</option><option value="active"${ustatus === "active" ? " selected" : ""}>正常</option><option value="disabled"${ustatus === "disabled" ? " selected" : ""}>已禁用</option></select></label>
        <button type="submit" style="padding:8px 18px;background:var(--acc);color:#fff;border:0;border-radius:6px;font-size:14px;cursor:pointer">筛选</button>
        ${uq || ustatus ? '<a href="/admin" style="font-size:13px;color:var(--mut)">清除</a>' : ""}
      </form>
      <span style="font-size:13px;color:var(--mut);margin-left:auto">共 ${users.length} 个用户${uq || ustatus ? "（已筛选）" : ""}</span>
    </div>
    <div class="tablewrap"><table><thead><tr><th>ID</th><th>邮箱</th><th>名称</th><th>状态</th><th>图片</th><th>已用</th><th>配额</th><th>注册</th><th>操作</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    </div>`,
    user,
  );
}

export function docsPage(user) {
  const rows = [
    ["POST", "/api/upload", "multipart 表单 file=@img（可加 visibility=public）", "上传图片"],
    ["POST", "/api/upload-url", 'JSON {"url":"https://example.com/a.png","visibility":"private"}', "从远程 URL 抓取上传（v1.9，SSRF 防护 + 大小/类型/配额同管线）"],
    ["GET", "/api/images?page=&per_page=&q=&vis=&sort=", "—", "图片列表（分页，q 搜文件名 / vis=private|public / sort=newest|oldest|largest|smallest|views）"],
    ["GET", "/api/images/:id", "—", "图片元数据（含 exif：相机/拍摄参数/尺寸/GPS，v1.12）"],
    ["PATCH", "/api/images/:id", 'JSON {"name":"新名.png"}', "重命名"],
    ["DELETE", "/api/images/:id", "—", "软删除（进回收站，配额立即释放）"],
    ["POST", "/api/images/batch-delete", 'JSON {"ids":["9f3c…","a1b2…"]}（≤50）', "批量软删除"],
    ["GET", "/api/trash", "—", "回收站列表"],
    ["GET", "/api/sessions", "—", "我的活跃会话（设备）列表"],
    ["DELETE", "/api/sessions/:id", "—", "注销指定设备（不能注销当前会话）"],
    ["GET", "/audit", "?action=&q=&page=", "审计日志（管理员看全站，普通用户看本人）"],
    ["GET", "/api/admin/audit", "?action=&user_id=&page=&per_page=", "审计日志 JSON（仅管理员）"],
    ["GET", "/api/meta", "—", "服务自描述：版本、限制、枚举、端点清单（无需鉴权）"],
    ["GET", "/api/public/images?page=&per_page=", "—", "公开画廊 JSON（匿名可访问，仅含 public 图片；管理端可整体关闭）"],
    ["GET", "/explore", "?page=", "公开画廊页面（匿名可见，含灯箱；只显示文件名/大小/时间/浏览数，不暴露所有者）"],
    ["GET", "/api/export?format=csv|json", "—", "导出元数据清单（CSV 带 BOM 可直接用 Excel 打开；JSON 含账号汇总；不含图片二进制与云端文件 ID）"],
    ["POST", "/api/import", 'JSON {"text":"每行一个地址","visibility":"private"} 或 {"items":[{"url":"…"}]}', "从 URL 列表批量导入（≤50 条/次，逐条沿用 SSRF/大小/类型/配额校验，返回逐行结果）"],
    ["POST", "/api/images/batch-visibility", 'JSON {"ids":[…],"visibility":"public|private"}', "批量切换公开/私有"],
    ["POST", "/api/images/batch-restore", 'JSON {"ids":[…]}', "批量从回收站恢复（跳过超额项）"],
    ["POST", "/api/images/batch-purge", 'JSON {"ids":[…]}', "批量彻底删除（不可恢复）"],
    ["POST", "/api/images/:id/share", 'JSON {"expires_in_days":7} 或 {"never":true}', "创建带有效期的分享链接（v1.13，返回 /s/<token>）"],
    ["GET", "/api/images/:id/shares", "—", "查看某图的分享链接"],
    ["DELETE", "/api/shares/:id", "—", "吊销分享链接（立即失效）"],
    ["POST", "/api/images/:id/restore", "—", "从回收站恢复"],
    ["DELETE", "/api/images/:id/purge", "—", "彻底删除（含云端文件）"],
    ["POST", "/api/keys", 'JSON {"name":"备注","expires_in_days":90}', "创建 API 密钥（仅展示一次；expires_in_days 省略或 0 = 永不过期，上限 3650）"],
    ["GET", "/api/keys", "—", "密钥列表（只显示前缀）"],
    ["DELETE", "/api/keys/:id", "—", "吊销密钥"],
    ["GET", "/api/stats", "—", "用量统计"],
    ["GET", "/api/admin/invites", "—", "邀请码列表（仅管理员）"],
    ["POST", "/api/admin/invites", 'JSON {"note":"","max_uses":1,"expires_in_days":30}', "生成邀请码（仅管理员）"],
    ["DELETE", "/api/admin/invites/:id", "—", "吊销邀请码（仅管理员）"],
    ["GET", "/api/admin/settings", "—", "查看全局设置（默认配额 / 回收站保留天数，仅管理员）"],
    ["PUT", "/api/admin/settings", 'JSON {"default_quota":"500G"} / {"trash_retention_days":30} / {"explore_enabled":0}', "更新全局设置（仅管理员；0 天=回收站不自动清理；explore_enabled=0 关闭公开画廊）"],
    ["PATCH", "/api/admin/users/:id/quota", 'JSON {"quota":"2T"}', "调整单个用户配额（仅管理员，不得低于已用空间）"],
  ];
  const table = rows
    .map(
      ([m, p, b, d]) =>
        `<tr><td><code>${m}</code></td><td><code>${escapeHtml(p)}</code></td><td>${escapeHtml(b)}</td><td>${d}</td></tr>`,
    )
    .join("");
  return layout(
    "API 文档",
    `<div class="card">
  <h3 style="margin-top:0">认证</h3>
  <p style="font-size:14px;line-height:1.7">两种方式任选其一：</p>
  <ul style="font-size:14px;line-height:1.8">
    <li><b>浏览器</b>：登录后的会话 Cookie 自动携带，无需额外处理。</li>
    <li><b>API</b>：请求头 <code>Authorization: Bearer pb_live_xxx</code>（密钥在「API 密钥」页创建）。</li>
  </ul>
  <h3>安全模型</h3>
  <ul style="font-size:14px;line-height:1.8">
    <li><b>CSRF</b>：携带 Cookie 的写请求（POST/PUT/PATCH/DELETE）必须来自同源 —— 请求头 <code>Origin</code>/<code>Referer</code> 与服务域名不一致时返回 <code>403 cross_origin</code>；不带这两个头的非浏览器调用（curl/SDK）不受影响，Bearer 调用天然免疫。</li>
    <li><b>会话 Cookie</b>：<code>HttpOnly</code> + <code>Secure</code> + <code>SameSite=Lax</code>，前端脚本读不到。</li>
    <li><b>响应头</b>：CSP（禁外链脚本、禁 iframe 嵌入）、HSTS、<code>X-Content-Type-Options: nosniff</code>、<code>X-Frame-Options: DENY</code>、<code>Referrer-Policy: same-origin</code>、<code>Permissions-Policy</code>（关闭摄像头/麦克风/定位等）。</li>
    <li><b>上传类型</b>：按文件头字节白名单校验（jpeg/png/gif/webp/avif），不信任 <code>Content-Type</code>，SVG/HTML 一律拒收。</li>
    <li><b>密钥有效期</b>：创建时可设 30/90/365 天或永不过期，过期后自动失效；密钥仅存 SHA-256 摘要，明文只在创建时返回一次。</li>
    <li><b>限流</b>：登录 10 次/5 分钟（按 IP）、注册 5 次/小时、API 上传 60 次/小时、创建密钥 10 次/小时。</li>
    <li><b>SSRF</b>：URL 上传逐跳校验目标地址（协议/私网/重定向/大小/类型），拒绝内网与元数据端点。</li>
    <li><b>不可枚举</b>：图片地址用 48 bit 随机串，顺序号不对外暴露；<code>/i/1</code>、<code>/i/2</code> 这类猜测全部 404，也不会泄漏站内图片总数。</li>
  </ul>
  <h3>图片标识（v1.25）</h3>
  <ul style="font-size:14px;line-height:1.8">
    <li>图片对外只有一个标识：<code>id</code> —— <b>12 位十六进制随机串</b>（48 bit），例如 <code>9f3c2d1e4a5b</code>，同时出现在 <code>/i/9f3c2d1e4a5b</code>、<code>/t/…</code> 和 API 响应里。</li>
    <li>数据库自增数字 id 只用于内部关联，<b>不会出现在任何 URL、响应或审计之外的地方</b>；<code>/i/65</code>、<code>/api/images/65</code> 一律 404 —— 顺序号不能猜出下一张图，也不会泄漏站内图片总量。</li>
    <li>批量接口的 <code>ids</code> 数组同样传这个随机串（<code>{"ids":["9f3c2d1e4a5b","a1b2c3d4e5f6"]}</code>）。</li>
  </ul>
  <h3>文件中转 API（v1.26–v1.34）</h3>
  <ul style="font-size:14px;line-height:1.8">
    <li><b>独立子系统</b>：完全独立于图库，拥有独立的存储表、独立的配额（默认 2GB）以及每用户独立的专属邮箱目录。</li>
    <li><b>路径前缀</b>：直链为 <code>/f/&lt;自增id&gt;</code>，临时分享链接为 <code>/f/s/&lt;22位token&gt;</code>。</li>
    <li><b>支持类型</b>：图片直接 inline 渲染，PDF/Word/ZIP 等任意文件一律强制 <code>attachment</code> 下载，严格保障安全。</li>
  </ul>
  <h3>端点</h3>
  <div class="tablewrap"><table style="width:100%;border-collapse:collapse;font-size:13px">
  <thead><tr><th>方法</th><th>路径</th><th>请求体</th><th>说明</th></tr></thead>
  <tbody>${table}</tbody></table></div>
  <h3>示例</h3>
  <pre style="background:var(--pre-bg);border:1px solid var(--line);border-radius:8px;padding:14px;font-size:13px;overflow:auto"># 图库上传（返回 12 位随机串 id 与 /i/ 地址）
curl -H "Authorization: Bearer $API_KEY" -F "file=@photo.jpg" \
  https://&lt;your-worker&gt;/api/upload

# 文件中转上传（返回自增 id 与 /f/ 地址，支持任意文件格式）
curl -H "Authorization: Bearer $API_KEY" -F "file=@document.pdf" \
  https://&lt;your-worker&gt;/api/relay/upload

# 文件中转远程 URL 抓取上传
curl -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/file.zip","visibility":"public"}' \
  https://&lt;your-worker&gt;/api/relay/upload

# 访问文件中转直链 / 临时分享
https://&lt;your-worker&gt;/f/101
https://&lt;your-worker&gt;/f/s/aB3-_xY90...22chars

# 查询中转文件列表（支持关键词、可见性筛选与排序）
curl -H "Authorization: Bearer $API_KEY" \
  "https://&lt;your-worker&gt;/api/relay?q=manual&amp;sort=size_desc&amp;page=1"</pre>
  <h3>错误码</h3>
  <div class="tablewrap"><table style="width:100%;border-collapse:collapse;font-size:13px">
  <thead><tr><th>HTTP</th><th>error</th><th>含义</th></tr></thead>
  <tbody>
    <tr><td>400</td><td><code>bad_request / bad_name / no_ids / invite_required / invalid_invite / invite_exhausted / invite_expired</code></td><td>请求不合法 / 邀请码缺失、无效、用完或过期</td></tr>
    <tr><td>401</td><td><code>unauthorized</code></td><td>未登录 / 密钥无效</td></tr>
    <tr><td>403</td><td><code>forbidden</code></td><td>不是资源所有者</td></tr>
    <tr><td>404</td><td><code>not_found</code></td><td>资源不存在</td></tr>
    <tr><td>410</td><td><code>gone</code></td><td>图片已删除</td></tr>
    <tr><td>413</td><td><code>too_large / quota_exceeded</code></td><td>超大小 / 超配额</td></tr>
    <tr><td>415</td><td><code>unsupported_type</code></td><td>非允许的图片类型</td></tr>
    <tr><td>429</td><td><code>rate_limited</code></td><td>超频率限制</td></tr>
  </tbody></table></div>
  <h3>限制</h3>
  <ul style="font-size:14px;line-height:1.8">
    <li>单文件 ≤ 20MB（环境变量 MAX_UPLOAD_MB 可调）</li>
    <li>类型：jpeg / png / gif / webp / avif（按文件内容嗅探，不看扩展名）</li>
    <li>上传频率 60 次/小时/用户；注册 5 次/小时/IP；登录 10 次/5 分钟/IP</li>
    <li>默认私有（仅所有者可访问）；上传时传 visibility=public 转为公开</li>
    <li><b>注册需要邀请码</b>（v1.2 起）：邀请码仅管理员可在「管理后台」生成与分发，支持设置次数与有效期，可随时吊销</li>
    <li>导入（v1.22）：单次最多 50 条 URL，逐条沿用 URL 上传的 SSRF/大小/类型校验，20 次/小时</li>
  </ul>
</div>`,
    user,
  );
}

/** v1.23: anonymous public gallery — every image users marked public. */
export function explorePage(user, images, page, totalPages, totalCount, enabled = true) {
  if (!enabled) {
    return layout(
      "发现",
      `<div class="empty">公开画廊未开启<br><br><span style="font-size:13px;color:var(--mut)">管理员可在「管理」页开启后，这里会展示所有被标记为公开的图片。</span></div>`,
      user,
    );
  }
  const cells = images.length
    ? `<div class="grid">${images
        .map(
          (im, idx) => `
      <div class="cell" data-id="${im.public_id}">
        <div class="ph"><a href="/i/${im.public_id}" target="_blank" onclick="openLb(${idx});return false"><img loading="lazy" decoding="async" src="/t/${im.public_id}" alt="${escapeHtml(im.original_name)}"></a></div>
        <div class="meta">
          <div class="nm">${escapeHtml(im.original_name)}</div>
          <div>${fmtBytes(im.size_bytes)} · ${fmtDate(im.created_at)} · ${im.views} 次浏览</div>
        </div>
      </div>`,
        )
        .join("")}</div>`
    : `<div class="empty">还没有公开图片${user ? '<br><br><a href="/gallery" style="color:var(--acc)">去图库把图片设为公开</a>' : ""}</div>`;

  const lbData = JSON.stringify(
    images.map((im) => ({
      id: im.public_id,
      name: im.original_name,
      size: im.size_bytes,
      vis: im.visibility,
      views: im.views,
      at: im.created_at,
    })),
  ).replace(/</g, "\\u003c");

  const lightbox = images.length
    ? `<div class="lightbox" id="lightbox">
  <div class="lb-stage">
    <img id="lbimg" src="" alt="">
    <button class="lb-nav lb-prev" onclick="lbStep(-1)" title="上一张（←）">‹</button>
    <button class="lb-nav lb-next" onclick="lbStep(1)" title="下一张（→）">›</button>
  </div>
  <div class="lb-bar">
    <span class="lb-counter" id="lbcounter"></span>
    <span class="lb-info"><span class="lb-name" id="lbname"></span> <span class="lb-meta" id="lbmeta"></span></span>
    <button onclick="if(lbIdx>=0)window.open('/i/'+IMGS[lbIdx].id,'_blank')">查看原图</button>
    <button onclick="closeLb()" title="关闭（Esc）">关闭</button>
  </div>
</div>`
    : "";

  const js = `
<script>
const IMGS = ${lbData};
let lbIdx = -1;
function fmtBytes(n){ if(n<1024) return n+' B'; if(n<1048576) return (n/1024).toFixed(1)+' KiB'; return (n/1048576).toFixed(2)+' MiB'; }
const lb = document.getElementById('lightbox');
function lbRender(){
  const im = IMGS[lbIdx]; if (!im) return;
  document.getElementById('lbimg').src = '/i/' + im.id;
  document.getElementById('lbimg').alt = im.name;
  document.getElementById('lbcounter').textContent = (lbIdx + 1) + ' / ' + IMGS.length;
  document.getElementById('lbname').textContent = im.name;
  document.getElementById('lbmeta').textContent = fmtBytes(im.size) + ' · ' + im.views + ' 次浏览';
}
function openLb(i){
  if (i < 0 || i >= IMGS.length) return;
  lbIdx = i; lbRender(); lb.classList.add('on'); document.body.style.overflow = 'hidden';
}
function closeLb(){ lb.classList.remove('on'); document.body.style.overflow = ''; lbIdx = -1; }
function lbStep(d){ if (lbIdx < 0) return; lbIdx = (lbIdx + d + IMGS.length) % IMGS.length; lbRender(); }
if (lb) {
  document.addEventListener('keydown', e => {
    if (lbIdx < 0) return;
    if (e.key === 'Escape') closeLb();
    else if (e.key === 'ArrowRight') lbStep(1);
    else if (e.key === 'ArrowLeft') lbStep(-1);
  });
  const stage = lb.querySelector('.lb-stage');
  stage.addEventListener('click', e => { if (e.target === stage) closeLb(); });
  let tx = null;
  lb.addEventListener('touchstart', e => { tx = e.touches[0].clientX; }, {passive:true});
  lb.addEventListener('touchend', e => {
    if (tx === null) return;
    const dx = e.changedTouches[0].clientX - tx;
    if (dx > 50) lbStep(-1); else if (dx < -50) lbStep(1);
    tx = null;
  }, {passive:true});
}
</script>`;

  return layout(
    "发现",
    `<div class="stats"><div class="stat">公开图片<b>${totalCount}</b></div><div class="stat">第 <b>${page}</b> / ${totalPages} 页</div></div>
     <div class="resultline">这里展示所有用户标记为「公开」的图片${user ? "" : " · <a href=\"/login\" style=\"color:var(--acc)\">登录</a>后可管理自己的图片"}</div>
     ${cells}${pagerHtml(page, totalPages, {}, "/explore")}${lightbox}${js}`,
    user,
  );
}

/** v1.22: export the metadata manifest / import images from a URL list. */
export function dataPage(user, stats = { images: 0, bytes: 0, shares: 0 }) {
  return layout(
    "导入导出",
    `<div class="card">
  <h3 style="margin-top:0">导出</h3>
  <p style="font-size:14px;line-height:1.8;margin:0 0 12px">
    当前账号有 <b>${stats.images}</b> 张图片、共 <b>${fmtBytes(stats.bytes)}</b>、<b>${stats.shares}</b> 个有效分享链接。
    导出内容为元数据清单（id、文件名、类型、大小、可见性、浏览数、分享数、创建时间），不含图片二进制、不含云端文件 ID 与任何密钥。
  </p>
  <p style="display:flex;gap:10px;flex-wrap:wrap;margin:0">
    <a class="btnlike" href="/api/export?format=csv">下载 CSV（Excel 可直接打开）</a>
    <a class="btnlike" href="/api/export?format=json">下载 JSON（含账号汇总）</a>
  </p>
</div>
<div class="card">
  <h3 style="margin-top:0">从 URL 列表导入</h3>
  <p style="font-size:13px;color:var(--mut);line-height:1.7;margin:0 0 10px">
    每行一个图片地址，也可写 <code>地址,文件名,可见性</code>（可见性或文件名可省略）；支持直接粘贴 CSV 或 JSON 数组。
    抓取走与「从 URL 上传」完全相同的校验（协议/私网/重定向/大小/类型），单次最多 50 条，超配额的行会被跳过。
  </p>
  <textarea id="imp" rows="8" placeholder="https://example.com/a.jpg
https://example.com/b.png,风景.png,public
https://example.com/c.webp" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid var(--inp);background:var(--inp-bg);color:var(--txt);border-radius:8px;font-family:ui-monospace,monospace;font-size:13px"></textarea>
  <div style="display:flex;gap:10px;align-items:center;margin-top:10px;flex-wrap:wrap">
    <select id="impvis" style="padding:8px 10px;border:1px solid var(--inp);background:var(--inp-bg);color:var(--txt);border-radius:6px;font-size:13px">
      <option value="private">默认私有</option>
      <option value="public">默认公开</option>
    </select>
    <button type="button" onclick="doImport()" id="impbtn" style="padding:8px 18px;background:var(--acc);color:#fff;border:0;border-radius:6px;font-size:13px;cursor:pointer">开始导入</button>
    <span id="impmsg" style="font-size:13px;color:var(--mut)"></span>
  </div>
  <div id="impr" style="margin-top:12px"></div>
</div>${dataPageJs()}`,
    user,
  );
}

/** Inline behaviour for /data (kept next to the markup it drives). */
function dataPageJs() {
  return `
<script>
async function doImport() {
  const text = document.getElementById('imp').value.trim();
  const vis = document.getElementById('impvis').value;
  const btn = document.getElementById('impbtn'), msg = document.getElementById('impmsg'), box = document.getElementById('impr');
  if (!text) { msg.textContent = '请先粘贴要导入的地址'; return; }
  btn.disabled = true;
  msg.textContent = '导入中，请勿关闭页面…';
  box.textContent = '';
  let j = {};
  try {
    const r = await fetch('/api/import', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({text, visibility: vis})});
    j = await r.json();
    if (!r.ok) {
      msg.textContent = '失败：' + (j.error || j.message || ('HTTP ' + r.status));
      btn.disabled = false;
      return;
    }
  } catch (e) {
    msg.textContent = '网络错误';
    btn.disabled = false;
    return;
  }
  msg.textContent = '完成：成功 ' + j.imported + ' 条，失败 ' + j.failed + ' 条' + (j.skipped_quota ? '（其中 ' + j.skipped_quota + ' 条因超出配额跳过）' : '');
  const rows = (j.results || []).map(r => '<tr><td style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(r.url) + '</td>' +
    '<td>' + (r.ok ? '<span style="color:var(--ok)">成功</span>' : '<span style="color:var(--dan)">失败</span>') + '</td>' +
    '<td>' + esc(r.ok ? (r.name || '') : ((r.error || '') + (r.message ? ' · ' + r.message : ''))) + '</td></tr>').join('');
  box.innerHTML = '<div class="tablewrap"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr><th>地址</th><th>结果</th><th>说明</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  btn.disabled = false;
}
function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
</script>`;
}

/**
 * v1.26: 文件中转 — a standalone file area that shares nothing with the
 * gallery: its own table, its own /f/<id> URLs, its own trash.
 */
export function relayPage(user, files, page, totalPages, total, filter = "live", folder = "", query = {}) {
  const isTrash = filter === "trash";
  const q = query.q || "";
  const sort = query.sort || "created_desc";
  const vis = query.vis || "all";

  const qs = new URLSearchParams();
  if (filter !== "live") qs.set("filter", filter);
  if (q) qs.set("q", q);
  if (sort && sort !== "created_desc") qs.set("sort", sort);
  if (vis && vis !== "all") qs.set("visibility", vis);

  const makePageUrl = (p) => {
    const pqs = new URLSearchParams(qs);
    if (p > 1) pqs.set("page", String(p));
    else pqs.delete("page");
    const s = pqs.toString();
    return "/files" + (s ? "?" + s : "");
  };

  const makeTabUrl = (f) => {
    const tqs = new URLSearchParams(qs);
    if (f !== "live") tqs.set("filter", f);
    else tqs.delete("filter");
    tqs.delete("page");
    const s = tqs.toString();
    return "/files" + (s ? "?" + s : "");
  };

  const rows = files.length
    ? files
        .map(
          (f) => {
            const isImg = /^(image\/(jpeg|png|gif|webp|avif))$/i.test(f.mime_type);
            const rawExt = (f.original_name.split('.').pop() || 'FILE').toUpperCase().slice(0, 6);
            const lowExt = rawExt.toLowerCase();

            let badge = { icon: '📄', label: rawExt, bg: 'var(--card)', color: 'var(--txt)', border: 'var(--line)' };
            if (lowExt === 'pdf') {
              badge = { icon: '📕', label: 'PDF', bg: '#fee2e2', color: '#dc2626', border: '#fca5a5' };
            } else if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2'].includes(lowExt)) {
              badge = { icon: '🗜️', label: rawExt, bg: '#ffedd5', color: '#ea580c', border: '#fdba74' };
            } else if (/^video\//i.test(f.mime_type) || ['mp4', 'webm', 'mkv', 'mov', 'avi'].includes(lowExt)) {
              badge = { icon: '🎬', label: rawExt, bg: '#f3e8ff', color: '#9333ea', border: '#d8b4fe' };
            } else if (/^audio\//i.test(f.mime_type) || ['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(lowExt)) {
              badge = { icon: '🎵', label: rawExt, bg: '#ecfdf5', color: '#059669', border: '#6ee7b7' };
            } else if (['js', 'ts', 'json', 'py', 'sh', 'html', 'css', 'sql', 'csv', 'yaml', 'yml'].includes(lowExt)) {
              badge = { icon: '💻', label: rawExt, bg: '#e0f2fe', color: '#0284c7', border: '#7dd3fc' };
            } else if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md'].includes(lowExt)) {
              badge = { icon: '📝', label: rawExt, bg: '#e0e7ff', color: '#4f46e5', border: '#a5b4fc' };
            } else if (['exe', 'dmg', 'apk', 'iso', 'bin', 'deb', 'rpm'].includes(lowExt)) {
              badge = { icon: '📦', label: rawExt, bg: '#f1f5f9', color: '#475569', border: '#cbd5e1' };
            }

            const thumbHtml = isImg
              ? `<a href="/f/${f.id}" target="_blank" onclick="previewFile(${f.id});return false"><img loading="lazy" decoding="async" src="/f/${f.id}" alt="${escapeHtml(f.original_name)}"></a>`
              : `<a href="/f/${f.id}" target="_blank" onclick="previewFile(${f.id});return false" style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;text-decoration:none;color:var(--txt)"><span style="font-size:36px;line-height:1">${badge.icon}</span><span style="font-size:11px;font-weight:700;margin-top:6px;background:${badge.bg};color:${badge.color};padding:2px 7px;border-radius:4px;border:1px solid ${badge.border}">${escapeHtml(badge.label)}</span></a>`;

            return `
      <div class="cell" data-id="${f.id}">
        <input type="checkbox" class="pick" value="${f.id}" onclick="pickClick(event)" title="选择">
        <div class="ph">${thumbHtml}</div>
        <div class="meta">
          <div class="nm">${escapeHtml(f.original_name)}</div>
          <div>${formatSize(f.size_bytes)} · ${f.visibility === "public" ? "公开" : "私有"} · 浏览 ${f.views}</div>
          <div style="color:var(--mut)">/f/${f.id} · ${escapeHtml(f.storage_path)}</div>
          ${isTrash ? `<div style="color:var(--warn)">删除于 ${fmtDate(f.deleted_at || "")}</div>` : ""}
        </div>
        <div class="acts">
          <a href="#" onclick="copyLink(${f.id});return false">复制链接</a>
          ${isTrash
            ? `<a href="#" onclick="restoreFile(${f.id});return false">恢复</a><button class="del" onclick="purgeFile(${f.id})">彻底删除</button>`
            : `<a href="#" onclick="downloadChecked(${f.id}, ${JSON.stringify(f.original_name)});return false">下载</a><a href="#" onclick="showFileDetail(${f.id});return false">详情</a>${f.visibility === "public" ? `<a href="#" onclick="toggleVis(${f.id},'private');return false">设为私有</a>` : `<a href="#" onclick="toggleVis(${f.id},'public');return false">设为公开</a>`}<a href="#" onclick="openShareModal(${f.id});return false">分享</a><a href="#" onclick="renameFile(${f.id});return false">重命名</a><button class="del" onclick="delFile(${f.id})">删除</button>`}
        </div>
      </div>`;
          },
        )
        .join("")
    : `<div class="empty">${isTrash ? "中转回收站是空的" : "还没有中转文件"}<br><br><span style="color:var(--mut)">用下面的表单上传，文件会进入你专属的目录 <code>${escapeHtml(folder)}</code></span></div>`;

  const selBar = files.length
    ? `<div class="selbar" id="selbar">
    <b>已选 <span id="seln">0</span> 项</b>
    <button type="button" onclick="selAll()">全选本页</button>
    <button type="button" onclick="selInvert()">反选</button>
    <button type="button" onclick="selClear()">清除</button>
    <span class="spacer"></span>
    ${isTrash
      ? `<button type="button" onclick="batchRestore()">批量恢复</button><button type="button" class="danger" onclick="batchPurge()">批量彻底删除</button>`
      : `<button type="button" onclick="batchVis('public')">设为公开</button><button type="button" onclick="batchVis('private')">设为私有</button><button type="button" class="danger" onclick="batchDel()">批量删除</button>`}
  </div>`
    : "";

  const pager = totalPages > 1
    ? `<div class="pager">${page > 1 ? `<a href="${makePageUrl(page - 1)}">上一页</a>` : ""}<span>第 ${page} / ${totalPages} 页 · 共 ${total} 个</span>${page < totalPages ? `<a href="${makePageUrl(page + 1)}">下一页</a>` : ""}</div>`
    : "";

  const filterBar = `
  <form method="get" action="/files" class="filterbar">
    <input type="hidden" name="filter" value="${escapeHtml(filter)}">
    <input type="search" name="q" value="${escapeHtml(q)}" placeholder="搜索中转文件名...">
    <select name="visibility">
      <option value="all"${vis === "all" ? " selected" : ""}>全部可见性</option>
      <option value="public"${vis === "public" ? " selected" : ""}>仅公开</option>
      <option value="private"${vis === "private" ? " selected" : ""}>仅私有</option>
    </select>
    <select name="sort">
      <option value="created_desc"${sort === "created_desc" ? " selected" : ""}>最新上传</option>
      <option value="created_asc"${sort === "created_asc" ? " selected" : ""}>最早上传</option>
      <option value="size_desc"${sort === "size_desc" ? " selected" : ""}>体积从大到小</option>
      <option value="size_asc"${sort === "size_asc" ? " selected" : ""}>体积从小到大</option>
      <option value="views_desc"${sort === "views_desc" ? " selected" : ""}>浏览量最高</option>
    </select>
    <button type="submit">筛选</button>
    ${q || vis !== "all" || sort !== "created_desc" ? `<a href="/files?filter=${filter}" class="clear">重置</a>` : ""}
  </form>`;

  const rUsed = Number(user.relay_used_bytes || 0);
  const rQuota = Number(user.relay_quota_bytes || 2147483648);
  const rPct = Math.min(100, Math.round((rUsed / (rQuota || 1)) * 100));

  return layout("文件中转", `
<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px">
  <div>
    <h1 style="margin-bottom:4px">文件中转</h1>
    <p style="color:var(--mut);font-size:13px;margin:0">与图库相互独立：单独的表、单独的 <code>/f/&lt;id&gt;</code> 地址、单独的回收站。存储目录：<code>${escapeHtml(folder)}</code></p>
  </div>
  <div style="font-size:12px;color:var(--mut);text-align:right">
    <div>中转配额：<b>${formatSize(rUsed)}</b> / ${formatSize(rQuota)} (${rPct}%)</div>
    <div style="width:140px;height:5px;background:var(--line);border-radius:3px;margin-top:4px;overflow:hidden;display:inline-block">
      <div style="width:${rPct}%;height:100%;background:${rPct > 90 ? 'var(--dan)' : 'var(--acc)'}"></div>
    </div>
  </div>
</div>

${isTrash ? "" : `
<div class="upzone" id="upzone">
  <div class="upzone-title">拖拽文件到这里，或点击选择</div>
  <div class="upzone-hint">支持图片、文档、压缩包、视频等任意文件 · 支持按 Ctrl+V 粘贴</div>
  <div class="up-row" onclick="event.stopPropagation()">
    <input type="file" id="relayfileinput" multiple>
    <button type="button" class="pri" onclick="document.getElementById('relayfileinput').click()">选择本地文件</button>
    <button type="button" onclick="toggleUrlBox()">URL 远程抓取</button>
    <label class="vis"><input type="checkbox" id="relayispub" value="public"> 设为公开</label>
  </div>
  <div class="up-url-box" id="upurlbox" style="display:none" onclick="event.stopPropagation()">
    <input type="url" id="relayurlinput" placeholder="输入图片直链 http(s)://...">
    <button type="button" class="pri" onclick="uploadFromUrl()">抓取上传</button>
  </div>
  <div class="up-queue" id="upqueue"></div>
</div>`}

<div class="tabs">
  <a href="${makeTabUrl("live")}"${isTrash ? "" : ' class="on"'}>全部文件</a>
  <a href="${makeTabUrl("trash")}"${isTrash ? ' class="on"' : ""}>回收站</a>
</div>

${filterBar}
${selBar}
<div class="grid" id="grid">${rows}</div>
${pager}

<div class="lightbox" id="lb" onclick="if(event.target===this)closeLb()">
  <div id="lbbody" style="display:flex;align-items:center;justify-content:center;max-width:90vw;max-height:85vh"></div>
  <div class="lbacts">
    <a id="lbdown" href="#" download style="background:var(--acc);color:#fff;padding:6px 14px;border-radius:6px;text-decoration:none;font-size:13px">下载文件</a>
    <a id="lbopen" href="#" target="_blank" style="padding:6px 14px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--txt);text-decoration:none;font-size:13px">新窗口打开</a>
    <button type="button" onclick="closeLb()" style="padding:6px 14px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--txt);cursor:pointer;font-size:13px">关闭</button>
  </div>
</div>

<div class="shmodal" id="shmodal" onclick="if(event.target===this)closeShareModal()">
  <div class="shbox" style="max-width:480px">
    <h3 style="margin-top:0;margin-bottom:6px">文件分享与链接</h3>
    <div id="shinfo" style="font-size:13px;color:var(--mut);margin-bottom:12px"></div>
    <div style="background:var(--inp-bg);padding:10px;border-radius:8px;border:1px solid var(--line);margin-bottom:16px">
      <div style="font-size:12px;font-weight:600;margin-bottom:6px;color:var(--txt)">文件直链地址：</div>
      <div style="display:flex;gap:6px">
        <input type="text" id="shdirect" readonly style="flex:1;padding:6px 10px;border:1px solid var(--inp);background:var(--card);color:var(--txt);border-radius:6px;font-size:12px">
        <button type="button" onclick="copyDirectLink()" style="padding:6px 12px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--acc);cursor:pointer;font-size:12px;white-space:nowrap">复制</button>
      </div>
    </div>
    <div style="font-size:12px;font-weight:600;margin-bottom:6px;color:var(--txt)">创建私密临时分享链接：</div>
    <p style="font-size:12px;color:var(--mut);margin:0 0 10px">通过专用 Token 访问，即使原文件为私有亦可匿名访问/下载。</p>
    <div class="shopts">
      <button type="button" onclick="createRelayShareLink(1)">1 天有效</button>
      <button type="button" onclick="createRelayShareLink(7)">7 天有效</button>
      <button type="button" onclick="createRelayShareLink(30)">30 天有效</button>
      <button type="button" onclick="createRelayShareLink(0)">永久有效</button>
    </div>
    <div id="shresult" style="display:none;margin-top:12px">
      <input type="text" id="shlink" readonly style="width:100%;padding:8px 10px;border:1px solid var(--inp);background:var(--inp-bg);color:var(--txt);border-radius:6px;font-size:13px;box-sizing:border-box">
      <button type="button" onclick="copyShareLink()" style="margin-top:8px;padding:7px 14px;background:var(--acc);color:#fff;border:0;border-radius:6px;cursor:pointer">复制临时分享链接</button>
    </div>
    <button type="button" class="shclose" onclick="closeShareModal()" style="margin-top:14px">关闭</button>
  </div>
</div>

<div class="shmodal" id="detailmodal" onclick="if(event.target===this)closeDetailModal()">
  <div class="shbox" style="max-width:500px">
    <h3 style="margin-top:0;margin-bottom:12px">文件详情</h3>
    <div id="detailbody" style="font-size:13px;line-height:1.7;color:var(--txt)"></div>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">
      <button type="button" onclick="closeDetailModal()" style="padding:6px 14px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--txt);cursor:pointer">关闭</button>
    </div>
  </div>
</div>

<script>
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}
function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

let curShareId = null;
function openShareModal(id) {
  curShareId = id;
  const f = FILES_MAP[id];
  const direct = location.origin + '/f/' + id;
  document.getElementById('shdirect').value = direct;
  if (f) {
    document.getElementById('shinfo').textContent = f.name + ' · ' + (f.vis === 'public' ? '公开文件 (任何人都可直接访问)' : '私有文件 (需登录或专用分享链接)');
  }
  document.getElementById('shresult').style.display = 'none';
  document.getElementById('shmodal').classList.add('on');
}
function copyDirectLink() {
  const inp = document.getElementById('shdirect');
  (navigator.clipboard ? navigator.clipboard.writeText(inp.value) : Promise.reject())
    .then(() => toast('直链已复制'))
    .catch(() => prompt('复制直链：', inp.value));
}
function closeShareModal() {
  document.getElementById('shmodal').classList.remove('on');
}
async function createRelayShareLink(days) {
  if (!curShareId) return;
  try {
    const res = await post('/api/relay/' + curShareId + '/share', { days });
    const fullUrl = location.origin + res.url;
    document.getElementById('shlink').value = fullUrl;
    document.getElementById('shresult').style.display = 'block';
  } catch (e) {
    toast('生成失败: ' + e.message);
  }
}
function copyShareLink() {
  const inp = document.getElementById('shlink');
  (navigator.clipboard ? navigator.clipboard.writeText(inp.value) : Promise.reject())
    .then(() => toast('分享链接已复制'))
    .catch(() => prompt('复制分享链接：', inp.value));
}
const FILES_MAP = {${files.map((f) => `${f.id}: { id: ${f.id}, name: ${JSON.stringify(f.original_name)}, mime: ${JSON.stringify(f.mime_type)}, size: ${f.size_bytes}, vis: ${JSON.stringify(f.visibility)}, views: ${f.views || 0}, path: ${JSON.stringify(f.storage_path)}, folder: ${JSON.stringify(f.folder)}, time: ${JSON.stringify(f.created_at)} }`).join(",")}};
const IMG = {${files.map((f) => `${f.id}: '${escapeHtml(f.original_name)}'`).join(",")}};

function showFileDetail(id) {
  const f = FILES_MAP[id];
  if (!f) return;
  const b = document.getElementById('detailbody');
  b.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
    '<tr><td style="color:var(--mut);width:85px;padding:4px 0">文件名称：</td><td><b>' + esc(f.name) + '</b></td></tr>' +
    '<tr><td style="color:var(--mut);padding:4px 0">文件编号：</td><td><code>/f/' + f.id + '</code></td></tr>' +
    '<tr><td style="color:var(--mut);padding:4px 0">文件大小：</td><td>' + fmtBytes(f.size) + ' (' + Number(f.size).toLocaleString() + ' 字节)</td></tr>' +
    '<tr><td style="color:var(--mut);padding:4px 0">MIME类型：</td><td><code>' + esc(f.mime) + '</code></td></tr>' +
    '<tr><td style="color:var(--mut);padding:4px 0">可见权限：</td><td>' + (f.vis === 'public' ? '<span style="color:var(--ok)">公开可访问</span>' : '<span style="color:var(--mut)">私有 (需登录或凭临时分享链接)</span>') + '</td></tr>' +
    '<tr><td style="color:var(--mut);padding:4px 0">访问热度：</td><td>' + f.views + ' 次浏览/下载</td></tr>' +
    '<tr><td style="color:var(--mut);padding:4px 0">存储路径：</td><td><code>' + esc(f.path) + '</code></td></tr>' +
    '<tr><td style="color:var(--mut);padding:4px 0">上传时间：</td><td>' + esc(f.time) + '</td></tr>' +
    '</table>';
  document.getElementById('detailmodal').classList.add('on');
}
function closeDetailModal() {
  document.getElementById('detailmodal').classList.remove('on');
}

async function previewFile(id) {
  const f = FILES_MAP[id];
  if (!f) return;
  const body = document.getElementById('lbbody');
  body.innerHTML = '<div style="color:#fff;font-size:14px">加载预览中...</div>';
  document.getElementById('lbopen').href = '/f/' + id;
  document.getElementById('lbdown').href = '/f/' + id + '?download=1';
  document.getElementById('lbdown').setAttribute('download', f.name);
  document.getElementById('lb').classList.add('on');

  const isImg = Boolean(f.mime && (f.mime.startsWith('image/') || /\.(jpe?g|png|gif|webp|avif)$/i.test(f.name)));
  const isVideo = Boolean(f.mime && f.mime.startsWith('video/')) || /\.(mp4|webm|mkv|mov)$/i.test(f.name);
  const isAudio = Boolean(f.mime && f.mime.startsWith('audio/')) || /\.(mp3|wav|ogg|flac|m4a)$/i.test(f.name);
  const isText = Boolean(f.mime && (f.mime.startsWith('text/') || f.mime.includes('json') || f.mime.includes('javascript') || f.mime.includes('xml'))) || /\.(txt|md|json|js|ts|py|sh|sql|csv|html|css|yaml|yml)$/i.test(f.name);

  if (isImg) {
    body.innerHTML = '<img src="/f/' + id + '" alt="' + esc(f.name) + '" style="max-width:90vw;max-height:80vh;object-fit:contain;border-radius:6px">';
  } else if (isVideo) {
    body.innerHTML = '<video src="/f/' + id + '" controls autoplay style="max-width:90vw;max-height:80vh;border-radius:6px"></video>';
  } else if (isAudio) {
    body.innerHTML = '<div style="background:var(--card);padding:32px 40px;border-radius:12px;text-align:center;box-shadow:0 8px 24px rgba(0,0,0,0.3)"><div style="font-size:56px;margin-bottom:12px">🎵</div><div style="font-weight:600;font-size:15px;color:var(--txt);margin-bottom:16px">' + esc(f.name) + '</div><audio src="/f/' + id + '" controls autoplay style="width:320px"></audio></div>';
  } else if (isText) {
    try {
      const resp = await fetch('/f/' + id);
      const text = await resp.text();
      body.innerHTML = '<pre style="max-width:85vw;max-height:75vh;overflow:auto;text-align:left;background:var(--inp-bg);color:var(--txt);padding:18px;border-radius:8px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;font-size:13px;line-height:1.6;border:1px solid var(--line);box-shadow:0 6px 16px rgba(0,0,0,0.2)">' + esc(text.slice(0, 50000)) + (text.length > 50000 ? '\\n\\n...[已截断过长内容，请下载查看完整文件]...' : '') + '</pre>';
    } catch (e) {
      body.innerHTML = '<div style="background:var(--card);padding:24px;border-radius:8px;color:var(--dan)">文本加载失败: ' + esc(e.message) + '</div>';
    }
  } else {
    body.innerHTML = '<div style="background:var(--card);padding:36px;border-radius:12px;text-align:center;max-width:400px;box-shadow:0 8px 24px rgba(0,0,0,0.3)"><div style="font-size:56px;margin-bottom:12px">📦</div><div style="font-weight:600;font-size:16px;color:var(--txt);margin-bottom:6px">' + esc(f.name) + '</div><div style="font-size:13px;color:var(--mut);margin-bottom:20px">' + fmtBytes(f.size) + ' · ' + esc(f.mime) + '</div><a href="/f/' + id + '?download=1" download="' + esc(f.name) + '" style="background:var(--acc);color:#fff;padding:8px 20px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:500;display:inline-block">立即下载</a></div>';
  }
}
function openLb(id) { previewFile(id); }
function closeLb() {
  const body = document.getElementById('lbbody');
  if (body) body.innerHTML = '';
  document.getElementById('lb').classList.remove('on');
}
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLb(); });

function selIds() { return [...document.querySelectorAll('.pick:checked')].map((b) => String(b.value)); }
function pickClick(e) { e.stopPropagation(); updSel(); }
function updSel() {
  document.getElementById('seln').textContent = selIds().length;
  document.querySelectorAll('.cell').forEach((c) => c.classList.toggle('sel', c.querySelector('.pick').checked));
}
function selAll() { document.querySelectorAll('.pick').forEach((b) => (b.checked = true)); updSel(); }
function selInvert() { document.querySelectorAll('.pick').forEach((b) => (b.checked = !b.checked)); updSel(); }
function selClear() { document.querySelectorAll('.pick').forEach((b) => (b.checked = false)); updSel(); }
let lbIdx = -1;
document.addEventListener('click', (e) => {
  const cell = e.target.closest && e.target.closest('.cell');
  if (!cell || e.target.closest('a,button,input,.acts')) return;
  if (e.shiftKey && lbIdx >= 0) {
    const boxes = [...document.querySelectorAll('.pick')];
    const a = lbIdx, b = boxes.indexOf(cell.querySelector('.pick'));
    if (b >= 0) { const [lo, hi] = a < b ? [a, b] : [b, a]; for (let i = lo; i <= hi; i++) boxes[i].checked = true; updSel(); return; }
  }
  const box = cell.querySelector('.pick'); box.checked = !box.checked; updSel();
  lbIdx = [...document.querySelectorAll('.pick')].indexOf(box);
});
addEventListener('keydown', (e) => { if (e.key === 'Escape' && lbIdx < 0) selClear(); });

async function post(url, body) {
  const r = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { method: 'POST' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || j.error || ('HTTP ' + r.status));
  return j;
}
function toast(msg) {
  const t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:var(--toast-bg);color:#fff;padding:9px 16px;border-radius:8px;font-size:13px;z-index:99';
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

async function delFile(id) {
  if (!confirm('删除该文件？可在回收站恢复。')) return;
  try { await post('/api/relay/' + id + '/delete'); toast('已删除'); location.reload(); }
  catch (e) { toast('失败: ' + e.message); }
}
async function restoreFile(id) {
  try { await post('/api/relay/' + id + '/restore'); toast('已恢复'); location.reload(); }
  catch (e) { toast('失败: ' + e.message); }
}
async function purgeFile(id) {
  if (!confirm('彻底删除？云端文件将一并删除，不可恢复。')) return;
  try { await post('/api/relay/' + id + '/purge'); toast('已彻底删除'); location.reload(); }
  catch (e) { toast('失败: ' + e.message); }
}
async function renameFile(id) {
  const name = prompt('新名称', IMG[id] || '');
  if (!name) return;
  try { await post('/api/relay/' + id + '/rename', { name }); toast('已重命名'); location.reload(); }
  catch (e) { toast('失败: ' + e.message); }
}
function copyLink(id) {
  const url = location.origin + '/f/' + id;
  (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject())
    .then(() => toast('链接已复制'))
    .catch(() => prompt('复制链接：', url));
}
async function batchDel() {
  const ids = selIds();
  if (!ids.length) return toast('先选几个');
  if (!confirm('删除选中的 ' + ids.length + ' 个文件？')) return;
  try { const j = await post('/api/relay/batch-delete', { ids }); toast('已删除 ' + (j.deleted || 0) + ' 个'); location.reload(); }
  catch (e) { toast('失败: ' + e.message); }
}
async function batchRestore() {
  const ids = selIds();
  if (!ids.length) return toast('先选几个');
  try { const j = await post('/api/relay/batch-restore', { ids }); toast('已恢复 ' + (j.restored || 0) + ' 个'); location.reload(); }
  catch (e) { toast('失败: ' + e.message); }
}
async function batchPurge() {
  const ids = selIds();
  if (!ids.length) return toast('先选几个');
  if (!confirm('彻底删除选中的 ' + ids.length + ' 个文件？云端文件一并删除。')) return;
  try { const j = await post('/api/relay/batch-purge', { ids }); toast('已删除 ' + (j.purged || 0) + ' 个'); location.reload(); }
  catch (e) { toast('失败: ' + e.message); }
}

async function batchVis(visibility) {
  const ids = selIds();
  if (!ids.length) return toast('先选几个文件');
  try {
    const j = await post('/api/relay/batch-visibility', { ids, visibility });
    toast('已将 ' + (j.count || 0) + ' 个文件设为' + (visibility === 'public' ? '公开' : '私有'));
    setTimeout(() => location.reload(), 500);
  } catch (e) {
    toast('操作失败: ' + e.message);
  }
}

async function toggleVis(id, visibility) {
  try {
    const r = await fetch('/api/relay/' + id, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visibility })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || j.error || ('HTTP ' + r.status));
    toast('已设为' + (visibility === 'public' ? '公开' : '私有'));
    setTimeout(() => location.reload(), 500);
  } catch (e) {
    toast('修改失败: ' + e.message);
  }
}

function toggleUrlBox() {
  const b = document.getElementById('upurlbox');
  if (b) b.style.display = b.style.display === 'none' ? 'flex' : 'none';
}

/* v2.15.0-v2.17.0: resilient uploader — retry with backoff, stall/timeout
   detection and a client-side checksum so corrupted transfers are rejected. */
const RELAY_RETRY_MAX = 3;
const RELAY_STALL_MS = 30000;
const RELAY_TIMEOUT_MS = 300000;
const RELAY_HASH_LIMIT = 32 * 1024 * 1024;

function relaySleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function sha256OfFile(file) {
  if (!window.crypto || !window.crypto.subtle) return '';
  const buf = await file.arrayBuffer();
  const digest = await window.crypto.subtle.digest('SHA-256', buf);
  return Array.prototype.map.call(new Uint8Array(digest), function (b) {
    return b.toString(16).padStart(2, '0');
  }).join('');
}

function sendRelayOnce(file, isPub, clientSha, onProgress) {
  return new Promise(function (resolve, reject) {
    let xhr;
    try { xhr = new XMLHttpRequest(); } catch (e) { reject(new Error('no-xhr')); return; }
    xhr.open('POST', '/api/relay/upload');
    xhr.timeout = RELAY_TIMEOUT_MS;
    let lastLoaded = -1;
    let lastTick = Date.now();
    const stallTimer = setInterval(function () {
      if (Date.now() - lastTick > RELAY_STALL_MS) {
        clearInterval(stallTimer);
        try { xhr.abort(); } catch (e) {}
      }
    }, 5000);
    xhr.upload.onprogress = function (e) {
      if (e.lengthComputable) {
        if (e.loaded > lastLoaded) { lastLoaded = e.loaded; lastTick = Date.now(); }
        onProgress(e.loaded, e.total);
      }
    };
    xhr.onload = function () { clearInterval(stallTimer); resolve({ status: xhr.status, text: xhr.responseText }); };
    xhr.onerror = function () { clearInterval(stallTimer); reject(new Error('network')); };
    xhr.ontimeout = function () { clearInterval(stallTimer); reject(new Error('timeout')); };
    xhr.onabort = function () { clearInterval(stallTimer); reject(new Error('stalled')); };
    const fd = new FormData();
    fd.append('file', file);
    fd.append('visibility', isPub);
    if (clientSha) fd.append('client_sha256', clientSha);
    xhr.send(fd);
  });
}

/* v2.29.0: turn raw failures into something a user can act on, and show live
   throughput so a stalled link is visible before it times out. */
function relayErrorText(err) {
  const e = String(err || '').toLowerCase();
  if (e.indexOf('stalled') >= 0) return '传输停滞';
  if (e.indexOf('timeout') >= 0) return '连接超时';
  if (e.indexOf('network') >= 0) return '网络中断';
  if (e.indexOf('too_large') >= 0) return '超过单文件上限';
  if (e.indexOf('quota') >= 0) return '配额不足';
  if (e.indexOf('checksum') >= 0) return '内容校验失败';
  if (e.indexOf('rate') >= 0 || e.indexOf('429') >= 0) return '请求过于频繁';
  if (e.indexOf('413') >= 0) return '文件过大';
  return String(err || '未知错误').slice(0, 28);
}

function relaySpeedText(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '';
  if (bytesPerSec >= 1048576) return (bytesPerSec / 1048576).toFixed(1) + 'MB/s';
  return Math.round(bytesPerSec / 1024) + 'KB/s';
}

function relayEtaText(seconds) {
  if (!seconds || seconds <= 0 || seconds > 3600) return '';
  if (seconds < 60) return Math.round(seconds) + 's';
  return Math.floor(seconds / 60) + 'm' + Math.round(seconds % 60) + 's';
}

async function uploadRelayWithRetry(file, isPub, clientSha, bar, st) {
  let lastErr = '';
  for (let attempt = 1; attempt <= RELAY_RETRY_MAX; attempt++) {
    let res = null;
    try {
      let lastBytes = 0;
      let lastAt = Date.now();
      res = await sendRelayOnce(file, isPub, clientSha, function (loaded, total) {
        const p = Math.round((loaded / total) * 100);
        bar.style.width = p + '%';
        const now = Date.now();
        const dt = (now - lastAt) / 1000;
        if (dt >= 0.8) {
          const speed = (loaded - lastBytes) / dt;
          const eta = (total - loaded) / Math.max(speed, 1);
          const extra = relaySpeedText(speed) + (relayEtaText(eta) ? ' ' + relayEtaText(eta) : '');
          st.textContent = p + '% ' + extra;
          st.title = extra;
          lastBytes = loaded;
          lastAt = now;
        } else {
          st.textContent = p + '%';
        }
      });
    } catch (e) {
      lastErr = (e && e.message) || 'network';
      res = null;
    }
    if (res) {
      let j = {};
      try { j = JSON.parse(res.text); } catch (e) { j = {}; }
      if (res.status >= 200 && res.status < 300 && j.url) return { ok: true, json: j };
      lastErr = j.message || j.error || ('HTTP ' + res.status);
      if (res.status === 429) { /* transient: fall through and retry */ }
      else if (res.status >= 400 && res.status < 500) return { ok: false, error: lastErr };
    }
    if (attempt < RELAY_RETRY_MAX) {
      st.textContent = '重试 ' + attempt;
      st.style.color = 'var(--mut)';
      await relaySleep(1000 * Math.pow(2, attempt - 1));
    }
  }
  return { ok: false, error: lastErr || 'unknown' };
}

/* v2.20.0-v2.21.0: chunked uploader. Files above the threshold go through the
   resumable session API; an interrupted run resumes from the offset Drive
   actually holds, and the session id survives a page reload. */
const RELAY_CHUNK_THRESHOLD = 8 * 1024 * 1024;

function relaySessionKey(file) {
  return 'relaysess:' + file.name + ':' + file.size + ':' + (file.lastModified || 0);
}

async function relayFetchJson(url, opts) {
  const r = await fetch(url, opts);
  let j = {};
  try { j = await r.json(); } catch (e) { j = {}; }
  return { ok: r.ok, status: r.status, json: j };
}

async function uploadRelayChunked(file, isPub, clientSha, bar, st) {
  const key = relaySessionKey(file);
  let sessionId = '';
  try { sessionId = localStorage.getItem(key) || ''; } catch (e) { sessionId = ''; }
  let chunkSize = 4 * 1024 * 1024;
  let received = 0;
  let lastErr = '';

  if (sessionId) {
    const s = await relayFetchJson('/api/relay/upload/status?session=' + encodeURIComponent(sessionId));
    if (s.ok) {
      if (s.json.done) {
        try { localStorage.removeItem(key); } catch (e) {}
        return { ok: true, json: s.json.file };
      }
      received = Number(s.json.received) || 0;
      chunkSize = Number(s.json.chunk_size) || chunkSize;
      st.textContent = '续传 ' + Math.round((received / file.size) * 100) + '%';
    } else {
      sessionId = '';
      try { localStorage.removeItem(key); } catch (e) {}
    }
  }

  if (!sessionId) {
    const init = await relayFetchJson('/api/relay/upload/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: file.name,
        size: file.size,
        mime: file.type || 'application/octet-stream',
        visibility: isPub,
        client_sha256: clientSha || '',
      }),
    });
    if (!init.ok) {
      return { ok: false, error: init.json.message || init.json.error || ('HTTP ' + init.status) };
    }
    sessionId = init.json.session_id;
    chunkSize = Number(init.json.chunk_size) || chunkSize;
    try { localStorage.setItem(key, sessionId); } catch (e) {}
  }

  while (received < file.size) {
    const end = Math.min(received + chunkSize, file.size);
    const blob = file.slice(received, end);
    let advanced = false;

    for (let attempt = 1; attempt <= RELAY_RETRY_MAX && !advanced; attempt++) {
      try {
        const c = await relayFetchJson('/api/relay/upload/chunk?session=' + encodeURIComponent(sessionId), {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: blob,
        });
        if (c.ok) {
          received = Number(c.json.received) || received;
          const p = Math.round((received / file.size) * 100);
          bar.style.width = p + '%';
          st.textContent = p + '%';
          if (c.json.done) {
            try { localStorage.removeItem(key); } catch (e) {}
            return { ok: true, json: c.json.file };
          }
          advanced = true;
        } else {
          lastErr = c.json.message || c.json.error || ('HTTP ' + c.status);
          if (c.status === 404) {
            try { localStorage.removeItem(key); } catch (e) {}
            return { ok: false, error: '上传会话已失效，请重新选择文件' };
          }
          if (c.status >= 400 && c.status < 500 && c.status !== 429) {
            try { localStorage.removeItem(key); } catch (e) {}
            return { ok: false, error: lastErr };
          }
        }
      } catch (e) {
        lastErr = 'network';
      }

      if (!advanced && attempt < RELAY_RETRY_MAX) {
        st.textContent = '重试 ' + attempt;
        st.style.color = 'var(--mut)';
        await relaySleep(1000 * Math.pow(2, attempt - 1));
        const s2 = await relayFetchJson('/api/relay/upload/status?session=' + encodeURIComponent(sessionId));
        if (s2.ok) {
          if (s2.json.done) {
            try { localStorage.removeItem(key); } catch (e) {}
            return { ok: true, json: s2.json.file };
          }
          received = Number(s2.json.received) || received;
        }
      }
    }

    if (!advanced) return { ok: false, error: lastErr || 'unknown' };
  }
  return { ok: false, error: 'incomplete' };
}

/* v2.23.0-v2.24.0: resilient downloader. Pulls the file in ranged chunks so a
   dropped connection only costs one chunk, then verifies the assembled bytes
   against the server checksum before handing them to the browser. */
function saveBlobAs(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 2000);
}

async function digestBytes(bytes) {
  const d = await window.crypto.subtle.digest('SHA-256', bytes);
  return Array.prototype.map.call(new Uint8Array(d), function (b) {
    return b.toString(16).padStart(2, '0');
  }).join('');
}

async function downloadChecked(id, name) {
  let size = 0;
  let wantSha = '';
  let chunks = null;

  try {
    const mr = await fetch('/api/relay/' + id + '/manifest?chunk_mb=2');
    if (mr.ok) {
      const mf = await mr.json();
      size = Number(mf.size) || 0;
      if (mf.checksum && mf.checksum.indexOf('sha256:') === 0) wantSha = mf.checksum.slice(7);
      if (Array.isArray(mf.chunks) && mf.chunks.length > 0) chunks = mf.chunks;
    }
  } catch (e) {}

  if (!size) {
    try {
      const h = await fetch('/f/' + id + '?download=1', { method: 'HEAD' });
      size = Number(h.headers.get('content-length')) || 0;
      const cs = h.headers.get('x-checksum-sha256') || '';
      if (cs.indexOf('sha256:') === 0) wantSha = cs.slice(7);
    } catch (e) {}
  }

  if (!size) {
    toast('文件大小未知，改用普通下载');
    window.open('/f/' + id + '?download=1', '_blank');
    return;
  }

  const CHUNK = 2 * 1024 * 1024;
  if (!chunks) {
    chunks = [];
    let cur = 0;
    let idx = 0;
    while (cur < size) {
      const end = Math.min(cur + CHUNK - 1, size - 1);
      chunks.push({ index: idx++, start: cur, end: end, bytes: end - cur + 1 });
      cur = end + 1;
    }
  }

  const totalChunks = chunks.length;
  toast('开始分片下载 (0/' + totalChunks + ')...');

  for (let round = 1; round <= 2; round++) {
    const parts = new Array(totalChunks);
    let failed = false;
    let completed = 0;

    for (let i = 0; i < totalChunks; i++) {
      const c = chunks[i];
      let buf = null;
      for (let a = 1; a <= 4 && !buf; a++) {
        try {
          const r = await fetch('/f/' + id + '?download=1', {
            headers: { Range: 'bytes=' + c.start + '-' + c.end }
          });
          if (r.status === 206 || r.ok) {
            const ab = await r.arrayBuffer();
            if (ab.byteLength === c.bytes) {
              buf = ab;
            }
          }
        } catch (e) {
          buf = null;
        }
        if (!buf) await relaySleep(600 * a);
      }

      if (!buf) {
        failed = true;
        break;
      }

      parts[i] = new Uint8Array(buf);
      completed++;
      if (completed % 4 === 0 || completed === totalChunks) {
        const pct = Math.floor((completed / totalChunks) * 100);
        toast('正在分片下载 (' + completed + '/' + totalChunks + ', ' + pct + '%)...');
      }
    }

    if (failed) {
      if (round === 1) {
        toast('分片传输受阻，正在重试...');
        await relaySleep(1500);
        continue;
      }
      toast('下载失败，请稍后重试或使用命令行下载');
      return;
    }

    const totalBytes = parts.reduce(function (s, p) { return s + p.length; }, 0);
    if (totalBytes !== size) {
      if (round === 1) {
        toast('分片总长度异常，正在重试...');
        continue;
      }
      toast('下载不完整，请稍后再试');
      return;
    }

    toast('正在拼装并校验文件...');
    const merged = new Uint8Array(totalBytes);
    let pos = 0;
    for (let i = 0; i < parts.length; i++) {
      merged.set(parts[i], pos);
      pos += parts[i].length;
    }

    if (wantSha && window.crypto && window.crypto.subtle) {
      try {
        const got = await digestBytes(merged);
        if (got !== wantSha) {
          if (round === 1) {
            toast('SHA-256 校验不一致，正在重新下载...');
            continue;
          }
          toast('文件校验失败，内容可能损坏');
          return;
        }
      } catch (e) {}
    }

    saveBlobAs(new Blob([merged]), name || ('file-' + id));
    toast('下载完成并校验通过 ✅');
    return;
  }
}

/* v2.25.0: bounded upload concurrency — parallel enough to be fast, capped so a
   batch of large files cannot saturate (and destabilise) the link. */
const RELAY_UPLOAD_CONCURRENCY = 2;

async function mapWithLimit(list, limit, worker) {
  let idx = 0;
  const runners = [];
  const n = Math.max(1, Math.min(limit, list.length));
  for (let i = 0; i < n; i++) {
    runners.push((async function () {
      while (idx < list.length) {
        const cur = idx;
        idx++;
        await worker(list[cur], cur);
      }
    })());
  }
  await Promise.all(runners);
}

async function handleUploadFiles(files) {
  if (!files || !files.length) return;
  const isPub = document.getElementById('relayispub')?.checked ? 'public' : 'private';
  const queue = document.getElementById('upqueue');
  // v2.31.0: a single-request upload still caps at 20 MiB, but the chunked path
  // accepts up to 100 MiB. The client-side gate must use the chunked ceiling,
  // otherwise a 25 MiB file is rejected before it ever reaches the chunked path.
  const maxTotal = 512 * 1024 * 1024;
  const fileArr = Array.from(files);
  let successCount = 0;

  await mapWithLimit(fileArr, RELAY_UPLOAD_CONCURRENCY, async function (file) {
    if (file.size === 0) {
      toast('文件 ' + file.name + ' 为空，已跳过');
      return;
    }
    if (file.size > maxTotal) {
      toast('文件 ' + file.name + ' 超过 512MB 上限');
      return;
    }

    const item = document.createElement('div');
    item.className = 'up-item';
    item.innerHTML = '<span style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(file.name) + '">' + esc(file.name) + '</span><div class="prog"><div class="prog-bar"></div></div><span class="st" style="color:var(--mut);min-width:48px;text-align:right">0%</span>';
    queue.appendChild(item);
    const bar = item.querySelector('.prog-bar');
    const st = item.querySelector('.st');

    let clientSha = '';
    if (file.size <= RELAY_HASH_LIMIT) {
      st.textContent = '校验';
      try { clientSha = await sha256OfFile(file); } catch (e) { clientSha = ''; }
    }

    const r = file.size > RELAY_CHUNK_THRESHOLD
      ? await uploadRelayChunked(file, isPub, clientSha, bar, st)
      : await uploadRelayWithRetry(file, isPub, clientSha, bar, st);

    if (r.ok) {
      successCount++;
      bar.style.width = '100%';
      bar.style.background = 'var(--ok)';
      st.textContent = '完成';
      st.style.color = 'var(--ok)';
      const copyBtn = document.createElement('button');
      copyBtn.textContent = '复制链接';
      copyBtn.style.cssText = 'font-size:11px;padding:2px 8px;border:1px solid var(--line);border-radius:4px;background:var(--card);color:var(--acc);cursor:pointer;margin-left:6px';
      copyBtn.onclick = function (ev) {
        ev.stopPropagation();
        const full = location.origin + r.json.url;
        navigator.clipboard.writeText(full).then(function () { toast('已复制: ' + r.json.url); }, function () { prompt('复制链接:', full); });
      };
      item.appendChild(copyBtn);
    } else {
      bar.style.width = '100%';
      bar.style.background = 'var(--dan)';
      st.textContent = '失败: ' + relayErrorText(r.error);
      st.style.color = 'var(--dan)';
      st.title = String(r.error || '');
    }
  });

  if (successCount > 0) {
    toast('上传成功，正在刷新列表...');
    setTimeout(function () {
      location.reload();
    }, 800);
  }
}

async function uploadFromUrl() {
  const inp = document.getElementById('relayurlinput');
  const url = (inp?.value || '').trim();
  if (!url) return toast('请输入有效 URL');
  const isPub = document.getElementById('relayispub')?.checked ? 'public' : 'private';
  toast('正在抓取中...');
  try {
    const res = await post('/api/relay/upload', { url, visibility: isPub });
    toast('抓取成功！');
    setTimeout(() => location.reload(), 500);
  } catch (e) {
    toast('抓取失败: ' + e.message);
  }
}

const upzone = document.getElementById('upzone');
if (upzone) {
  upzone.addEventListener('click', () => document.getElementById('relayfileinput')?.click());
  upzone.addEventListener('dragover', (e) => { e.preventDefault(); upzone.classList.add('dragover'); });
  upzone.addEventListener('dragleave', () => upzone.classList.remove('dragover'));
  upzone.addEventListener('drop', (e) => {
    e.preventDefault();
    upzone.classList.remove('dragover');
    if (e.dataTransfer?.files?.length) handleUploadFiles(e.dataTransfer.files);
  });
  document.getElementById('relayfileinput')?.addEventListener('change', (e) => {
    if (e.target.files?.length) handleUploadFiles(e.target.files);
  });
}

window.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  const files = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].type.indexOf('image') !== -1) {
      const f = items[i].getAsFile();
      if (f) files.push(f);
    }
  }
  if (files.length) {
    toast('检测到剪贴板图片，正在上传...');
    handleUploadFiles(files);
  }
});

updSel();
</script>
`, user);
}

/**
 * v1.27: per-user Drive folder overview.
 * Layout: <sanitised email>/<8-char id>.<ext> — one directory per account.
 * The v1.24 shard (md5 prefix + 1..255) is retired; `storage_dirs` is kept in
 * the schema only so the change can be rolled back.
 */
export function storagePage(user, dirs = [], summary = {}, notice = null, gdriveConfig = {}) {
  const isReady = Boolean(gdriveConfig.ready);
  const clientId = gdriveConfig.clientId || "";
  const folderId = gdriveConfig.folderId || "";
  const email = gdriveConfig.accountEmail || "";
  // v2.39.0: what Google actually granted — a 403 on folder creation or upload
  // almost always means the drive scope was silently dropped at consent time.
  const grantedScope = gdriveConfig.grantedScope || "";
  const hasWriteScope = grantedScope
    .split(/\s+/)
    .some((s) => s === "https://www.googleapis.com/auth/drive" || s === "https://www.googleapis.com/auth/drive.file");

  const s = {
    dirs: 0,
    files: 0,
    relay_files: 0,
    legacy: 0,
    shards: 0,
    ...summary,
  };
  const noticeHtml = notice
    ? notice.ok
      ? `<div class="notice-ok">${escapeHtml(notice.ok)}</div>`
      : `<div class="notice-err">${escapeHtml(notice.err)}</div>`
    : "";
  const rows = dirs.length
    ? dirs
        .map((d) => {
          const pct = Math.min(100, Math.round((d.file_count / 255) * 100));
          const barColor = d.file_count >= 255 ? "var(--dan)" : d.file_count >= 200 ? "var(--warn)" : "var(--acc)";
          return `<tr>
      <td><code>${escapeHtml(d.owner_key)}</code></td>
      <td>${d.bucket}</td>
      <td>${d.file_count}/255</td>
      <td style="min-width:110px"><div style="background:var(--ph);border-radius:4px;height:7px;overflow:hidden"><div style="width:${pct}%;height:100%;background:${barColor}"></div></div></td>
      <td><code style="font-size:11px;color:var(--mut)">${escapeHtml((d.drive_folder_id || "—").slice(0, 12))}</code></td>
      <td>${escapeHtml((d.created_at || "").slice(0, 10))}</td>
    </tr>`;
        })
        .join("")
    : `<tr><td colspan="6" style="color:var(--mut);text-align:center;padding:18px">还没有分片目录——上传第一张图片时自动创建</td></tr>`;

  const wizardCard = `
<div class="card" style="border:1px solid ${isReady ? 'var(--ok)' : 'var(--acc)'};background:var(--card)">
  <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:14px">
    <h3 style="margin:0;display:flex;align-items:center;gap:8px">
      ${isReady ? '🟢 Google Drive 存储正常运行' : '⚡ Google Drive 应用自举配置'}
    </h3>
    <a href="/admin/storage/guide" class="btnlike" style="background:var(--acc-bg);color:var(--acc);border:1px solid var(--acc);padding:6px 12px;font-size:12px">
      📘 查看完整图文指引
    </a>
  </div>

  ${isReady ? `
  <div style="background:var(--nt-ok-bg);border:1px solid var(--nt-ok-line);border-radius:8px;padding:12px 16px;margin-bottom:16px;font-size:13px;line-height:1.7">
    <div><b>绑定账号：</b> <code>${escapeHtml(email || '已连接')}</code></div>
    <div><b>存储根目录 ID：</b> <code>${escapeHtml(folderId)}</code></div>
    <div><b>客户端 ID：</b> <code style="color:var(--mut)">${escapeHtml(clientId.slice(0, 20))}...</code></div>
  </div>
  <div style="display:flex;gap:12px">
    <button type="button" onclick="showReconfig()" style="padding:6px 14px;border:1px solid var(--line);background:var(--card);color:var(--txt);border-radius:6px;font-size:13px;cursor:pointer">更换账号或重设凭据</button>
  </div>
  <div id="reconfigbox" style="display:none;margin-top:16px;border-top:1px dashed var(--line);padding-top:16px">
  ` : ''}

  <!-- 第一步：录入凭据 -->
  <div style="margin-bottom:20px">
    <div style="font-weight:600;font-size:14px;margin-bottom:6px">第 1 步：录入 Google 客户端凭据 (Client JSON)</div>
    <p style="font-size:12px;color:var(--mut);margin:0 0 10px">从 Google Cloud 控制台下载的 <code>client_secret_xxx.json</code> 文本直接贴在下方：</p>
    <textarea id="clientjsoninput" rows="3" placeholder="在此粘贴 JSON 全文，如 {&quot;installed&quot;:{&quot;client_id&quot;:&quot;...&quot;,&quot;client_secret&quot;:&quot;...&quot;}}" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--inp);background:var(--inp-bg);color:var(--txt);border-radius:6px;font-family:monospace;font-size:12px"></textarea>
    <div style="margin-top:8px">
      <button type="button" class="btnlike" onclick="saveClientJson()" style="cursor:pointer;border:0">保存并解析凭据</button>
      <span id="clientstatus" style="font-size:12px;margin-left:10px"></span>
    </div>
  </div>

  <!-- 第二步：前往授权并粘贴 URL -->
  <div style="margin-bottom:20px;border-top:1px solid var(--line);padding-top:16px">
    <div style="font-weight:600;font-size:14px;margin-bottom:6px">第 2 步：前往 Google 授权并粘贴回调地址</div>
    <p style="font-size:12px;color:var(--mut);margin:0 0 10px">点击前往授权，授权后跳向 <code>http://localhost:8085/...</code>（显示连接失败），<b>直接复制该地址栏完整 URL 粘贴回来</b>：</p>
    <div style="display:flex;gap:10px;margin-bottom:10px">
      <button type="button" class="btnlike" onclick="openAuthWindow()" style="cursor:pointer;border:0">🔗 前往 Google 登录授权</button>
    </div>
    <input type="text" id="callbackurlinput" placeholder="粘贴浏览器地址栏里的完整回调 URL (http://localhost:8085/callback?code=...)" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--inp);background:var(--inp-bg);color:var(--txt);border-radius:6px;font-size:13px">
    <div style="margin-top:8px">
      <button type="button" class="btnlike" onclick="exchangeCallbackUrl()" style="cursor:pointer;border:0">验证并完成账号绑定</button>
      <span id="exchangestatus" style="font-size:12px;margin-left:10px"></span>
    </div>
  </div>

  <!-- 授权范围自检 -->
  <div style="margin-bottom:20px;border-top:1px solid var(--line);padding-top:16px">
    <div style="font-weight:600;font-size:14px;margin-bottom:6px">🔍 授权范围自检（Scope）</div>
    ${grantedScope === "" ? `
    <p style="font-size:13px;color:var(--mut);margin:0 0 8px">尚未记录授权范围（多为本次绑定之前签发的旧令牌）。重新走一次上面第 2 步授权即可记录。</p>`
    : !hasWriteScope ? `
    <div style="border:1px solid var(--dan);background:var(--nt-err-bg);border-radius:8px;padding:12px 16px;font-size:13px;line-height:1.7">
      <div style="color:var(--dan);font-weight:600;margin-bottom:6px">⚠️ 当前令牌没有 Drive 写入权限 —— 创建目录、上传都会返回 403</div>
      <div style="margin-bottom:4px">Google 实际授予的是：</div>
      <div style="font-family:monospace;font-size:12px;color:var(--mut);word-break:break-all;margin-bottom:8px">${escapeHtml(grantedScope)}</div>
      <div>处理：Google Cloud 控制台 → <b>API 和服务 → OAuth 同意屏幕 → 数据访问 (Scopes)</b>，确认已添加 <code>https://www.googleapis.com/auth/drive</code> 并保存；然后回到上面 <b>第 2 步重新授权一次</b>（本应用每次授权都强制 consent，会换取新令牌）。若 Google 始终不授予该受限范围，见 <a href="/admin/storage/guide" style="color:var(--acc)">完整指引</a> 中的降级方案。</div>
    </div>`
    : `
    <p style="font-size:13px;color:var(--ok);margin:0 0 8px">✅ 已获得 Drive 写入权限</p>
    <div style="font-family:monospace;font-size:12px;color:var(--mut);word-break:break-all">${escapeHtml(grantedScope)}</div>`}
  </div>

  <!-- 第三步：初始化根目录 -->
  <div style="border-top:1px solid var(--line);padding-top:16px">
    <div style="font-weight:600;font-size:14px;margin-bottom:6px">第 3 步：绑定存储根目录</div>
    <p style="font-size:12px;color:var(--mut);margin:0 0 10px">选择或自动创建你的网盘存储文件夹：</p>
    <div style="display:flex;gap:12px;flex-wrap:wrap">
      <button type="button" class="btnlike" onclick="initRootFolder()" style="background:var(--ok);border:0;cursor:pointer">✨ 一键在网盘创建 "cf2gdrive" 文件夹并绑定</button>
    </div>
    <span id="folderstatus" style="font-size:12px;margin-top:8px;display:block"></span>
  </div>

  ${isReady ? `</div>` : ''}
</div>

<script>
async function postJson(url, data) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || j.error || ('HTTP ' + r.status));
  return j;
}

function showReconfig() {
  const el = document.getElementById('reconfigbox');
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

async function saveClientJson() {
  const val = document.getElementById('clientjsoninput').value.trim();
  const st = document.getElementById('clientstatus');
  if (!val) return alert('请先粘贴 client.json 内容');
  st.textContent = '正在保存...'; st.style.color = 'var(--mut)';
  try {
    const res = await postJson('/api/admin/gdrive/parse-client', { raw_json: val });
    st.textContent = '已保存！Client ID: ' + res.client_id.slice(0, 15) + '...';
    st.style.color = 'var(--ok)';
  } catch(e) {
    st.textContent = '失败: ' + e.message; st.style.color = 'var(--dan)';
  }
}

async function openAuthWindow() {
  try {
    const res = await postJson('/api/admin/gdrive/auth-url', {});
    window.open(res.auth_url, '_blank');
  } catch(e) {
    alert('生成授权链接失败: ' + e.message + '。请先完成第 1 步并保存凭据。');
  }
}

async function exchangeCallbackUrl() {
  const val = document.getElementById('callbackurlinput').value.trim();
  const st = document.getElementById('exchangestatus');
  if (!val) return alert('请粘贴完整的回调 URL');
  st.textContent = '正在验证与换取 Token...'; st.style.color = 'var(--mut)';
  try {
    const res = await postJson('/api/admin/gdrive/exchange', { callback_url: val });
    st.textContent = '绑定成功！已连接账号: ' + (res.email || 'Google 账号');
    st.style.color = 'var(--ok)';
  } catch(e) {
    st.textContent = '换取失败: ' + e.message; st.style.color = 'var(--dan)';
  }
}

async function initRootFolder() {
  const st = document.getElementById('folderstatus');
  st.textContent = '正在创建并绑定根目录...'; st.style.color = 'var(--mut)';
  try {
    const res = await postJson('/api/admin/gdrive/init-folder', {});
    st.textContent = '绑定成功！根目录 ID: ' + res.folder_id + '。页面即将刷新...';
    st.style.color = 'var(--ok)';
    setTimeout(() => location.reload(), 1500);
  } catch(e) {
    st.textContent = '创建失败: ' + e.message; st.style.color = 'var(--dan)';
  }
}
</script>
`;

  return layout(
    "存储分片",
    `${noticeHtml}
${wizardCard}
<div class="stats">
  <div class="stat">分片目录<b>${s.dirs}</b></div>
  <div class="stat">已用槽位<b>${s.files}</b></div>
  <div class="stat">已满目录<b>${s.full_dirs}</b></div>
  <div class="stat">待整理历史<b>${s.legacy}</b></div>
</div>
<div class="card">
  <h3 style="margin-top:0">存储布局</h3>
  <p style="font-size:13px;color:var(--mut);line-height:1.8;margin:0">
    每张图片存放在 <code>Drive/${"<md5(邮箱)前4位>"}/&lt;1..255&gt;/&lt;8位id&gt;.&lt;扩展名&gt;</code>。
    一级目录取用户邮箱 md5 的前 4 位十六进制（同一个人永远落在同一目录，改名不会搬家）；
    二级目录编号从 1 开始顺序填满，<b>每个目录最多 255 个文件</b>，写满自动开下一个。
    单用户上限 = 255 目录 × 255 文件 = <b>${s.capacity_per_user}</b> 张。
    目录 ID 与计数缓存在 D1（<code>storage_dirs</code>），选目录不消耗 Drive 请求；计数用
    <code>UPDATE … WHERE file_count &lt; 255 RETURNING</code> 原子占用，并发上传不会挤爆目录。
  </p>
</div>
<div class="card">
  <h3 style="margin-top:0">维护</h3>
  <div style="display:flex;gap:22px;flex-wrap:wrap;align-items:flex-end">
    <form method="post" action="/admin/storage/recount" style="margin:0">
      <button type="submit" style="padding:8px 18px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--txt);font-size:14px;cursor:pointer">重新统计计数</button>
      <div style="font-size:12px;color:var(--mut);margin-top:6px;max-width:260px">按 <code>images</code> 表实际行数重算每个目录的 file_count（删除用户、异常中断后使用）。</div>
    </form>
    <form method="post" action="/admin/storage/migrate" style="margin:0">
      <label style="font-size:13px;color:var(--label)">每批数量
        <input name="limit" type="number" min="1" max="100" value="20" style="display:block;margin-top:4px;padding:7px 10px;border:1px solid var(--inp);background:var(--inp-bg);color:var(--txt);border-radius:6px;font-size:14px;width:110px">
      </label>
      <button type="submit" style="padding:8px 18px;background:var(--acc);color:#fff;border:0;border-radius:6px;font-size:14px;cursor:pointer;margin-left:8px">整理历史文件</button>
      <div style="font-size:12px;color:var(--mut);margin-top:6px;max-width:320px">把 v1.24 之前平铺在根目录的图片移动到分片目录，并同时把文件名改成 8 位 id。文件内容与分享链接不变（仍按文件 ID 访问）。</div>
    </form>
  </div>
</div>
<div class="card">
  <h3 style="margin-top:0">分片明细（最多显示 200 条）</h3>
  <div class="tablewrap"><table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead><tr><th>前缀</th><th>分片</th><th>文件数</th><th>占用</th><th>Drive 目录</th><th>创建</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  <p style="font-size:12px;color:var(--mut);margin:12px 0 0">当前最大分片号：<b>${s.max_bucket}</b> / 255。前端「前缀」即 <code>md5(邮箱)</code> 的前 4 位。</p>
</div>`,
    user,
  );
}

export function settingsPage(user, msg = "") {
  const m = msg ? `<p style="color:var(--teal);font-size:13px">${escapeHtml(msg)}</p>` : "";
  const usedPct = user.quota_bytes > 0 ? Math.min(100, (user.used_bytes / user.quota_bytes) * 100) : 0;
  const remain = Math.max(0, user.quota_bytes - user.used_bytes);
  const pctColor = usedPct >= 95 ? "var(--dan)" : usedPct >= 80 ? "var(--warn)" : "var(--acc)";
  const isAdmin = user.role === "admin";

  const adminCard = isAdmin
    ? `<div class="card" style="border:1px solid var(--acc);background:var(--acc-bg)">
  <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:12px">
    <h3 style="margin:0;display:flex;align-items:center;gap:8px;color:var(--acc)">
      🛡️ 管理员管理中心
    </h3>
    <span style="font-size:12px;padding:3px 10px;border-radius:12px;background:var(--acc);color:#fff;font-weight:600">系统管理员</span>
  </div>
  <p style="font-size:13px;color:var(--txt);margin:0 0 14px;line-height:1.6">
    您当前具备管理员最高权限，可管理全站 Google Drive 存储配置、分片目录、系统配额及用户。
  </p>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px">
    <a href="/admin/storage" style="display:block;padding:12px 14px;background:var(--card);border:1px solid var(--line);border-radius:8px;text-decoration:none;color:var(--txt)">
      <div style="font-weight:600;font-size:14px;color:var(--acc);margin-bottom:4px">📁 存储配置管理 →</div>
      <div style="font-size:12px;color:var(--mut);line-height:1.5">配置 Google Drive 凭据、自举授权、查看存储分片与目录维护</div>
    </a>
    <a href="/admin" style="display:block;padding:12px 14px;background:var(--card);border:1px solid var(--line);border-radius:8px;text-decoration:none;color:var(--txt)">
      <div style="font-weight:600;font-size:14px;color:var(--acc);margin-bottom:4px">👥 用户与全站管理 →</div>
      <div style="font-size:12px;color:var(--mut);line-height:1.5">管理全站用户配额、启用/禁用、邀请码分发与全局规则</div>
    </a>
    <a href="/audit" style="display:block;padding:12px 14px;background:var(--card);border:1px solid var(--line);border-radius:8px;text-decoration:none;color:var(--txt)">
      <div style="font-weight:600;font-size:14px;color:var(--acc);margin-bottom:4px">📋 全站审计日志 →</div>
      <div style="font-size:12px;color:var(--mut);line-height:1.5">审计全站所有用户的关键操作轨迹与登录记录</div>
    </a>
  </div>
</div>`
    : `<div class="card">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
    <h3 style="margin:0">账号权限角色</h3>
    <span style="font-size:12px;padding:3px 10px;border-radius:12px;background:var(--ph);color:var(--mut);font-weight:600">普通用户</span>
  </div>
  <p style="font-size:13px;color:var(--mut);margin:0">当前账号为普通用户。如需调整存储配额或申请管理权限，请联系系统管理员。</p>
</div>`;

  const quotaCard = `<div class="card">
  <h3 style="margin-top:0">个人存储配额</h3>
  <p style="font-size:14px;line-height:1.8;margin:0 0 10px">已用 <b>${fmtBytes(user.used_bytes)}</b> · 配额 <b>${fmtBytes(user.quota_bytes)}</b> · 剩余 <b>${fmtBytes(remain)}</b></p>
  <div style="height:8px;background:var(--ph);border-radius:99px;overflow:hidden"><div style="height:100%;width:${usedPct.toFixed(1)}%;background:${pctColor};border-radius:99px"></div></div>
  <p style="font-size:12px;color:var(--mut);margin:10px 0 0">使用率 ${usedPct.toFixed(1)}%${usedPct >= 80 ? " · 接近上限，上传将被拒绝" : ""}。${isAdmin ? '<a href="/admin/storage" style="margin-left:8px">前往存储管理配置全局 Drive →</a>' : "如需调整配额请联系管理员。"}</p>
</div>`;
  return layout(
    "设置",
    `${adminCard}${quotaCard}<div class="card">
  <h3 style="margin-top:0">个人资料</h3>
  <p style="margin:0 0 12px"><a href="/audit" style="font-size:13px">查看我的操作记录 →</a> · <a href="/sessions" style="font-size:13px">登录设备 →</a></p>${m}
  <form method="post" action="/settings/profile" style="display:flex;gap:8px;max-width:420px">
    <input name="display_name" value="${escapeHtml(user.display_name)}" maxlength="60" style="flex:1;padding:8px 10px;border:1px solid var(--inp);border-radius:6px;font-size:14px">
    <button type="submit" style="padding:8px 16px;background:var(--acc);color:#fff;border:0;border-radius:6px;cursor:pointer">保存</button>
  </form>
</div>
<div class="card">
  <h3 style="margin-top:0">修改密码</h3>
  <form method="post" action="/settings/password" style="max-width:420px;display:grid;gap:10px">
    <input type="password" name="old_password" placeholder="当前密码" required style="padding:8px 10px;border:1px solid var(--inp);border-radius:6px;font-size:14px">
    <input type="password" name="new_password" placeholder="新密码（至少 8 位）" minlength="8" required style="padding:8px 10px;border:1px solid var(--inp);border-radius:6px;font-size:14px">
    <div><button type="submit" style="padding:8px 16px;background:var(--acc);color:#fff;border:0;border-radius:6px;cursor:pointer">修改密码</button></div>
  </form>
</div>`,
    user,
  );
}

/** v1.18: audit log table (admins see all, users see their own). */
export function auditPage(user, data, actions, filters = {}, showAll = false) {
  const { rows, total, page, pages } = data;
  const body = rows.length
    ? rows
        .map(
          (r) => `<tr>
        <td style="white-space:nowrap;color:var(--mut)">${escapeHtml((r.created_at || "").replace("T", " ").slice(0, 19))}</td>
        <td>${escapeHtml(r.actor_email || "—")}</td>
        <td><b>${escapeHtml(auditLabel(r.action))}</b><div style="font-size:11px;color:var(--mut)">${escapeHtml(r.action)}</div></td>
        <td>${escapeHtml(r.target || "—")}</td>
        <td style="word-break:break-all">${escapeHtml(r.detail || "")}</td>
        <td style="color:var(--mut)">${escapeHtml(r.ip || "—")}</td>
      </tr>`,
        )
        .join("")
    : `<tr><td colspan="6" style="color:var(--mut);padding:16px;text-align:center">没有审计记录</td></tr>`;
  const opts = [`<option value="">全部动作</option>`]
    .concat(
      (actions || []).map(
        (a) =>
          `<option value="${escapeHtml(a.action)}"${filters.action === a.action ? " selected" : ""}>${escapeHtml(auditLabel(a.action))}（${a.c}）</option>`,
      ),
    )
    .join("");
  const qs = (p) => {
    const keep = [];
    if (filters.action) keep.push(`action=${encodeURIComponent(filters.action)}`);
    if (filters.q) keep.push(`q=${encodeURIComponent(filters.q)}`);
    if (p > 1) keep.push(`page=${p}`);
    return `/audit${keep.length ? "?" + keep.join("&") : ""}`;
  };
  const pager = pages > 1
    ? `<div class="pager">${Array.from({ length: pages }, (_, i) => i + 1)
        .filter((p) => p === 1 || p === pages || Math.abs(p - page) <= 1)
        .map((p, idx, arr) => {
          const gap = idx > 0 && p - arr[idx - 1] > 1 ? '<span class="gap">…</span>' : "";
          return gap + (p === page ? `<span class="cur">${p}</span>` : `<a href="${qs(p)}">${p}</a>`);
        })
        .join("")}</div>`
    : "";
  return layout(
    "审计日志",
    `<form class="filterbar" method="get" action="/audit">
       <select name="action">${opts}</select>
       <input type="search" name="q" value="${escapeHtml(filters.q || "")}" placeholder="搜索邮箱 / 详情 / 目标">
       <button type="submit">筛选</button>
       ${filters.action || filters.q ? '<a class="clear" href="/audit">清除</a>' : ""}
     </form>
     <div class="resultline">共 <b>${total}</b> 条记录${showAll ? "（全站）" : "（仅本人）"} · 按时间倒序</div>
     <div class="card" style="padding:0;overflow:hidden">
     <div class="tablewrap"><table style="width:100%;border-collapse:collapse;font-size:13px">
       <thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>目标</th><th>详情</th><th>IP</th></tr></thead>
       <tbody>${body}</tbody>
     </table></div></div>${pager}`,
    user,
  );
}

export function storageGuidePage(user) {
  return layout(
    "Google Drive 凭据获取指南",
    `
<div style="margin-bottom:16px"><a href="/admin/storage" style="font-size:13px;text-decoration:none">← 返回存储管理</a></div>
<h1>Google Drive 凭据获取完整图文指南</h1>
<p style="color:var(--mut);font-size:14px;line-height:1.6;margin-top:-6px">
  cf2gdrive 以个人 Google 账号运行，文件直接存放在你的个人网盘中并占用其免费 15GB 配额。<br>
  按照本指南在 Google Cloud Console 创建专属客户端并下载 JSON 凭据，整个过程仅需约 3–5 分钟。
</p>

<div class="card" style="border-left:4px solid var(--acc)">
  <h3 style="margin-top:0">📋 阶段一：创建 GCP 项目并启用 Drive API</h3>
  <ol style="font-size:14px;line-height:1.9;padding-left:20px;margin-bottom:0">
    <li>登录 <a href="https://console.cloud.google.com/" target="_blank" rel="noopener">Google Cloud 控制台 (console.cloud.google.com)</a>（请使用需要绑定网盘的 Google 账号登录）。</li>
    <li>在顶栏项目下拉菜单中，点击 <b>「新建项目 (New Project)」</b>，项目名称可随意输入（如 <code>cf2gdrive</code>），点击「创建」。</li>
    <li>创建完成后，确保顶栏当前选中的是刚刚新建的项目。</li>
    <li>在左侧导航菜单中选择 <b>「API 和服务」➔「库 (Library)」</b>，搜索框输入 <code>Google Drive API</code>。</li>
    <li>在搜索结果中点击进入，并点击蓝色的 <b>「启用 (Enable)」</b> 按钮。</li>
  </ol>
</div>

<div class="card" style="border-left:4px solid var(--warn)">
  <h3 style="margin-top:0;color:var(--warn)">⚠️ 阶段二：配置 OAuth 同意屏幕并【发布应用】（极度关键）</h3>
  <ol style="font-size:14px;line-height:1.9;padding-left:20px">
    <li>在左侧菜单点击 <b>「API 和服务」➔「OAuth 同意屏幕 (OAuth consent screen)」</b>。</li>
    <li>用户类型选择 <b>「外部 (External)」</b>，点击「创建」。<br>
      <span style="color:var(--mut);font-size:13px">💡 如果你用的是 <b>Google Workspace</b> 账号，这里可以选「内部 (Internal)」——内部应用没有 7 天令牌限制、也无需 Google 验证，最省事。</span>
    </li>
    <li>填写基本信息：
      <ul style="margin:4px 0">
        <li><b>应用名称</b>：输入 <code>cf2gdrive</code></li>
        <li><b>用户支持电子邮件</b>：选择你自己的 Gmail 邮箱</li>
        <li><b>开发者联系信息</b>：填写你自己的 Gmail 邮箱</li>
      </ul>
      其余项目（Logo、应用网域等）可全部留空，点击「保存并继续」。
    </li>
    <li><b>添加范围 (Scopes)</b>：点击「添加或移除范围」，在搜索框输入 <code>drive</code>，勾选 <code>https://www.googleapis.com/auth/drive</code>，点击「更新」，然后点击「保存并继续」。<br>
      <span style="color:var(--mut);font-size:13px">💡 添加后该范围会出现在 <b>「Your restricted scopes（受限范围）」</b> 分组下，并标记 <b>Approval required / This scope is not yet verified</b>。个人自用<b>不必理会，也无需提交验证</b>——未验证只意味着授权页会多一道警告（点「高级」继续）和用户数上限，不会阻止你本人授权。<br>
      ⚠️ <b>范围必须在授权之前登记</b>：如果先授权、后补范围，Google 只会授予当时已登记的部分，表现为第 3 步建目录报 <code>403 insufficient authentication scopes</code>。遇到这个错误就回到第 2 步<b>重新授权一次</b>，并在存储页的「授权范围自检」区块确认已拿到 <code>auth/drive</code>。</span>
    </li>
    <li><b>测试用户</b>：直接点「保存并继续」跳过。</li>
    <li>
      <b>【发布前置】补齐品牌信息</b>（缺任意一项，「发布应用」按钮会是灰的）：
      <ul style="margin:4px 0">
        <li><b>应用首页 URL</b>：必须是你拥有且已验证域名下的页面，不能只是一个登录页</li>
        <li><b>隐私政策 URL</b>：与首页同域，且首页需链出该链接，两处填写保持一致</li>
        <li><b>已授权网域</b>：需在 <a href="https://search.google.com/search-console" target="_blank" rel="noopener">Search Console</a> 完成域名所有权验证</li>
      </ul>
    </li>
    <li>
      <b style="color:var(--dan);background:var(--nt-err-bg);padding:2px 6px;border-radius:4px">【核心必做步骤】发布应用</b>：
      <div style="margin:6px 0 6px;line-height:1.6">
        返回「OAuth 同意屏幕」首页，在「发布状态」下方点击 <b>「发布应用 (Publish App)」</b> 按钮，确认发布，状态变为 <b>「正式版 (In production)」</b>。<br>
        <span style="color:var(--mut);font-size:13px">
        💡 <b>为什么必须发布</b>：测试模式 (Testing) 下签发的 Refresh Token 只有 <b>7 天</b>寿命，一周后上传会突然失败（<code>invalid_grant</code>）；正式版令牌长期有效（被撤销或连续 6 个月未刷新才失效）。<br>
        ⚠️ <b>发布后请务必再授权一次</b>：测试期签发的令牌仍带着 7 天有效期，需要回到本站存储页重新走一遍「前往 Google 授权」，换成正式版签发的新令牌才算真正脱离 7 天限制。<br>
        💡 授权时若提示「Google 尚未验证此应用」，只需点击左下角 <b>「高级」➔「转到 cf2gdrive (不安全)」</b> 即可通过；个人自通常<b>不需要</b>主动提交验证。</span>
      </div>
    </li>
    <li>
      <b>如果「发布应用」被拦住</b>（本项目申请的 <code>auth/drive</code> 属 Google 定义的<b>受限范围</b>，控制台可能要求先完成验证）：
      <ul style="margin:4px 0">
        <li>改用 Workspace 的<b>「内部」</b>用户类型：无 7 天限制、无需验证</li>
        <li>把范围降级为非敏感的 <code>drive.file</code>：仅能访问本应用自己创建的文件，需改 <code>src/gdrive_oauth.js</code> 的 SCOPE 并重新授权（迁移前的文件将不可见）</li>
        <li>留在测试模式、每周重新授权一次（不推荐）</li>
      </ul>
      <span style="color:var(--mut);font-size:13px">受限范围验证需提交演示视频、隐私政策与用途说明；且在服务端存储受限范围数据还需通过年度安全评估（CASA），个人自用性价比极低。</span>
    </li>
  </ol>
</div>

<div class="card" style="border-left:4px solid var(--ok)">
  <h3 style="margin-top:0">🔑 阶段三：创建凭据并下载 JSON</h3>
  <ol style="font-size:14px;line-height:1.9;padding-left:20px;margin-bottom:0">
    <li>在左侧菜单点击 <b>「API 和服务」➔「凭据 (Credentials)」</b>。</li>
    <li>点击顶部的 <b>「+ 创建凭据 (+ CREATE CREDENTIALS)」</b>，选择 <b>「OAuth 客户端 ID」</b>。</li>
    <li><b>应用类型下拉框选择：「桌面应用 (Desktop App)」</b>（名称输入 <code>cf2gdrive-client</code>，点击「创建」）。</li>
    <li>创建成功后页面会弹出客户端已创建的弹窗，点击右下角的 <b>「下载 JSON (Download JSON)」</b> 按钮，将文件保存到你的电脑中（或点击复制 Client ID 和 Client Secret）。</li>
  </ol>
</div>

<div class="card" style="border-left:4px solid var(--acc)">
  <h3 style="margin-top:0">🚀 阶段四：回站粘贴与完成自举</h3>
  <ol style="font-size:14px;line-height:1.9;padding-left:20px;margin-bottom:0">
    <li>回到本站的 <a href="/admin/storage">存储管理页面 (/admin/storage)</a>。</li>
    <li>把刚刚下载的 JSON 文件直接拖入「凭据录入区」，或用文本编辑器打开复制全文粘贴进去，点击「保存凭据」。</li>
    <li>点击页面生成的「前往 Google 授权」按钮，在弹出的 Google 页面登录并同意授权（看到“未经验证”点击「高级」➔「转到...继续」）。</li>
    <li>同意后，浏览器会重定向到一个打不开的 <code>http://localhost:8085/...</code> 页面（显示连接失败）。</li>
    <li><b>直接复制该页面浏览器地址栏中的完整 URL</b>，贴回本站管理页面的【授权回调 URL】输入框中，点击【确认绑定】。</li>
    <li>绑定成功后，点击【一键在网盘创建 cf2gdrive 根目录】，整个系统即刻配置就绪！</li>
  </ol>
</div>

<div style="text-align:center;margin:30px 0">
  <a href="/admin/storage" class="btnlike" style="font-size:15px;padding:10px 24px">已获取 JSON？前往存储管理进行配置 →</a>
</div>
`,
    user,
  );
}

export function errorPage(status, title, message, user) {
  return layout(
    String(status),
    `<div class="empty" style="padding:80px 40px">
  <h1 style="font-size:48px;margin:0;color:var(--mut)">${status}</h1>
  <h2 style="margin:12px 0">${escapeHtml(title)}</h2>
  <p style="color:var(--mut)">${escapeHtml(message)}</p>
  <p><a href="/">返回首页</a></p>
</div>`,
    user || null,
  );
}

export { fmtBytes, fmtDate };
