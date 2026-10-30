#!/usr/bin/env bash

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
export SCRIPT_TMP="$SCRIPT_ROOT/tmp"
mkdir -p "$SCRIPT_TMP" || exit 1
# v0.9 polish test: docs, settings, error pages, CSRF. Self-contained.
set -u
cd "$(dirname "$0")/.."
PORT=8787
BASE="http://127.0.0.1:$PORT"
PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1"; PASS=$((PASS+1)); else echo "FAIL  $1 (got:$2 want:$3)"; FAIL=$((FAIL+1)); fi; }

. ./tests/_schema.sh   # shared idempotent DDL (local D1 persists between suites)
wrangler d1 execute cf-picbed-db --local --command "DELETE FROM rate_limits; DELETE FROM sessions; DELETE FROM images; DELETE FROM api_keys; DELETE FROM share_links; DELETE FROM users WHERE email LIKE '%example.com' OR email='admin@example.com';" > /dev/null 2>&1
# v1.12: ensure images.exif exists (idempotent; harmless failure if already present)
wrangler d1 execute cf-picbed-db --local --command "ALTER TABLE images ADD COLUMN exif TEXT;" > /dev/null 2>&1
# v1.13: ensure share_links exists (idempotent)
wrangler d1 execute cf-picbed-db --local --command "CREATE TABLE IF NOT EXISTS share_links (id INTEGER PRIMARY KEY AUTOINCREMENT, image_id INTEGER NOT NULL REFERENCES images (id) ON DELETE CASCADE, token TEXT NOT NULL UNIQUE, created_by INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE, expires_at TEXT, views INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now'))); CREATE INDEX IF NOT EXISTS idx_shares_token ON share_links (token); CREATE INDEX IF NOT EXISTS idx_shares_image ON share_links (image_id);" > /dev/null 2>&1
# v1.18: ensure audit_log exists (idempotent)
wrangler d1 execute cf-picbed-db --local --command "CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, actor_email TEXT, action TEXT NOT NULL, target TEXT, detail TEXT, ip TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))); CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at);" > /dev/null 2>&1

# v1.2: registration is invite-only — seed a usable code directly in D1
wrangler d1 execute cf-picbed-db --local --command "DELETE FROM invite_codes; INSERT OR IGNORE INTO users (email,password_hash,password_salt,display_name,role) VALUES ('seed-admin@example.com','x','x','SeedAdmin','admin'); INSERT INTO invite_codes (code,created_by,max_uses,used_count,note) VALUES ('SEEDPOL',(SELECT id FROM users WHERE email='seed-admin@example.com'),100,0,'test-seed');" > /dev/null 2>&1
INVITE="SEEDPOL"

wrangler pages dev --binding ADMIN_EMAILS=admin@example.com --port $PORT > "${SCRIPT_TMP}"/cfpicbed-dev.log 2>&1 &
DEV_PID=$!
trap 'kill $DEV_PID 2>/dev/null' EXIT
for i in $(seq 1 40); do curl -sf --max-time 2 "$BASE/healthz" | grep -q '"ok"' && break; sleep 1; done

TS=$(date +%s)
EMAIL="s${TS}@example.com"
COOKIE=$(curl -s -D - -o /dev/null -X POST -d "email=$EMAIL&password=test1234&display_name=OldName&invite_code=$INVITE" "$BASE/register" | grep -i '^set-cookie: picbed_session' | head -1 | sed 's/^[Ss]et-[Cc]ookie: picbed_session=\([^;]*\).*/\1/')
[ -n "$COOKIE" ] && { echo "PASS  register+cookie"; PASS=$((PASS+1)); } || { echo "FAIL  register+cookie"; FAIL=$((FAIL+1)); }

# docs page
check "docs 200" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" "$BASE/docs")" "200"
D=$(curl -s -b "picbed_session=$COOKIE" "$BASE/docs")
check "docs has upload endpoint" "$(echo "$D" | grep -c '/api/upload')" "2"
check "docs has error table" "$(echo "$D" | grep -c 'quota_exceeded')" "1"
check "docs CSP header" "$(curl -s -D - -o /dev/null -b "picbed_session=$COOKIE" "$BASE/docs" | grep -ci 'content-security-policy')" "1"

# upload UX (v1.3): visibility picker + real upload progress on both surfaces
U=$(curl -s -b "picbed_session=$COOKIE" "$BASE/upload")
check "upload page visibility radios" "$(echo "$U" | grep -c 'name="vis"')" "2"
check "upload page public option" "$(echo "$U" | grep -c 'value="public"')" "1"
check "upload page xhr progress" "$(echo "$U" | grep -c 'xhr.upload.onprogress')" "1"
G=$(curl -s -b "picbed_session=$COOKIE" "$BASE/gallery")
check "gallery visibility radios" "$(echo "$G" | grep -o 'type="radio" name="vis"' | wc -l | tr -d ' ')" "2"
check "gallery progress container" "$(echo "$G" | grep -c 'id="prog"')" "1"
check "gallery xhr progress" "$(echo "$G" | grep -c 'xhr.upload.onprogress')" "1"

# v1.6: quota awareness (upload bar, settings card, gallery remaining)
U=$(curl -s -b "picbed_session=$COOKIE" "$BASE/upload")
check "upload page quota bar" "$(echo "$U" | grep -c 'class="qbar"')" "1"
check "upload page quota constants" "$(echo "$U" | grep -c 'Q_USED = 0, Q_TOTAL = 1073741824')" "1"
S=$(curl -s -b "picbed_session=$COOKIE" "$BASE/settings")
check "settings quota card" "$(echo "$S" | grep -c '存储配额')" "1"
check "settings quota usage pct" "$(echo "$S" | grep -c '使用率 0.0%')" "1"
G2=$(curl -s -b "picbed_session=$COOKIE" "$BASE/gallery")
check "gallery remaining stat" "$(echo "$G2" | grep -c '剩余空间')" "1"
check "gallery quota projection" "$(echo "$G2" | grep -c 'Q_USED = 0, Q_TOTAL = 1073741824')" "1"
check "gallery remain hint" "$(echo "$G2" | grep -o '剩余配额 ' | wc -l | tr -d ' ')" "1"

# v1.8: paste-to-upload on both surfaces
check "upload page paste handler" "$(echo "$U" | grep -o "addEventListener('paste'" | wc -l | tr -d ' ')" "1"
check "upload page paste hint" "$(echo "$U" | grep -o 'Ctrl+V' | wc -l | tr -d ' ')" "1"
check "gallery paste handler" "$(echo "$G" | grep -o "addEventListener('paste'" | wc -l | tr -d ' ')" "1"
check "gallery paste hint" "$(echo "$G" | grep -o 'Ctrl+V' | wc -l | tr -d ' ')" "1"

# v1.9: URL remote upload on both surfaces
check "upload page url input" "$(echo "$U" | grep -c 'id="urlin"')" "1"
check "upload page url button" "$(echo "$U" | grep -o '从 URL 上传' | wc -l | tr -d ' ')" "1"
check "upload page urlUpload fn" "$(echo "$U" | grep -o 'function urlUpload' | wc -l | tr -d ' ')" "1"
check "gallery url input" "$(echo "$G" | grep -c 'id="urlin"')" "1"
check "gallery url button" "$(echo "$G" | grep -o '从 URL 上传' | wc -l | tr -d ' ')" "1"

# settings page
check "settings 200" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" "$BASE/settings")" "200"
check "settings no-auth 302" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/settings")" "302"

# profile update
CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "picbed_session=$COOKIE" -X POST -d "display_name=NewName" "$BASE/settings/profile")
check "profile update 302" "$CODE" "302"
DN=$(wrangler d1 execute cf-picbed-db --local --command "SELECT display_name FROM users WHERE email='$EMAIL';" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d)[0].results[0].display_name)}catch(e){console.log('err')}})")
check "display_name updated" "$DN" "NewName"

# password change: wrong old -> 400, correct -> 302, login with new works
check "wrong old pw 400" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" -X POST -d "old_password=wrongpass1&new_password=newpass1234" "$BASE/settings/password")" "400"
check "short new pw 400" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" -X POST -d "old_password=test1234&new_password=short" "$BASE/settings/password")" "400"
check "pw change 302" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" -X POST -d "old_password=test1234&new_password=newpass1234" "$BASE/settings/password")" "302"
check "login with new pw 302" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -d "email=$EMAIL&password=newpass1234" "$BASE/login")" "302"
check "old pw now rejected" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -d "email=$EMAIL&password=test1234" "$BASE/login")" "401"

# 404 styled page
check "unknown page 404" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/no-such-page")" "404"
N=$(curl -s "$BASE/no-such-page")
check "404 page styled" "$(echo "$N" | grep -c '页面不存在')" "1"
check "api 404 json" "$(curl -s "$BASE/api/no-such" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).error)}catch(e){console.log('err')}})" )" "not_found"

# v1.14: dark mode — theme vars + no-flash script + toggle on every surface
L=$(curl -s "$BASE/login")
check "login dark var block" "$(echo "$L" | grep -o 'html\[data-theme="dark"\]' | wc -l | tr -d ' ')" "1"
check "login theme early script" "$(echo "$L" | grep -o "localStorage.getItem('picbed_theme')" | wc -l | tr -d ' ')" "1"
check "login theme btn" "$(echo "$L" | grep -o 'id="themebtn"' | wc -l | tr -d ' ')" "1"
check "login toggle fn" "$(echo "$L" | grep -o 'function toggleTheme' | wc -l | tr -d ' ')" "1"
check "login light vars intact" "$(echo "$L" | grep -o '\-\-bg:#f6f7f9' | wc -l | tr -d ' ')" "1"
G3=$(curl -s -b "picbed_session=$COOKIE" "$BASE/gallery")
check "gallery dark var block" "$(echo "$G3" | grep -o 'html\[data-theme="dark"\]' | wc -l | tr -d ' ' | awk '{print ($1>=1)?"yes":"no"}')" "yes"
check "gallery theme btn in nav" "$(echo "$G3" | grep -o 'id="themebtn"' | wc -l | tr -d ' ')" "1"
check "gallery toggle fn" "$(echo "$G3" | grep -o 'function toggleTheme' | wc -l | tr -d ' ')" "1"
check "gallery dark input adapter" "$(echo "$G3" | grep -o 'html\[data-theme="dark"\] input' | wc -l | tr -d ' ')" "1"
check "gallery light vars intact" "$(echo "$G3" | grep -o '\-\-bg:#f6f7f9' | wc -l | tr -d ' ')" "1"
check "gallery toast themed" "$(echo "$G3" | grep -o 'var(--toast-bg)' | wc -l | tr -d ' ')" "1"
S3=$(curl -s -b "picbed_session=$COOKIE" "$BASE/settings")
check "settings card class" "$(echo "$S3" | grep -o '<div class="card">' | wc -l | tr -d ' ')" "3"
check "settings no inline card style" "$(echo "$S3" | grep -c 'background:#fff;border:1px solid')" "0"

# v1.15: mobile responsiveness — breakpoint, table wrappers, fluid auth card
check "login fluid card" "$(echo "$L" | grep -o 'width:min(320px,90vw)' | wc -l | tr -d ' ')" "1"
check "gallery media query" "$(echo "$G3" | grep -o '@media (max-width:640px)' | wc -l | tr -d ' ')" "1"
check "gallery tablewrap css" "$(echo "$G3" | grep -o '.tablewrap{overflow-x:auto' | wc -l | tr -d ' ')" "1"
check "gallery mobile grid" "$(echo "$G3" | grep -o 'minmax(140px,1fr)' | wc -l | tr -d ' ')" "1"

# CSRF: cross-origin logout blocked, no-origin allowed
# v1.21: the dispatch-level CSRF guard now answers 403 cross_origin before the
# route's own sameOrigin() check (which used to return 400).
check "csrf logout blocked" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Origin: http://evil.example.com" -b "picbed_session=$COOKIE" "$BASE/logout")" "403"
check "logout ok 302" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -b "picbed_session=$COOKIE" "$BASE/logout")" "302"

# home redirects to login when anonymous
check "home 302" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")" "302"

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ]
