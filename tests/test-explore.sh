#!/usr/bin/env bash

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
export SCRIPT_TMP="$SCRIPT_ROOT/tmp"
mkdir -p "$SCRIPT_TMP" || exit 1
# v1.23 public gallery test — anonymous /explore, its JSON API, the admin switch
# and the privacy boundary (only public, non-deleted images, no owner identity).
set -u
cd "$(dirname "$0")/.."
PORT=8787
BASE="http://127.0.0.1:$PORT"
PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1"; PASS=$((PASS+1)); else echo "FAIL  $1 (got:$2 want:$3)"; FAIL=$((FAIL+1)); fi; }

. ./tests/_schema.sh   # shared idempotent DDL (local D1 persists between suites)
wrangler d1 execute cf-picbed-db --local --command "DELETE FROM rate_limits; DELETE FROM sessions; DELETE FROM images; DELETE FROM users WHERE email LIKE '%example.com'; DELETE FROM settings;" > /dev/null 2>&1
wrangler d1 execute cf-picbed-db --local --command "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);" > /dev/null 2>&1
wrangler d1 execute cf-picbed-db --local --command "CREATE TABLE IF NOT EXISTS share_links (id INTEGER PRIMARY KEY AUTOINCREMENT, image_id INTEGER NOT NULL, token TEXT NOT NULL UNIQUE, created_by INTEGER NOT NULL, expires_at TEXT, views INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));" > /dev/null 2>&1
wrangler d1 execute cf-picbed-db --local --command "CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, actor_email TEXT, action TEXT NOT NULL, target TEXT, detail TEXT, ip TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));" > /dev/null 2>&1
wrangler d1 execute cf-picbed-db --local --command "DELETE FROM invite_codes; INSERT OR IGNORE INTO users (email,password_hash,password_salt,display_name,role) VALUES ('seed-admin@example.com','x','x','SeedAdmin','admin'); INSERT INTO invite_codes (code,created_by,max_uses,used_count,note) VALUES ('SEEDEXPL',(SELECT id FROM users WHERE email='seed-admin@example.com'),100,0,'explore-seed');" > /dev/null 2>&1
INVITE="SEEDEXPL"

wrangler pages dev --binding ADMIN_EMAILS=admin@example.com --port $PORT > "${SCRIPT_TMP}"/cfpicbed-dev-explore.log 2>&1 &
DEV_PID=$!
trap 'kill $DEV_PID 2>/dev/null' EXIT
for i in $(seq 1 40); do curl -sf --max-time 2 "$BASE/healthz" | grep -q '"ok"' && break; sleep 1; done

TS=$(date +%s)
EMAIL="e${TS}@example.com"
echo "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" | base64 -d > "${SCRIPT_TMP}"/expl.png
COOKIE=$(curl -s -D - -o /dev/null --noproxy '*' -X POST -d "email=$EMAIL&password=test1234&invite_code=$INVITE" "$BASE/register" | grep -i '^set-cookie: picbed_session' | head -1 | sed 's/^[Ss]et-[Cc]ookie: picbed_session=\([^;]*\).*/\1/')
check "register ok" "$([ -n "$COOKIE" ] && echo yes || echo no)" "yes"

# 2 public + 1 private
PID1=$(curl -s --max-time 90 -b "picbed_session=$COOKIE" -X POST -F "file=@${SCRIPT_TMP}/expl.png;filename=pub-a.png" -F "visibility=public" --noproxy '*' "$BASE/api/upload" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).id)}catch(e){console.log('')}})")
PID2=$(curl -s --max-time 90 -b "picbed_session=$COOKIE" -X POST -F "file=@${SCRIPT_TMP}/expl.png;filename=pub-b.png" -F "visibility=public" --noproxy '*' "$BASE/api/upload" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).id)}catch(e){console.log('')}})")
PRIV=$(curl -s --max-time 90 -b "picbed_session=$COOKIE" -X POST -F "file=@${SCRIPT_TMP}/expl.png;filename=secret-c.png" --noproxy '*' "$BASE/api/upload" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).id)}catch(e){console.log('')}})")
check "three uploads" "$([ -n "$PID1" ] && [ -n "$PID2" ] && [ -n "$PRIV" ] && echo yes || echo no)" "yes"

# ---- anonymous page ----
check "explore anonymous 200" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "$BASE/explore")" "200"
E=$(curl -s --noproxy '*' "$BASE/explore")
check "explore shows 2 public cells" "$(echo "$E" | grep -o 'class=\"cell\"' | wc -l | tr -d ' ')" "2"
check "explore hides private name" "$(echo "$E" | grep -c 'secret-c.png')" "0"
check "explore shows public name" "$(echo "$E" | grep -c 'pub-a.png')" "3"
check "explore shows total stat" "$(echo "$E" | grep -c '公开图片')" "1"
check "explore has lightbox" "$(echo "$E" | grep -c 'id=\"lightbox\"')" "1"
check "explore login hint for anonymous" "$(echo "$E" | grep -c '登录</a>后可管理')" "1"
check "explore leaks no owner email" "$(echo "$E" | grep -c "$EMAIL")" "0"
# the anonymous nav shows login links only; the logged-in nav carries 发现
check "logged-in nav has explore link" "$(curl -s -b "picbed_session=$COOKIE" --noproxy '*' "$BASE/gallery" | grep -c 'href=\"/explore\"')" "1"

# anonymous can read public image + thumbnail, not the private one
check "public image anonymous 200" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "$BASE/i/$PID1")" "200"
check "public thumb anonymous 200" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "$BASE/t/$PID1")" "200"
check "private image anonymous 403" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "$BASE/i/$PRIV")" "403"

# ---- JSON API ----
PJ=$(curl -s --noproxy '*' "$BASE/api/public/images")
check "public api total" "$(echo "$PJ" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).total)}catch(e){console.log(-1)}})")" "2"
check "public api item shape" "$(echo "$PJ" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const i=JSON.parse(d).items[0];console.log(i.id&&i.url&&i.thumbnail&&i.size_bytes!==undefined?'ok':'bad')}catch(e){console.log('err')}})")" "ok"
check "public api no owner field" "$(echo "$PJ" | grep -c 'user_id\|email')" "0"
check "public api per_page respected" "$(curl -s --noproxy '*' "$BASE/api/public/images?per_page=1" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).items.length)}catch(e){console.log(-1)}})")" "1"

# deleted public image disappears from explore
curl -s -o /dev/null -b "picbed_session=$COOKIE" -X POST --noproxy '*' "$BASE/images/$PID2/delete"
check "explore drops deleted image" "$(curl -s --noproxy '*' "$BASE/explore" | grep -o 'class=\"cell\"' | wc -l | tr -d ' ')" "1"
check "public api drops deleted image" "$(curl -s --noproxy '*' "$BASE/api/public/images" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).total)}catch(e){console.log(-1)}})")" "1"

# ---- admin switch ----
ACOOKIE=$(curl -s -D - -o /dev/null --noproxy '*' -X POST -d "email=seed-admin@example.com&password=x" "$BASE/login" | grep -i '^set-cookie: picbed_session' | head -1 | sed 's/^[Ss]et-[Cc]ookie: picbed_session=\([^;]*\).*/\1/')
# seed admin has an unusable password hash; promote the fresh user instead
wrangler d1 execute cf-picbed-db --local --command "UPDATE users SET role='admin' WHERE email='$EMAIL';" > /dev/null 2>&1
check "explore setting on by default" "$(curl -s -b "picbed_session=$COOKIE" --noproxy '*' "$BASE/api/admin/settings" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).explore_enabled)}catch(e){console.log(-1)}})")" "1"
check "admin page explore toggle" "$(curl -s -b "picbed_session=$COOKIE" --noproxy '*' "$BASE/admin" | grep -c 'name=\"explore_enabled\"')" "1"
check "disable via api 200" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" -X PUT -H 'content-type: application/json' -d '{"explore_enabled":0}' --noproxy '*' "$BASE/api/admin/settings")" "200"
check "disabled: page shows notice" "$(curl -s --noproxy '*' "$BASE/explore" | grep -c '公开画廊未开启')" "1"
check "disabled: api 403" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "$BASE/api/public/images")" "403"
check "disabled: api error code" "$(curl -s --noproxy '*' "$BASE/api/public/images" | grep -c 'explore_disabled')" "1"
check "invalid value 400" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" -X PUT -H 'content-type: application/json' -d '{"explore_enabled":5}' --noproxy '*' "$BASE/api/admin/settings")" "400"
check "re-enable via form 302" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" -X POST -d "explore_enabled=1" --noproxy '*' "$BASE/admin/settings")" "302"
check "enabled again" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "$BASE/api/public/images")" "200"

# ---- docs + meta ----
check "docs lists explore page" "$(curl -s -b "picbed_session=$COOKIE" --noproxy '*' "$BASE/docs" | grep -c '/explore')" "2"
check "docs lists public api" "$(curl -s -b "picbed_session=$COOKIE" --noproxy '*' "$BASE/docs" | grep -c '/api/public/images')" "1"
check "meta lists explore" "$(curl -s --noproxy '*' "$BASE/api/meta" | grep -c '\"explore\":')" "1"

wrangler d1 execute cf-picbed-db --local --command "DELETE FROM images; DELETE FROM rate_limits; DELETE FROM settings;" > /dev/null 2>&1

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ]
