# cf2gdrive

Cloudflare Pages 图床 + 文件中转应用 —— Google Drive 做存储后端，多用户 + 认证 + 完整页面 + REST API。

> 公开版本说明：本文中的域名、邮箱、资源 ID 和存储路径均为示例或脱敏值。功能演进见 [CHANGELOG.md](CHANGELOG.md)，测试说明见 [tests/README.md](tests/README.md)。部署前请填入自己的配置。公开发布检查见 [PUBLIC_RELEASE.md](PUBLIC_RELEASE.md)。

## 架构

```
浏览器 / API 客户端
      │  session Cookie 或 Bearer API Key
      ▼
┌─────────────────────────────────────┐
│  Cloudflare Pages Functions (cf2gdrive) │
│  ├── 页面：图库/文件中转/发现/回收站/分享/密钥/导入导出/设备/审计/文档/设置/管理 │
│  ├── REST API：/api/*        │
│  ├── 图片服务：/i/:id（缓存/Range/ETag）、/t/:id（缩略图）│
│  └── 文件服务：/f/:id（文件中转，与 /i/ 完全隔离）│
└──────────┬──────────────────┘
           │ OAuth2 refresh token（用户身份，非 SA）
           ▼
┌──────────────┐    ┌──────────────────┐
│  D1 (SQLite) │    │  Google Drive    │
│ users/sessions│    │  cf-pic2gdrive   │
│ api_keys     │    │  ├ <md5(邮箱)前4位>/<1..255>/<8位id>.<ext>
│ images       │    │  │ （图库，v1.24 分片：每目录 ≤255 个文件）│
│ storage_dirs │    │  └ <邮箱>/<8位id>.<ext>
│ relay_files  │    │    （文件中转，每用户一个目录）│
│ user_folders │    └──────────────────┘
│ share_links  │
│ audit_log    │
│ rate_limits  │
│ settings     │
└──────────────┘
```

**为什么用 OAuth 用户身份而不是服务账号**：服务账号（SA）存储配额为 0，上传必返 403
`storageQuotaExceeded`。因此应用使用管理员自行授权的 Google 用户的
OAuth2 refresh token，文件归属该用户、占用其实际可用配额。refresh token 可能过期或被撤销，
access token 用时自动刷新并按 isolate 缓存。

## 功能

### 账号与权限
- **多用户**：注册/登录/登出，PBKDF2-SHA256（10 万次迭代）密码哈希，HttpOnly+Secure+SameSite=Lax 会话 Cookie，30 天滑动续期
- **邀请码注册（v1.2）**：注册必须提供有效邀请码；仅管理员可生成/分发（可设次数与有效期、可吊销），核销为原子条件更新，防并发超用
- **配额管理（v1.4 / v1.5）**：管理员可设「新用户默认配额」（如 500G/2T）并在用户表行内调整单人配额；上传前做客户端配额预判 + 服务端权威校验
- **用户管理（v1.16）**：邮箱/昵称搜索 + 状态筛选、禁用（立即踢掉所有会话）/启用、删除用户（级联清理 + Drive 文件后台删），带「不能操作自己」「至少保留一名活跃管理员」双护栏
- **会话设备管理（v1.17）**：`/sessions` 列出全部设备（UA → 友好名、IP、最后活跃），可单设备注销或一键注销其他所有设备
- **审计日志（v1.18）**：登录/上传/删除/分享/设备/管理动作全量落库（append-only，actor 邮箱快照），`/audit` 管理员看全站、普通用户看本人，支持动作 + 关键字筛选与分页

### 上传与浏览
- **图库**：网格视图、分页、用量统计、拖拽上传、粘贴上传（v1.8）、从 URL 上传（v1.9，SSRF 防护）、复制链接、重命名、删除
- **缩略图（v1.5）**：格子加载 Drive 服务端渲染的 400px 缩略图（`/t/:id`），与 `/i/:id` 同样的门控 + Cache API 缓存
- **灯箱（v1.7）**：全屏查看、左右键翻页、Esc 关闭、移动端滑动切换、EXIF 信息条（v1.12）
- **搜索筛选排序（v1.10）**：文件名关键词（LIKE 元字符转义）、公开/私有筛选、五种排序
- **多选批量（v1.20）**：图库与回收站勾选框 + 批量改可见性/删除/恢复/彻底删除，支持 Shift 连选与 Esc 清空
- **公开画廊（v1.23）**：`/explore` 匿名展示所有被标记为公开的图片，带灯箱与分页，不暴露所有者；管理员可整体关闭
- **分片存储（v1.24）**：图片按 `<md5(邮箱)前4位>/<1..255>/<8位id>.<ext>` 三级落盘，每个目录最多 255 个文件，写满自动开下一个分片；目录 id 与计数缓存在 D1，选目录零 Drive 往返，255 上限用 `UPDATE … WHERE file_count<255 RETURNING` 原子占位

### 文件中转（v1.26，与图库完全独立）
- **独立暂存区**：顶栏「文件中转」入口（位于图库之后）+ 独立页面 `/files`；独立表 `relay_files`、独立前缀 `/f/<自增id>`、独立删除/回收/批量，与图库零数据耦合
- **每用户一个目录**：中转文件按 `<邮箱>/<8位id>.<ext>` 落盘（邮箱消毒：`@`→`-at-`、`.`→`-`，非法字符替换，截断 80，重名追加短哈希），目录 id 缓存在 D1 `user_folders`，选目录零 Drive 往返
- **门控与缓存**：私有仅所有者会话/密钥可读（匿名 403），公开可匿名读；ETag/304、`X-Content-Type-Options: nosniff`、inline 展示、Cache API 缓存公开文件、浏览量统计
- **管理操作**：重命名、软删除/恢复/彻底删除、批量删除/恢复/彻底删除、live/trash 双 tab、灯箱预览、复制链接；上传走同一套嗅探/限流/配额校验

### 数据与分享
- **回收站（v1.11）**：软删除即时释放配额，可恢复/彻底删除/清空；管理员可按保留天数手动清理；当前 Pages 部署不提供每日定时清理
- **分享链接（v1.13）**：为单张图片创建带有效期（1/7/30 天或永久）或永久有效的 `/s/<token>`，128 bit 令牌，可随时吊销
- **导入导出（v1.22）**：`/api/export` 导出元数据清单（CSV 带 BOM / JSON），`/api/import` 从 URL 列表批量导入（≤50 条/次，逐行结果）
- **不可枚举标识（v1.25）**：图片对外只有 12 位随机十六进制串（`images.public_id`，48 bit，唯一索引 + 冲突重试），`/i/`、`/t/`、`/api/images/` 与批量 `ids` 全部走它；数据库自增 id 只做内部关联，`/i/65`、`/api/images/65` 一律 404（不重定向、不设登录门），既不能顺序猜下一张，也不泄漏站内图片总量
- **存储运维（v1.24）**：`/admin/storage` 查看每个分片的占用与 Drive 目录 id、按 `images` 表重算计数、按批（1–100）把 v1.24 之前平铺在根目录的历史文件迁移进分片并改名为 8 位 id（不改文件内容与文件 id，分享链接照旧）
- **图片服务**：私有（仅所有者）/公开两种模式，Cache API 缓存公开图，Range 206、ETag 304、HEAD、浏览量统计
- **REST API**：Bearer API Key（哈希存储、可吊销、创建时仅展示一次、可选有效期）；`GET /api/meta` 服务自描述

### 体验与安全
- **深色模式（v1.14）/ 移动端适配（v1.15）**：双 CSS 变量主题 + localStorage + 跟随系统偏好 + 防 FOUC；640px 断点、表格横滚、流体登录卡
- **性能（v1.20）**：5 个覆盖索引把画廊筛选/回收站列表/cron 扫描/分享计数全部从全表扫描或临时排序改为索引扫描；`/admin` 与 `/audit` 合并为单次 D1 batch 往返
- **安全（v1.21）**：CSRF 收口到分发层（Cookie 写请求跨源一律 403，Bearer 豁免）、CSP/HSTS/XFO/nosniff/Referrer-Policy/Permissions-Policy、类型按字节嗅探（SVG/HTML 拒收）、登录/注册/上传/建密钥/导入限流
- **设置**：改资料、改密码、查看配额与操作记录

## 本地开发

```bash
npm install
cp .dev.vars.example .dev.vars
# 在 .dev.vars 中设置独立随机 SESSION_SECRET；Google 凭据推荐在网页端配置。
# 不要提交 .dev.vars、OAuth JSON、数据库导出或本地部署配置。
npm run db:local   # 应用 schema 到本地 D1
npm run dev        # http://localhost:8787
```

测试需要独立的本地数据库与专用 Google Drive 测试账号，详见 [测试说明](tests/README.md)。不要连接生产账号运行集成测试。

## 部署

应用**只部署为 Cloudflare Pages**（Functions + 静态资源），单一形态、单一配置文件：

| 形态 | 地址 | 用途 |
|---|---|---|
| Pages | https://your-project.pages.dev（默认地址）· https://files.example.com（自定义域名） | 唯一部署目标；自定义域名走 Pages（外部 DNS 无需移交 NS） |

> v2.38.0 起移除 Worker 形态（删除 `wrangler.worker.toml` 与 `npm run deploy`）。
> 注意：Pages Functions 没有 cron，原 Worker cron 驱动的每日回收站/过期分享令牌清扫随之移除；
> 回收站保留期（`trash_retention_days`）与「立即清理」按钮仍由管理员在后台手动触发。

```bash
# 1. 创建自己的 D1，将 database_id 替换为创建结果；仓库中的全零 UUID 仅为占位。
# cf-picbed / cf-picbed-db 是示例资源名称，可按自己的部署调整。
# 不要将绑定真实资源 ID 的本地配置再次提交到公共仓库。
npm run db:remote

# 2. Pages secrets（一次性；env_vars 按部署快照注入：先设 secret，再部署）
wrangler pages secret put SESSION_SECRET --project-name cf-picbed   # 随机值，用于加密 D1 中的 Google 凭据
wrangler pages secret put ADMIN_EMAILS --project-name cf-picbed     # 可选：逗号分隔，这些邮箱注册即管理员
# 也可以从 .dev.vars 批量导入：
while IFS='=' read -r k v; do
  case "$k" in GOOGLE_*|DRIVE_*|ADMIN_*|SESSION_*)
    printf '%s' "$v" | npx wrangler pages secret put "$k" --project-name cf-picbed ;;
  esac
done < .dev.vars

# v2.37 起支持「零配置自举」：数据库 users 表为空时，第一位注册者免邀请码且自动成为 admin；
# 从第 2 位起恢复邀请码校验。因此全新部署无需手工预埋邀请码，也无需预先配置 ADMIN_EMAILS。

# 3. 构建 + 发布 Pages
npx wrangler pages project create cf-picbed --production-branch main   # 首次
npm run build:pages                                                    # 产出 dist/
npm run deploy:pages                                                   # = wrangler pages deploy dist ...
# 若刚改过 secret，需再跑一次 npm run deploy:pages 使其生效
```

自定义域名示例 `files.example.com`（替换为你拥有的域名，DNS 可由外部服务商管理）：

```bash
# 添加域名（wrangler v4 无 pages domain 子命令，走 API）
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/pages/projects/cf-picbed/domains" \
  -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  -d '{"name": "files.example.com"}'
# 前置：在 DNS 服务商处将 files CNAME 指向你实际的 Pages 域名（先解析生效）

# 查看状态（initializing → pending → active，通常 1–2 分钟）
curl -s "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/pages/projects/cf-picbed/domains" \
  -H "Authorization: Bearer $CF_TOKEN"
# 等待 Pages 显示域名和证书为 active；具体签发与续期信息以控制台为准。
```

## Cloudflare 运维脚本

所有 Cloudflare 侧操作都收敛到 **`scripts/cf.sh`**，无需手工拼命令、也不依赖助手：

```bash
bash scripts/cf.sh <命令>
```

| 命令 | 作用 |
|---|---|
| `whoami` | 查看登录账号与 Account ID |
| `db-list` / `db-create` / `db-bind <id>` / `db-schema` | D1 全生命周期（建库 → 写回 wrangler*.toml → 应用 schema） |
| `db-query "<SQL>" [--force]` | 查远端 D1；**默认只允许 SELECT/WITH/PRAGMA/EXPLAIN**，写语句必须加 `--force` |
| `secret-put <KEY> [value]` / `secret-list` | Pages secrets（值可省略，从 stdin 读） |
| `pages-create` / `build` / `deploy` | Pages 项目创建、构建 dist、部署 |
| `domain-add <fqdn>` / `domain-list` / `domain-del <fqdn> --yes` | 自定义域名（自动校验 CNAME 并等待证书生效） |
| `status [url]` | 线上 healthz + 证书 + 域名状态 |
| `doctor` | 一键体检：登录、D1 绑定、schema、secret、域名、线上可达性 |

全新账号从零到上线的最小路径：

```bash
npx wrangler login
bash scripts/cf.sh db-create                                   # 建 D1
bash scripts/cf.sh db-bind <上一步输出的 database_id>            # 写回配置
bash scripts/cf.sh db-schema                                   # 建表
bash scripts/cf.sh pages-create                                # 建 Pages 项目
bash scripts/cf.sh secret-put SESSION_SECRET "$(openssl rand -hex 32)"
bash scripts/cf.sh deploy                                      # 构建 + 部署
bash scripts/cf.sh domain-add files.example.com                    # 绑域名
CF_PRIMARY_URL=https://files.example.com bash scripts/cf.sh doctor # 检查自己的部署
```

说明：脚本自动清除代理环境变量；使用 `wrangler login` 存在
`~/.wrangler/config/default.toml` 的 OAuth token 调用 Cloudflare API，**不需要另配 API Token**；
Account ID 自动探测，也可通过 `CLOUDFLARE_ACCOUNT_ID` 指定。依赖 `dig`（域名校验）与 `node`（JSON 解析）。

## Google Drive 凭据与「发布到生产」

应用以**你自己的 Google 账号**运行，文件存在个人网盘并占用其免费 15GB 配额。凭据在网页端自举获取：
管理员登录 → `/admin/storage`（顶部导航「存储配置」）→ 页内 `/admin/storage/guide` 有同样的图文步骤。
凭据（client_secret / refresh_token）经 `SESSION_SECRET` 派生的 AES-GCM-256 密钥加密后存进 D1，不落配置文件。

### 1. 创建 GCP 项目并启用 Drive API

`console.cloud.google.com` 新建项目 → 「API 和服务」→「库」→ 搜索并启用 **Google Drive API**。

### 2. 配置 OAuth 同意屏幕

- **用户类型**：个人 Gmail 选「外部 (External)」；**如果你有 Google Workspace，选「内部 (Internal)」最省事**——内网型应用没有 7 天令牌限制，也无需 Google 验证。
- **应用信息**：应用名称、用户支持邮箱、开发者联系邮箱（其余可留空）。
- **范围**：添加 `https://www.googleapis.com/auth/drive`（应用还会自动带上 `userinfo.email`、`userinfo.profile`，见 `src/gdrive_oauth.js` 的 `SCOPE`）。
  - 添加后它会归入 **Your restricted scopes（受限范围）** 并标记 `Approval required` / `This scope is not yet verified`。个人自用无需提交验证：未验证只带来「未验证应用」警告页和用户数上限，不阻止本人授权。
  - **范围必须在授权之前登记**。若先授权后补范围，Google 只授予当时已登记的子集 → 建目录时报
    `403 insufficient authentication scopes`。修法：补登记后在 `/admin/storage` 第 2 步重新授权一次，
    并用页内「🔍 授权范围自检」确认已拿到 `auth/drive`。
- **品牌信息（发布的前置条件，缺一项「发布应用」按钮就是灰的）**：
  - 应用首页 URL：必须是你拥有且已验证域名下的页面，且不能只是一个登录页
  - 隐私政策 URL：与首页同域，首页需链出该链接，并与同意屏幕填的一致
  - 已授权网域：需在 **Search Console** 完成域名所有权验证
  - 项目联系方式保持最新（Google 会用它通知验证事宜）

### 3. 发布应用（这一步决定令牌寿命）

回到「OAuth 同意屏幕」→ 点 **「发布应用 (Publish App)」** → 状态变为「正式版 (In production)」。

| 发布状态 | refresh token 寿命 | 可授权用户 |
|---|---|---|
| 测试 (Testing) | **7 天后过期** | 仅 ≤100 个测试用户 |
| 正式版 (In production) | 长期有效（被撤销、或连续 6 个月未刷新才失效） | 不限 |

> 本项目靠 refresh token 长期免交互访问网盘，**停留在测试状态 = 每 7 天失效一次**，
> 表现为一周后突然上传失败（`invalid_grant`）。所以发布不是可选项。

**发布后必须再授权一次**：测试状态下签发的 token 仍带着 7 天有效期，需在 `/admin/storage`
重新走一遍「前往 Google 授权」，换成正式版签发的新 refresh token 才算真正脱离 7 天限制。

其他寿命规则：每个「客户端 ID + 用户」最多 50 个 refresh token（超出会让最旧的失效）；
连续 6 个月不刷新会过期——本项目每次读写都会刷新 access token，正常使用不会触发。

### 4. 创建凭据并回站自举

「凭据」→「+ 创建凭据」→「OAuth 客户端 ID」→ 应用类型选 **桌面应用 (Desktop app)** → 下载 JSON
→ 粘进 `/admin/storage` 的凭据录入区 →「前往 Google 授权」→ 授权后浏览器会跳到打不开的
`http://localhost:8085/callback`，**把地址栏整条 URL 复制回页面**点「确认绑定」→「一键创建根目录」。
（rclone 式本地回调，不需要真的在本机起服务监听 8085。）

### 5. 关于「未验证应用」与受限范围（踩坑提示）

本项目申请的是 `auth/drive`，Google 把它定义为**受限范围**（restricted），这一点会影响发布：

| 场景 | 做法 |
|---|---|
| 个人或亲友自用 | 补齐品牌信息后一般可直接发布。授权页出现「Google 尚未验证此应用」属正常，点 **「高级」→「转到 cf2gdrive（不安全）」** 继续即可，通常不必主动提交验证 |
| 控制台要求先验证才允许发布 | 受限范围验证要提交演示视频、隐私政策、用途说明；且**在服务端存储/传输受限范围数据还需通过年度安全评估（CASA）**——个人自用性价比极低 |
| 上述受阻时的退路 | ① 改用 Workspace「内部」用户类型（无 7 天限制、无需验证）；② 把 `SCOPE` 降级为非敏感的 `drive.file`（仅可访问本应用自己创建的文件，需改 `src/gdrive_oauth.js` 并重新授权，迁移前的文件将不可见）；③ 留在测试模式每周重新授权一次（不推荐） |

依据：[Drive API 范围敏感度](https://developers.google.com/drive/api/guides/api-specific-auth)、
[OAuth 应用验证要求](https://support.google.com/cloud/answer/13464321)、
[受限范围年度安全评估](https://support.google.com/cloud/answer/13465431)、
[refresh token 过期规则](https://developers.google.com/identity/protocols/oauth2)。

## API 速览

认证：`Authorization: Bearer pb_live_xxx`

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/upload | multipart 上传（`file=`，可加 `visibility=public`） |
| GET | /api/images?page=&per_page= | 列表 |
| GET | /api/images/:id | 元数据 |
| PATCH | /api/images/:id | 重命名 |
| DELETE | /api/images/:id | 软删除 |
| POST | /api/images/batch-delete | 批量软删除 |
| GET | /api/trash | 回收站 |
| POST | /api/images/:id/restore | 恢复 |
| DELETE | /api/images/:id/purge | 彻底删除 |
| POST/GET/DELETE | /api/keys [/id] | 密钥管理 |
| GET | /api/stats | 用量统计 |
| GET | /api/admin/invites | 邀请码列表（仅管理员） |
| POST | /api/admin/invites | 生成邀请码 `{"note","max_uses","expires_in_days"}`（仅管理员） |
| DELETE | /api/admin/invites/:id | 吊销邀请码（仅管理员） |

图片访问：`GET /i/:id`（私有图需要所有者会话或密钥）

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| MAX_UPLOAD_MB | 20 | 单文件大小上限 |
| ADMIN_EMAILS | 空 | 管理员邮箱列表 |
| DRIVE_FOLDER_ID | 空 | 兼容旧部署/直接 Drive 测试；网页配置后应用无需此变量 |
| GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN | 空 | 兼容旧部署/直接 Drive 测试；网页配置后应用无需这些变量 |
| SESSION_SECRET | 部署时必须设置 | v2.0 起用于 HKDF 派生 AES-GCM-256 密钥，加密存入 D1 的 Google client_secret / refresh_token；未设置时回退到内置不安全种子 |

## 测试与兼容性

参见 [tests/README.md](tests/README.md)。测试脚本是开发辅助工具，可能修改本地 D1 和真实 Drive；公共版本不包含远端 D1 写入测试或历史压测脚本。

## 版本变化

参见 [CHANGELOG.md](CHANGELOG.md)。公开仓库不携带原部署记录、内部讨论或历史验收数据。

## 已知限制

- D1 元数据与 Drive 文件操作不构成跨系统事务；并发配额检查及失败补偿需谨慎处理。
- 软删除不立即释放 Drive 空间；Pages Functions 无定时清理入口。
- Relay 前端文件选择上限与后端配置上限不同，实际允许值以后端配置为准。
- 分片上传的 SHA-256 来自客户端声明，不等同于服务端重新计算验证。
- 浏览器分段下载最终在内存中组装，超大文件建议使用命令行工具。
- 页面 CSP 仍允许内联脚本；公开源码不代表已经完成独立安全审计。
