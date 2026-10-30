#!/usr/bin/env bash

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
export SCRIPT_TMP="$SCRIPT_ROOT/tmp"
mkdir -p "$SCRIPT_TMP" || exit 1
# v0.3 auth flow test against local wrangler dev. Self-contained.
set -u
cd "$(dirname "$0")/.."
PORT=8787
BASE="http://127.0.0.1:$PORT"
PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1"; PASS=$((PASS+1)); else echo "FAIL  $1 (got:$2 want:$3)"; FAIL=$((FAIL+1)); fi; }

. ./tests/_schema.sh   # shared idempotent DDL (local D1 persists between suites)

# v1.2: registration is invite-only — clear counters and seed a usable code
wrangler d1 execute cf-picbed-db --local --command "DELETE FROM rate_limits; DELETE FROM invite_codes; INSERT OR IGNORE INTO users (email,password_hash,password_salt,display_name,role) VALUES ('seed-admin@example.com','x','x','SeedAdmin','admin'); INSERT INTO invite_codes (code,created_by,max_uses,used_count,note) VALUES ('SEEDAUTH',(SELECT id FROM users WHERE email='seed-admin@example.com'),100,0,'test-seed');" > /dev/null 2>&1
# v1.18: ensure audit_log exists (idempotent)
wrangler d1 execute cf-picbed-db --local --command "CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, actor_email TEXT, action TEXT NOT NULL, target TEXT, detail TEXT, ip TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))); CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at);" > /dev/null 2>&1
INVITE="SEEDAUTH"
wrangler pages dev --binding ADMIN_EMAILS=admin@example.com --port $PORT > "${SCRIPT_TMP}"/cfpicbed-dev.log 2>&1 &
DEV_PID=$!
trap 'kill $DEV_PID 2>/dev/null' EXIT

for i in $(seq 1 40); do
  curl -sf --max-time 2 "$BASE/healthz" | grep -q '"ok"' && break
  sleep 1
done

TS=$(date +%s)
EMAIL="t${TS}@example.com"

# 1. healthz (version read from source, never hardcoded)
VER=$(grep -o 'const VERSION = "[^"]*"' src/index.js | cut -d'"' -f2)
H=$(curl -s "$BASE/healthz")
check "healthz" "$(echo "$H" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).version))")" "$VER"

# 2. register (expect 302 + session cookie)
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST -d "email=$EMAIL&password=test1234&display_name=Tester&invite_code=$INVITE" "$BASE/register")
check "register status" "$CODE" "302"
COOKIE=$(curl -s -D - -o /dev/null -X POST -d "email=$EMAIL&password=test1234&display_name=Tester&invite_code=$INVITE" "$BASE/register" | grep -i '^set-cookie: picbed_session' | head -1 | sed 's/^[Ss]et-[Cc]ookie: picbed_session=\([^;]*\).*/\1/')
# register twice = second one hits email_taken; cookie from first call
COOKIE=$(curl -s -D - -o /dev/null -X POST -d "email=${EMAIL}b&password=test1234&display_name=Tester2&invite_code=$INVITE" "$BASE/register" | grep -i '^set-cookie: picbed_session' | head -1 | sed 's/^[Ss]et-[Cc]ookie: picbed_session=\([^;]*\).*/\1/')
[ -n "$COOKIE" ] && { echo "PASS  register sets session cookie"; PASS=$((PASS+1)); } || { echo "FAIL  register sets session cookie"; FAIL=$((FAIL+1)); }

# 3. /me with cookie
ME=$(curl -s -b "picbed_session=$COOKIE" "$BASE/me")
check "me email" "$(echo "$ME" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).user.email))")" "${EMAIL}b"
check "me role" "$(echo "$ME" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).user.role))")" "user"

# 4. /me without cookie -> 401
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/me")
check "me no-cookie 401" "$CODE" "401"

# 5. login wrong password -> 401
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST -d "email=$EMAIL&password=wrongpass" "$BASE/login")
check "login wrong pw 401" "$CODE" "401"

# 6. login correct -> 302 + cookie
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST -d "email=$EMAIL&password=test1234" "$BASE/login")
check "login ok 302" "$CODE" "302"

# 7. dashboard with cookie -> 302 to /gallery (followed: 200)
LOC=$(curl -s -o /dev/null -w "%{redirect_url}" -b "picbed_session=$COOKIE" "$BASE/dashboard")
check "dashboard redirects to gallery" "$LOC" "$BASE/gallery"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -L -b "picbed_session=$COOKIE" "$BASE/dashboard")
check "dashboard follow 200" "$CODE" "200"

# 8. dashboard without cookie -> 302
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/dashboard")
check "dashboard no-cookie 302" "$CODE" "302"

# 9. logout clears cookie
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST -b "picbed_session=$COOKIE" "$BASE/logout")
check "logout 302" "$CODE" "302"
ME=$(curl -s -o /dev/null -w "%{http_code}" -b "picbed_session=$COOKIE" "$BASE/me")
check "me after logout 401" "$ME" "401"

# 10. invite gate (v1.2): registration requires a valid, unused code
wrangler d1 execute cf-picbed-db --local --command "DELETE FROM rate_limits; INSERT INTO invite_codes (code,created_by,max_uses,used_count,note) VALUES ('SEED1',(SELECT id FROM users WHERE email='seed-admin@example.com'),1,0,'single-use');" > /dev/null 2>&1
RESP=$(curl -s -w "\n%{http_code}" -X POST -d "email=noinv${TS}@example.com&password=test1234" "$BASE/register")
check "register without invite 400" "$(echo "$RESP" | tail -1)" "400"
echo "$RESP" | grep -q "请输入邀请码" && { echo "PASS  invite required message"; PASS=$((PASS+1)); } || { echo "FAIL  invite required message"; FAIL=$((FAIL+1)); }
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST -d "email=badinv${TS}@example.com&password=test1234&invite_code=ZZZZ-ZZZZ-ZZZZ-ZZZZ" "$BASE/register")
check "register bad invite 400" "$CODE" "400"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST -d "email=single${TS}@example.com&password=test1234&invite_code=SEED1" "$BASE/register")
check "single-use register 302" "$CODE" "302"
UC=$(wrangler d1 execute cf-picbed-db --local --command "SELECT used_count c FROM invite_codes WHERE code='SEED1';" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d)[0].results[0].c)}catch(e){console.log('err')}})")
check "single-use consumed once" "$UC" "1"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST -d "email=single2_${TS}@example.com&password=test1234&invite_code=SEED1" "$BASE/register")
check "single-use reuse 400" "$CODE" "400"
echo "$(curl -s -X POST -d "email=single3_${TS}@example.com&password=test1234&invite_code=SEED1" "$BASE/register")" | grep -q "邀请码使用次数已用完" && { echo "PASS  exhausted message"; PASS=$((PASS+1)); } || { echo "FAIL  exhausted message"; FAIL=$((FAIL+1)); }

# ===== v1.17: session / device management =====
wrangler d1 execute cf-picbed-db --local --command "DELETE FROM rate_limits;" > /dev/null 2>&1
loginc() { curl -s -D - -o /dev/null -A "$1" -X POST -d "email=${EMAIL}b&password=test1234" "$BASE/login" | grep -i '^set-cookie: picbed_session' | head -1 | sed 's/^[Ss]et-[Cc]ookie: picbed_session=\([^;]*\).*/\1/'; }
SB=$(loginc "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36")
SC=$(loginc "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1")
[ -n "$SB" ] && [ -n "$SC" ] && { echo "PASS  two device logins"; PASS=$((PASS+1)); } || { echo "FAIL  two device logins"; FAIL=$((FAIL+1)); }
JSON1=$(curl -s -b "picbed_session=$SC" "$BASE/api/sessions")
check "api sessions current=1" "$(echo "$JSON1" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(j.sessions.filter(s=>s.current).length)}catch(e){console.log('err')}})" )" "1"
check "api sessions total>=2" "$(echo "$JSON1" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(j.total>=2?'yes':'no')}catch(e){console.log('err')}})" )" "yes"
check "api sessions device label" "$(echo "$JSON1" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(j.sessions.some(s=>String(s.device).indexOf('iOS')>=0)?'yes':'no')}catch(e){console.log('err')}})" )" "yes"
# revoke-others keeps only the caller's session
check "revoke-others 302" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$SC" -X POST "$BASE/sessions/revoke-others")" "302"
check "only one session left" "$(curl -s -b "picbed_session=$SC" "$BASE/api/sessions" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).total)}catch(e){console.log('err')}})" )" "1"
check "old session dead" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$SB" "$BASE/gallery")" "302"
# a fresh login = second device again; revoke it by id
SD=$(loginc "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/126.0 Safari/537.36")
OTHER=$(curl -s -b "picbed_session=$SC" "$BASE/api/sessions" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);const o=j.sessions.find(s=>!s.current);console.log(o?o.id:'')}catch(e){console.log('err')}})")
check "api revoke other 200" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$SC" -X DELETE "$BASE/api/sessions/$OTHER")" "200"
check "revoked device dead" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$SD" "$BASE/gallery")" "302"
CURID=$(curl -s -b "picbed_session=$SC" "$BASE/api/sessions" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log((j.sessions.find(s=>s.current)||{}).id)}catch(e){console.log('')}})")
check "cannot revoke current 400" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$SC" -X DELETE "$BASE/api/sessions/$CURID")" "400"
check "sessions page 200" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$SC" "$BASE/sessions")" "200"
check "sessions page current tag" "$(curl -s -b "picbed_session=$SC" "$BASE/sessions" | grep -o '当前设备' | wc -l | tr -d ' ' | awk '{print ($1>=1)?"yes":"no"}')" "yes"
check "sessions page table wrapped" "$(curl -s -b "picbed_session=$SC" "$BASE/sessions" | grep -o '<div class="tablewrap"><table' | wc -l | tr -d ' ')" "1"
check "sessions nav link" "$(curl -s -b "picbed_session=$SC" "$BASE/gallery" | grep -o '<a href="/sessions">设备</a>' | wc -l | tr -d ' ')" "1"
check "sessions unauth 302" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/sessions")" "302"
check "api sessions unauth 401" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/sessions")" "401"

# 11. rate limit: 6 registrations from same IP, 6th must be blocked (limit 5/h)
wrangler d1 execute cf-picbed-db --local --command "DELETE FROM rate_limits;" > /dev/null 2>&1
EMAIL2="rl${TS}@example.com"
LAST=""
for i in 1 2 3 4 5 6; do
  LAST=$(curl -s -o /dev/null -w "%{http_code}" -X POST -d "email=rl${TS}_$i@example.com&password=test1234&invite_code=$INVITE" "$BASE/register")
done
check "rate limit 6th register" "$LAST" "400"

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ]
