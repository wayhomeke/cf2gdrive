#!/usr/bin/env bash

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
export SCRIPT_TMP="$SCRIPT_ROOT/tmp"
mkdir -p "$SCRIPT_TMP" || exit 1
# cf.sh — one-stop Cloudflare operations for cf2gdrive.
#
# Wraps every Cloudflare step that used to be done by hand (or by asking an
# assistant): account check, D1 lifecycle, schema, Pages secrets, build +
# deploy, custom domains and a post-deploy health check. Everything is
# idempotent where it can be, and every destructive action asks first.
#
# Usage:  bash scripts/cf.sh <command> [args]      (add -h for help)
#
# Auth:   uses the OAuth token that `wrangler login` stored in
#         ~/.wrangler/config/default.toml — no API token needed.
set -uo pipefail
cd "$(dirname "$0")/.."

# Proxies (Clash etc.) break both wrangler and api.cloudflare.com.
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy

ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"
PROJECT="${CF_PAGES_PROJECT:-cf-picbed}"
DB_NAME="${CF_D1_NAME:-cf-picbed-db}"
PRIMARY_URL="${CF_PRIMARY_URL:-http://localhost:8787}"

WRANGLER_CONFIG="$HOME/Library/Preferences/.wrangler/config/default.toml"
[ -f "$WRANGLER_CONFIG" ] || WRANGLER_CONFIG="$HOME/.wrangler/config/default.toml"

# ---------------------------------------------------------------- helpers ---
die()  { echo "✘ $*" >&2; exit 1; }
info() { echo "› $*"; }
ok()   { echo "✔ $*"; }
warn() { echo "⚠ $*" >&2; }

wrangler() {
  if [ -x "node_modules/.bin/wrangler" ]; then
    node_modules/.bin/wrangler "$@"
  else
    npx -y wrangler "$@"
  fi
}

token() {
  local t
  t=$(sed -n 's/^oauth_token *= *"\(.*\)"$/\1/p' "$WRANGLER_CONFIG" 2>/dev/null | head -1)
  [ -n "$t" ] || die "未找到 wrangler OAuth token（$WRANGLER_CONFIG）。请先执行: npx wrangler login"
  printf '%s' "$t"
}

account() {
  if [ -n "$ACCOUNT_ID" ]; then printf '%s' "$ACCOUNT_ID"; return; fi
  local j
  j=$(curl -s --max-time 20 "https://api.cloudflare.com/client/v4/accounts" \
        -H "Authorization: Bearer $(token)")
  local id
  id=$(printf '%s' "$j" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const r=JSON.parse(d);console.log((r.result||[])[0]?.id||'')}catch(e){console.log('')}})")
  [ -n "$id" ] || die "无法解析 Account ID，请显式设置 CLOUDFLARE_ACCOUNT_ID=..."
  printf '%s' "$id"
}

cf_api() { # cf_api <GET|POST|DELETE> <path> [json-body]
  local method="$1" path="$2" body="${3:-}"
  local args=(-s --max-time 30 -X "$method"
    "https://api.cloudflare.com/client/v4/accounts/$(account)${path}"
    -H "Authorization: Bearer $(token)")
  [ -n "$body" ] && args+=(-H "Content-Type: application/json" -d "$body")
  curl "${args[@]}"
}

# --------------------------------------------------------------- commands ---
cmd_whoami() {
  wrangler whoami 2>&1 | sed -n '1,12p'
  echo "Account ID: $(account)"
}

cmd_db_list() { wrangler d1 list; }

cmd_db_create() {
  if wrangler d1 list 2>/dev/null | grep -q "$DB_NAME"; then
    ok "D1 数据库 '$DB_NAME' 已存在，跳过创建"
  else
    info "创建 D1 数据库 '$DB_NAME'..."
    wrangler d1 create "$DB_NAME" | tee "${SCRIPT_TMP}"/cf-db-create.log
  fi
  echo
  info "把输出的 database_id 绑定到配置文件："
  echo "  bash scripts/cf.sh db-bind <database_id>"
}

cmd_db_bind() { # update database_id in both wrangler configs (with backups)
  local id="${1:-}"
  [ -n "$id" ] || die "用法: cf.sh db-bind <database_id>"
  for f in wrangler.toml wrangler.worker.toml; do
    [ -f "$f" ] || continue
    cp "$f" "$f.bak"
    python3 - "$f" "$id" <<'PY'
import re, sys
p, new = sys.argv[1], sys.argv[2]
s = open(p, encoding="utf-8").read()
s2 = re.sub(r'(database_id\s*=\s*)"[^"]*"', lambda m: m.group(1) + f'"{new}"', s)
open(p, "w", encoding="utf-8").write(s2)
print("updated" if s2 != s else "unchanged", p)
PY
  done
  ok "database_id=$id 已写入 wrangler*.toml（原文件备份为 *.bak）"
}

cmd_db_schema() {
  info "应用 schema.sql 到远端 $DB_NAME ..."
  CLOUDFLARE_ACCOUNT_ID="$(account)" wrangler d1 execute "$DB_NAME" --remote --file=schema.sql \
    | tail -5
  ok "schema 已应用"
}

cmd_db_query() { # read-only by default; anything else needs --force
  local sql="${1:-}" force="no"
  [ -n "$sql" ] || die "用法: cf.sh db-query \"SELECT ...\" [--force]"
  [ "${2:-}" = "--force" ] && force="yes"
  # Whitelist read-only statements. NOTE: do not rely on grep -E '\b' here —
  # macOS/BSD grep does not support \b, which silently disables the guard.
  local lower
  lower=$(printf '%s' "$sql" | tr '[:upper:]' '[:lower:]')
  if [ "$force" != "yes" ] && [[ ! "$lower" =~ ^[[:space:]]*(select|with|pragma|explain)[[:space:]] ]]; then
    die "只允许只读语句（SELECT/WITH/PRAGMA/EXPLAIN）。确认后加 --force 执行：$sql"
  fi
  if [ "$force" = "yes" ]; then
    warn "即将在【远端生产库】执行写操作：$sql"
  fi
  CLOUDFLARE_ACCOUNT_ID="$(account)" wrangler d1 execute "$DB_NAME" --remote \
    --command "$sql" --json
}

cmd_secret_put() { # value from $2 or stdin
  local key="${1:-}" val="${2:-}"
  [ -n "$key" ] || die "用法: cf.sh secret-put <KEY> [value]   （省略 value 则从 stdin 读取）"
  if [ -z "$val" ]; then val=$(cat); fi
  [ -n "$val" ] || die "secret 值为空"
  printf '%s' "$val" | CLOUDFLARE_ACCOUNT_ID="$(account)" \
    wrangler pages secret put "$key" --project-name "$PROJECT" >/dev/null
  ok "Pages secret '$key' 已写入"
  warn "Pages 的 env_vars 按部署快照注入：改完 secret 需执行 cf.sh deploy 才会生效"
}

cmd_secret_list() {
  CLOUDFLARE_ACCOUNT_ID="$(account)" wrangler pages secret list --project-name "$PROJECT"
}

cmd_pages_create() {
  if cf_api GET "/pages/projects" | grep -q "\"name\":\"$PROJECT\""; then
    ok "Pages 项目 '$PROJECT' 已存在"
  else
    cf_api POST "/pages/projects" "{\"name\":\"$PROJECT\",\"production_branch\":\"main\"}" >/dev/null
    ok "Pages 项目 '$PROJECT' 已创建"
  fi
}

cmd_build() { bash scripts/build-pages.sh; }

cmd_deploy() {
  cmd_build >/dev/null
  info "部署到 Pages 项目 '$PROJECT' ..."
  CLOUDFLARE_ACCOUNT_ID="$(account)" \
    wrangler pages deploy dist --project-name "$PROJECT" --branch main | tail -6
}

cmd_domain_add() {
  local fqdn="${1:-}"
  [ -n "$fqdn" ] || die "用法: cf.sh domain-add <fqdn>"
  local target
  target=$(dig +short "$fqdn" CNAME 2>/dev/null | head -1 | sed 's/\.$//')
  if [ -z "$target" ]; then
    die "$fqdn 没有 CNAME 记录。请先在 DNS 服务商把该主机名 CNAME 指向 ${PROJECT}.pages.dev，再执行本命令。"
  fi
  info "CNAME: $fqdn -> $target"
  local res status i
  res=$(cf_api POST "/pages/projects/$PROJECT/domains" "{\"name\":\"$fqdn\"}")
  printf '%s' "$res" | grep -q '"success":true' || { echo "$res"; die "添加域名失败"; }
  for i in 1 2 3 4 5 6 7 8; do
    sleep 20
    status=$(cf_api GET "/pages/projects/$PROJECT/domains" \
      | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const r=JSON.parse(d).result||[];const m=r.find(x=>x.name==='$fqdn');console.log(m?m.status:'?')}catch(e){console.log('?')}})")
    echo "  [$i] $fqdn: $status"
    [ "$status" = "active" ] && { ok "域名已生效：$fqdn"; return 0; }
  done
  warn "仍在 $status，证书可能还在签发（一般几分钟内完成）。用 cf.sh domain-list 复查。"
}

cmd_domain_list() {
  cf_api GET "/pages/projects/$PROJECT/domains" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  const r=(JSON.parse(d).result)||[];
  if(!r.length){console.log('(无自定义域名)');return}
  for(const x of r) console.log([x.name,x.status,(x.validation_data&&x.validation_data.status)||'-',x.certificate_authority||'-'].join('  |  '));
})"
}

cmd_domain_del() {
  local fqdn="${1:-}" yes="${2:-}"
  [ -n "$fqdn" ] || die "用法: cf.sh domain-del <fqdn> --yes"
  [ "$yes" = "--yes" ] || die "这是破坏性操作，请显式加 --yes"
  cf_api DELETE "/pages/projects/$PROJECT/domains/$fqdn" >/dev/null
  ok "已移除域名 $fqdn"
}

cmd_status() {
  local url="${1:-$PRIMARY_URL}"
  info "线上状态：$url"
  local h
  h=$(curl -s --max-time 20 "$url/healthz")
  if [ -z "$h" ]; then echo "✘ $url 无响应"; else echo "  healthz: $h"; fi
  if [[ "$url" == https://* ]]; then
    local authority host port
    authority="${url#https://}"; authority="${authority%%/*}"
    authority="${authority%%\?*}"; authority="${authority%%\#*}"
    host="${authority%%:*}"; port=443
    [[ "$authority" == *:* ]] && port="${authority##*:}"
    if [[ "$authority" == \[* ]]; then
      host="${authority%%\]*}]"
      port="${authority#"$host"}"; port="${port#:}"; port="${port:-443}"
    fi
    echo "  证书: $(echo | openssl s_client -connect "$host:$port" -servername "${host//[\[\]]/}" 2>/dev/null | openssl x509 -noout -subject -dates 2>/dev/null | tr '\n' ' ')"
  else
    echo "  证书: HTTP 目标，跳过 TLS 检查"
  fi
  echo "  自定义域名:"; cmd_domain_list | sed 's/^/    /'
}

cmd_doctor() {
  echo "=== cf2gdrive 体检 ==="
  local fail=0
  # 1. login
  if [ -f "$WRANGLER_CONFIG" ] && [ -n "$(token 2>/dev/null)" ]; then ok "wrangler 已登录"; else echo "✘ wrangler 未登录 → npx wrangler login"; fail=1; fi
  # 2. account
  local acc; acc=$(account 2>/dev/null) && [ -n "$acc" ] && ok "Account: $acc" || { echo "✘ 无法获取 Account ID"; fail=1; }
  # 3. D1 binding matches a real database
  local cfg_id; cfg_id=$(sed -n 's/^database_id *= *"\(.*\)"$/\1/p' wrangler.toml | head -1)
  if wrangler d1 list 2>/dev/null | grep -q "$cfg_id"; then ok "D1 绑定有效: $cfg_id"; else echo "✘ wrangler.toml 的 database_id ($cfg_id) 在当前账号不存在 → cf.sh db-create && cf.sh db-bind <id>"; fail=1; fi
  # 4. schema applied
  local tables
  tables=$(CLOUDFLARE_ACCOUNT_ID="$(account)" wrangler d1 execute "$DB_NAME" --remote \
    --command "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table';" --json 2>/dev/null \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d)[0].results[0].c)}catch(e){console.log('')}})")
  if [ "${tables:-0}" -ge 10 ] 2>/dev/null; then ok "schema 已应用（$tables 张表）"; else echo "✘ schema 未就绪（表数=$tables） → cf.sh db-schema"; fail=1; fi
  # 5. secrets
  if CLOUDFLARE_ACCOUNT_ID="$(account)" wrangler pages secret list --project-name "$PROJECT" 2>/dev/null | grep -q SESSION_SECRET; then
    ok "Pages secret SESSION_SECRET 已设置"
  else
    echo "⚠ 缺少 SESSION_SECRET（Google 凭据加密依赖它） → cf.sh secret-put SESSION_SECRET \$(openssl rand -hex 32)"
  fi
  # 6. custom domain (API returns pretty-printed JSON — parse, don't grep)
  local active_doms
  active_doms=$(cf_api GET "/pages/projects/$PROJECT/domains" 2>/dev/null | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  try{const r=JSON.parse(d).result||[];console.log(r.filter(x=>x.status==='active').map(x=>x.name).join(', '))}catch(e){console.log('')}})")
  if [ -n "$active_doms" ]; then ok "自定义域名(active): $active_doms"; else echo "⚠ 没有 active 的自定义域名 → cf.sh domain-add <fqdn>"; fi
  # 7. healthz
  local h; h=$(curl -s --max-time 20 "$PRIMARY_URL/healthz")
  [ -n "$h" ] && ok "线上可达: $h" || { echo "✘ $PRIMARY_URL 不可达"; fail=1; }
  echo "=== 体检结束 ==="
  return $fail
}

usage() {
  cat <<'EOF'
cf.sh — cf2gdrive 的 Cloudflare 运维入口

  whoami                       查看登录账号与 Account ID
  db-list                      列出账号下的 D1 数据库
  db-create                    创建 D1 数据库（已存在则跳过）
  db-bind <database_id>        把 database_id 写入 wrangler*.toml（自动备份）
  db-schema                    应用 schema.sql 到远端 D1
  db-query "<SQL>" [--force]   查询远端 D1（写操作需 --force）
  secret-put <KEY> [value]     设置 Pages secret（省略 value 则从 stdin 读）
  secret-list                  列出 Pages secrets
  pages-create                 创建 Pages 项目（已存在则跳过）
  build                        构建 dist/
  deploy                       构建 + 部署 Pages
  domain-add <fqdn>            添加自定义域名（自动校验 CNAME + 等待生效）
  domain-list                  列出自定义域名与状态
  domain-del <fqdn> --yes      移除自定义域名
  status [url]                 检查 healthz / 证书 / 域名
  doctor                       一键体检（登录、D1、schema、secret、域名、线上）

环境变量：CLOUDFLARE_ACCOUNT_ID、CF_PAGES_PROJECT（默认 cf-picbed）、
          CF_D1_NAME（默认 cf-picbed-db）、CF_PRIMARY_URL（默认 http://localhost:8787）
EOF
}

main() {
  local cmd="${1:-}"
  [ -n "$cmd" ] || { usage; exit 1; }
  shift || true
  case "$cmd" in
    whoami)        cmd_whoami ;;
    db-list)       cmd_db_list ;;
    db-create)     cmd_db_create ;;
    db-bind)       cmd_db_bind "$@" ;;
    db-schema)     cmd_db_schema ;;
    db-query)      cmd_db_query "$@" ;;
    secret-put)    cmd_secret_put "$@" ;;
    secret-list)   cmd_secret_list ;;
    pages-create)  cmd_pages_create ;;
    build)         cmd_build ;;
    deploy)        cmd_deploy ;;
    domain-add)    cmd_domain_add "$@" ;;
    domain-list)   cmd_domain_list ;;
    domain-del)    cmd_domain_del "$@" ;;
    status)        cmd_status "$@" ;;
    doctor)        cmd_doctor ;;
    -h|--help|help) usage ;;
    *) echo "未知命令: $cmd"; usage; exit 1 ;;
  esac
}

main "$@"
