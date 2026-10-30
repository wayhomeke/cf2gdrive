#!/usr/bin/env bash

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
export SCRIPT_TMP="$SCRIPT_ROOT/tmp"
mkdir -p "$SCRIPT_TMP" || exit 1
# v0.8 trash / restore / purge / batch / admin test. Self-contained.
set -u

# Explicit credentials are required before any remote Drive operations.
: "${GOOGLE_CLIENT_ID:?Set GOOGLE_CLIENT_ID}"
: "${GOOGLE_CLIENT_SECRET:?Set GOOGLE_CLIENT_SECRET}"
: "${GOOGLE_REFRESH_TOKEN:?Set GOOGLE_REFRESH_TOKEN}"
export GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_REFRESH_TOKEN
cd "$(dirname "$0")/.."
PORT=8787
BASE="http://127.0.0.1:$PORT"
PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1"; PASS=$((PASS+1)); else echo "FAIL  $1 (got:$2 want:$3)"; FAIL=$((FAIL+1)); fi; }

. ./tests/_schema.sh   # shared idempotent DDL (local D1 persists between suites)
wrangler d1 execute cf-picbed-db --local --file=schema.sql > /dev/null 2>&1
wrangler d1 execute cf-picbed-db --local --command "DELETE FROM rate_limits; DELETE FROM sessions; DELETE FROM images; DELETE FROM api_keys; DELETE FROM users WHERE email LIKE '%example.com' OR email='admin@example.com';" > /dev/null 2>&1
# v1.12: ensure images.exif exists (idempotent; harmless failure if already present)
wrangler d1 execute cf-picbed-db --local --command "ALTER TABLE images ADD COLUMN exif TEXT;" > /dev/null 2>&1
# v1.13: ensure share_links exists (idempotent)
wrangler d1 execute cf-picbed-db --local --command "CREATE TABLE IF NOT EXISTS share_links (id INTEGER PRIMARY KEY AUTOINCREMENT, image_id INTEGER NOT NULL REFERENCES images (id) ON DELETE CASCADE, token TEXT NOT NULL UNIQUE, created_by INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE, expires_at TEXT, views INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now'))); CREATE INDEX IF NOT EXISTS idx_shares_token ON share_links (token); CREATE INDEX IF NOT EXISTS idx_shares_image ON share_links (image_id);" > /dev/null 2>&1
# v1.18: ensure audit_log exists (idempotent)
wrangler d1 execute cf-picbed-db --local --command "CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, actor_email TEXT, action TEXT NOT NULL, target TEXT, detail TEXT, ip TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))); CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at);" > /dev/null 2>&1

# v1.2: registration is invite-only — seed a usable code directly in D1
wrangler d1 execute cf-picbed-db --local --command "DELETE FROM invite_codes; INSERT OR IGNORE INTO users (email,password_hash,password_salt,display_name,role) VALUES ('seed-admin@example.com','x','x','SeedAdmin','admin'); INSERT INTO invite_codes (code,created_by,max_uses,used_count,note) VALUES ('SEEDMAN',(SELECT id FROM users WHERE email='seed-admin@example.com'),100,0,'test-seed');" > /dev/null 2>&1
# v1.4: seed the global default quota BEFORE dev starts so the first read sees it
wrangler d1 execute cf-picbed-db --local --command "DELETE FROM settings; INSERT INTO settings (key,value) VALUES ('default_quota_bytes','2147483648');" > /dev/null 2>&1
INVITE="SEEDMAN"

wrangler pages dev --binding ADMIN_EMAILS=admin@example.com --port $PORT > "${SCRIPT_TMP}"/cfpicbed-dev.log 2>&1 &
DEV_PID=$!
trap 'kill $DEV_PID 2>/dev/null' EXIT
for i in $(seq 1 40); do curl -sf --max-time 2 "$BASE/healthz" | grep -q '"ok"' && break; sleep 1; done

TS=$(date +%s)
EMAIL="m${TS}@example.com"
echo "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" | base64 -d > "${SCRIPT_TMP}"/test.png

COOKIE=$(curl -s -D - -o /dev/null -X POST -d "email=$EMAIL&password=test1234&invite_code=$INVITE" "$BASE/register" | grep -i '^set-cookie: picbed_session' | head -1 | sed 's/^[Ss]et-[Cc]ookie: picbed_session=\([^;]*\).*/\1/')
[ -n "$COOKIE" ] && { echo "PASS  register+cookie"; PASS=$((PASS+1)); } || { echo "FAIL  register+cookie"; FAIL=$((FAIL+1)); }

upload() { curl -s -b "picbed_session=$COOKIE" -X POST -F "file=@${SCRIPT_TMP}/test.png;filename=$1.png" "$BASE/api/upload" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).id)}catch(e){console.log('')}})"; }

ID1=$(upload "m1"); ID2=$(upload "m2")
check "2 uploads" "$([ -n "$ID1" ] && [ -n "$ID2" ] && echo ok)" "ok"

# delete both -> trash
curl -s -o /dev/null -X POST -b "picbed_session=$COOKIE" "$BASE/images/$ID1/delete"
curl -s -o /dev/null -X POST -b "picbed_session=$COOKIE" "$BASE/images/$ID2/delete"
T=$(curl -s -b "picbed_session=$COOKIE" "$BASE/trash")
check "trash page 2 cells" "$(echo "$T" | grep -o 'class="cell"' | wc -l | tr -d ' ')" "2"

# restore ID1
check "restore 200" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -b "picbed_session=$COOKIE" "$BASE/images/$ID1/restore")" "200"
USED=$(wrangler d1 execute cf-picbed-db --local --command "SELECT used_bytes FROM users WHERE email='$EMAIL';" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d)[0].results[0].used_bytes)}catch(e){console.log('err')}})")
check "quota restored to 70" "$USED" "70"
check "restore again 400" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -b "picbed_session=$COOKIE" "$BASE/images/$ID1/restore")" "400"

# purge ID2 (permanent)
DRIVE2=$(wrangler d1 execute cf-picbed-db --local --command "SELECT drive_file_id FROM images WHERE public_id='$ID2';" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d)[0].results[0].drive_file_id)}catch(e){console.log('')}})")
check "purge 200" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -b "picbed_session=$COOKIE" "$BASE/images/$ID2/purge")" "200"
GONE=$(wrangler d1 execute cf-picbed-db --local --command "SELECT COUNT(*) c FROM images WHERE public_id='$ID2';" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d)[0].results[0].c)}catch(e){console.log('err')}})")
check "purged row gone" "$GONE" "0"
DRIVEGONE=$(NODE_USE_ENV_PROXY=1 node --input-type=module -e "
  const m = await import('./src/drive.js');

  const env = process.env;
  try { await m.getFileMeta(env, '$DRIVE2'); console.log('exists'); } catch { console.log('gone'); }
" 2>/dev/null)
check "purged drive file gone" "$DRIVEGONE" "gone"

# batch delete: upload 3, batch-delete 2
ID3=$(upload "m3"); ID4=$(upload "m4"); ID5=$(upload "m5")
BATCH=$(curl -s -b "picbed_session=$COOKIE" -X POST -H "content-type: application/json" -d "{\"ids\":[\"$ID3\",\"$ID4\"]}" "$BASE/api/images/batch-delete")
check "batch deleted 2" "$(echo "$BATCH" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).deleted)}catch(e){console.log('err')}})" )" "2"

# purge-all
PA=$(curl -s -X POST -b "picbed_session=$COOKIE" "$BASE/images/purge-all")
check "purge-all count" "$(echo "$PA" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).purged)}catch(e){console.log('err')}})" )" "2"
LEFT=$(wrangler d1 execute cf-picbed-db --local --command "SELECT COUNT(*) c FROM images WHERE deleted=1;" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d)[0].results[0].c)}catch(e){console.log('err')}})")
check "trash empty after purge-all" "$LEFT" "0"

# API trash endpoints
ID6=$(upload "m6")
curl -s -o /dev/null -X DELETE -b "picbed_session=$COOKIE" "$BASE/api/images/$ID6"
check "api trash list" "$(curl -s -b "picbed_session=$COOKIE" "$BASE/api/trash" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).images.length)}catch(e){console.log('err')}})" )" "1"
check "api restore" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -b "picbed_session=$COOKIE" "$BASE/api/images/$ID6/restore")" "200"
curl -s -o /dev/null -X DELETE -b "picbed_session=$COOKIE" "$BASE/api/images/$ID6"
check "api purge" "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -b "picbed_session=$COOKIE" "$BASE/api/images/$ID6/purge")" "200"

# admin: normal user 403, admin user 200
check "non-admin 403" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" "$BASE/admin")" "403"
curl -s -o /dev/null -X POST -d "email=admin@example.com&password=adminpass1234&invite_code=$INVITE" "$BASE/register"
ADMIN_COOKIE=$(curl -s -D - -o /dev/null -X POST -d "email=admin@example.com&password=adminpass1234" "$BASE/login" | grep -i '^set-cookie: picbed_session' | head -1 | sed 's/^[Ss]et-[Cc]ookie: picbed_session=\([^;]*\).*/\1/')
check "admin login" "$([ -n "$ADMIN_COOKIE" ] && echo ok)" "ok"
check "admin page 200" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$ADMIN_COOKIE" "$BASE/admin")" "200"
A=$(curl -s -b "picbed_session=$ADMIN_COOKIE" "$BASE/admin")
check "admin lists users" "$(echo "$A" | grep -c 'admin@example.com')" "2"

# v1.2: admin invite management (UI + API)
check "admin api invites non-admin 403" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" "$BASE/api/admin/invites")" "403"
NEWCODE=$(curl -s -b "picbed_session=$ADMIN_COOKIE" -X POST -H "content-type: application/json" -d '{"note":"manage-test","max_uses":2,"expires_in_days":7}' "$BASE/api/admin/invites" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).code)}catch(e){console.log('')}})")
[ -n "$NEWCODE" ] && { echo "PASS  admin create invite via api"; PASS=$((PASS+1)); } || { echo "FAIL  admin create invite via api"; FAIL=$((FAIL+1)); }
check "admin create invite 201" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$ADMIN_COOKIE" -X POST -H 'content-type: application/json' -d '{"note":"x"}' "$BASE/api/admin/invites")" "201"
NEWID=$(curl -s -b "picbed_session=$ADMIN_COOKIE" "$BASE/api/admin/invites" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(j.invites.find(i=>i.code==='$NEWCODE').id)}catch(e){console.log('')}})")
[ -n "$NEWID" ] && { echo "PASS  admin invite list contains new code"; PASS=$((PASS+1)); } || { echo "FAIL  admin invite list contains new code"; FAIL=$((FAIL+1)); }
# end-to-end: register a user with the admin-created code
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST -d "email=invited${TS}@example.com&password=test1234&invite_code=$NEWCODE" "$BASE/register")
check "register with admin-created code" "$CODE" "302"
check "admin invite used_count" "$(curl -s -b "picbed_session=$ADMIN_COOKIE" "$BASE/api/admin/invites" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(j.invites.find(i=>i.code==='$NEWCODE').used_count)}catch(e){console.log('err')}})")" "1"
check "admin revoke invite" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$ADMIN_COOKIE" -X DELETE "$BASE/api/admin/invites/$NEWID")" "200"
check "revoked code rejected" "$(curl -s -X POST -d "email=revoked${TS}@example.com&password=test1234&invite_code=$NEWCODE" "$BASE/register" | grep -c '邀请码无效或已被吊销')" "1"
check "admin revoke unknown 404" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$ADMIN_COOKIE" -X DELETE "$BASE/api/admin/invites/999999")" "404"
# UI: create via form redirects with ?invite=
LOC=$(curl -s -o /dev/null -w '%{redirect_url}' -b "picbed_session=$ADMIN_COOKIE" -X POST -d "note=ui-test&max_uses=1" "$BASE/admin/invites")
echo "$LOC" | grep -q 'invite=' && { echo "PASS  admin ui create redirects with code"; PASS=$((PASS+1)); } || { echo "FAIL  admin ui create redirects with code"; FAIL=$((FAIL+1)); }
check "admin page shows invite section" "$(curl -s -b "picbed_session=$ADMIN_COOKIE" "$BASE/admin" | grep -c '邀请码（注册唯一入口')" "1"

# v1.4: global default quota + per-user quota management
wrangler d1 execute cf-picbed-db --local --command "DELETE FROM rate_limits;" > /dev/null 2>&1
qval() { wrangler d1 execute cf-picbed-db --local --command "SELECT quota_bytes q FROM users WHERE email='$1';" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d)[0].results[0].q)}catch(e){console.log('err')}})"; }
uidof() { wrangler d1 execute cf-picbed-db --local --command "SELECT id FROM users WHERE email='$1';" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d)[0].results[0].id)}catch(e){console.log('')}})"; }
QCODE=$(curl -s -b "picbed_session=$ADMIN_COOKIE" -X POST -H "content-type: application/json" -d '{"note":"quota-test","max_uses":5}' "$BASE/api/admin/invites" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).code)}catch(e){console.log('')}})")
QEMAIL="q${TS}@example.com"
curl -s -o /dev/null -X POST -d "email=$QEMAIL&password=test1234&invite_code=$QCODE" "$BASE/register"
check "new user gets seeded default quota 2G" "$(qval "$QEMAIL")" "2147483648"
QID=$(uidof "$QEMAIL")

check "admin settings api non-admin 403" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" "$BASE/api/admin/settings")" "403"
check "admin settings api 200" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$ADMIN_COOKIE" "$BASE/api/admin/settings")" "200"
check "admin settings api value" "$(curl -s -b "picbed_session=$ADMIN_COOKIE" "$BASE/api/admin/settings" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).default_quota_bytes)}catch(e){console.log('err')}})")" "2147483648"
check "admin put settings non-admin 403" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" -X PUT -H 'content-type: application/json' -d '{"default_quota":"9G"}' "$BASE/api/admin/settings")" "403"
check "admin put settings 200" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$ADMIN_COOKIE" -X PUT -H 'content-type: application/json' -d '{"default_quota":"4G"}' "$BASE/api/admin/settings")" "200"
check "admin put settings bad value 400" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$ADMIN_COOKIE" -X PUT -H 'content-type: application/json' -d '{"default_quota":"abc"}' "$BASE/api/admin/settings")" "400"
QCODE2=$(curl -s -b "picbed_session=$ADMIN_COOKIE" -X POST -H "content-type: application/json" -d '{"note":"quota-test2","max_uses":5}' "$BASE/api/admin/invites" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).code)}catch(e){console.log('')}})")
curl -s -o /dev/null -X POST -d "email=q2${TS}@example.com&password=test1234&invite_code=$QCODE2" "$BASE/register"
check "new user gets updated default 4G" "$(qval "q2${TS}@example.com")" "4294967296"

check "patch user quota non-admin 403" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" -X PATCH -H 'content-type: application/json' -d '{"quota":"9G"}' "$BASE/api/admin/users/$QID/quota")" "403"
check "patch user quota bad value 400" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$ADMIN_COOKIE" -X PATCH -H 'content-type: application/json' -d '{"quota":"xyz"}' "$BASE/api/admin/users/$QID/quota")" "400"
check "patch user quota 200" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$ADMIN_COOKIE" -X PATCH -H 'content-type: application/json' -d '{"quota":"9G"}' "$BASE/api/admin/users/$QID/quota")" "200"
check "user quota updated to 9G" "$(qval "$QEMAIL")" "9663676416"

# give the main test user some used_bytes, then try to shrink below it
IDQ=$(upload "quota"); IDQ2=$(upload "quota2")
check "ui quota form 302" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$ADMIN_COOKIE" -X POST -d "quota=8G" "$BASE/admin/users/$(uidof "$EMAIL")/quota")" "302"
check "ui quota applied 8G" "$(qval "$EMAIL")" "8589934592"
check "ui quota below used rejected" "$(curl -s -o /dev/null -w '%{redirect_url}' -b "picbed_session=$ADMIN_COOKIE" -X POST -d "quota=100B" "$BASE/admin/users/$(uidof "$EMAIL")/quota" | grep -c 'err=quota_below_used')" "1"
check "api quota below used 400" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$ADMIN_COOKIE" -X PATCH -H 'content-type: application/json' -d '{"quota":"100B"}' "$BASE/api/admin/users/$(uidof "$EMAIL")/quota")" "400"
check "ui settings bad value err page" "$(curl -s -b "picbed_session=$ADMIN_COOKIE" -X POST -d "default_quota=abc" "$BASE/admin/settings" > /dev/null; curl -s -b "picbed_session=$ADMIN_COOKIE" "$BASE/admin?err=bad_quota" | grep -c '配额格式不正确')" "1"
check "admin page shows default quota section" "$(curl -s -b "picbed_session=$ADMIN_COOKIE" "$BASE/admin" | grep -c '新用户默认配额')" "1"
check "admin page shows per-user quota form" "$([ $(curl -s -b "picbed_session=$ADMIN_COOKIE" "$BASE/admin" | grep -c '设配额') -ge 1 ] && echo ok)" "ok"
# form POST 5G -> notice + new registrations get 5G
curl -s -o /dev/null -X POST -b "picbed_session=$ADMIN_COOKIE" -d "default_quota=5G" "$BASE/admin/settings"
check "settings saved notice" "$(curl -s -b "picbed_session=$ADMIN_COOKIE" "$BASE/admin?msg=settings_saved" | grep -c '设置已保存')" "1"
check "admin page shows 5.00 GiB default" "$(curl -s -b "picbed_session=$ADMIN_COOKIE" "$BASE/admin" | grep -c '5.00 GiB')" "1"
QCODE3=$(curl -s -b "picbed_session=$ADMIN_COOKIE" -X POST -H "content-type: application/json" -d '{"note":"quota-test3","max_uses":5}' "$BASE/api/admin/invites" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).code)}catch(e){console.log('')}})")
curl -s -o /dev/null -X POST -d "email=q3${TS}@example.com&password=test1234&invite_code=$QCODE3" "$BASE/register"
check "new user gets form-set default 5G" "$(qval "q3${TS}@example.com")" "5368709120"
# docs page lists new endpoints
check "docs list settings endpoints" "$(curl -s -b "picbed_session=$ADMIN_COOKIE" "$BASE/docs" | grep -o '/api/admin/settings' | wc -l | tr -d ' ')" "2"
# v1.15: tables wrapped for mobile horizontal scroll (admin users/invites + docs x2)
check "admin tables wrapped" "$(curl -s -b "picbed_session=$ADMIN_COOKIE" "$BASE/admin" | grep -o '<div class="tablewrap"><table' | wc -l | tr -d ' ')" "2"
check "docs tables wrapped" "$(curl -s -b "picbed_session=$ADMIN_COOKIE" "$BASE/docs" | grep -o '<div class="tablewrap"><table' | wc -l | tr -d ' ')" "2"

# ===== v1.16: user management (search / disable / enable / delete / guards) =====
VEMAIL="victim${TS}@example.com"
VCOOKIE=$(curl -s -D - -o /dev/null -X POST -d "email=$VEMAIL&password=test1234&invite_code=$INVITE" "$BASE/register" | grep -i '^set-cookie: picbed_session' | head -1 | sed 's/^[Ss]et-[Cc]ookie: picbed_session=\([^;]*\).*/\1/')
[ -n "$VCOOKIE" ] && { echo "PASS  victim registered"; PASS=$((PASS+1)); } || { echo "FAIL  victim registered"; FAIL=$((FAIL+1)); }
VID=$(curl -s -b "picbed_session=$VCOOKIE" -X POST -F "file=@${SCRIPT_TMP}/test.png;filename=v.png" "$BASE/api/upload" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).id)}catch(e){console.log('')}})")
VNUM=$(wrangler d1 execute cf-picbed-db --local --command "SELECT id FROM users WHERE email='$VEMAIL';" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d)[0].results[0].id)}catch(e){console.log('')}})")
MYNUM=$(wrangler d1 execute cf-picbed-db --local --command "SELECT id FROM users WHERE email='admin@example.com';" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d)[0].results[0].id)}catch(e){console.log('')}})")
A2=$(curl -s -b "picbed_session=$ADMIN_COOKIE" "$BASE/admin")
check "admin search box present" "$(echo "$A2" | grep -o 'name="q"' | wc -l | tr -d ' ')" "1"
check "admin status filter select" "$(echo "$A2" | grep -o '<select name="status"' | wc -l | tr -d ' ')" "1"
check "admin action col" "$(echo "$A2" | grep -o '<th>操作</th>' | wc -l | tr -d ' ')" "1"
check "admin disable btn present" "$(echo "$A2" | grep -o '>禁用</button>' | wc -l | tr -d ' ' | awk '{print ($1>=1)?"yes":"no"}')" "yes"
check "admin delete btn present" "$(echo "$A2" | grep -o '>删除</button>' | wc -l | tr -d ' ' | awk '{print ($1>=1)?"yes":"no"}')" "yes"
check "admin search hit" "$(curl -s -b "picbed_session=$ADMIN_COOKIE" "$BASE/admin?q=victim${TS}" | grep -o '共 1 个用户（已筛选）' | wc -l | tr -d ' ')" "1"
check "admin search miss" "$(curl -s -b "picbed_session=$ADMIN_COOKIE" "$BASE/admin?q=zzznomatch" | grep -o '共 0 个用户（已筛选）' | wc -l | tr -d ' ')" "1"
check "admin search escapes like" "$(curl -s -b "picbed_session=$ADMIN_COOKIE" "$BASE/admin?q=%25" | grep -o '共 0 个用户（已筛选）' | wc -l | tr -d ' ')" "1"
# disable: session dies at once, login rejected
check "disable user 302" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$ADMIN_COOKIE" -X POST -d "status=disabled" "$BASE/admin/users/$VNUM/status")" "302"
check "disabled session dead" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$VCOOKIE" "$BASE/gallery")" "302"
check "disabled login 401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -d "email=$VEMAIL&password=test1234" "$BASE/login")" "401"
check "disabled filter lists it" "$(curl -s -b "picbed_session=$ADMIN_COOKIE" "$BASE/admin?status=disabled" | grep -c "$VEMAIL")" "2"
check "disabled tag shown" "$(curl -s -b "picbed_session=$ADMIN_COOKIE" "$BASE/admin?status=disabled" | grep -o '已禁用' | wc -l | tr -d ' ' | awk '{print ($1>=2)?"yes":"no"}')" "yes"
# re-enable: login works again
check "enable user 302" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$ADMIN_COOKIE" -X POST -d "status=active" "$BASE/admin/users/$VNUM/status")" "302"
check "re-enabled login 302" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -d "email=$VEMAIL&password=test1234" "$BASE/login")" "302"
# guards: self disable / self delete
check "self disable blocked" "$(curl -s -o /dev/null -w '%{redirect_url}' -b "picbed_session=$ADMIN_COOKIE" -X POST -d "status=disabled" "$BASE/admin/users/$MYNUM/status" | grep -c 'err=self_lock')" "1"
check "self delete blocked" "$(curl -s -o /dev/null -w '%{redirect_url}' -b "picbed_session=$ADMIN_COOKIE" -X POST "$BASE/admin/users/$MYNUM/delete" | grep -c 'err=self_lock')" "1"
check "status unknown user" "$(curl -s -o /dev/null -w '%{redirect_url}' -b "picbed_session=$ADMIN_COOKIE" -X POST -d "status=disabled" "$BASE/admin/users/999999/status" | grep -c 'err=no_user')" "1"
check "status non-admin 403" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" -X POST -d "status=disabled" "$BASE/admin/users/$VNUM/status")" "403"
# delete: cascades images/sessions/keys/shares
check "delete user 302" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$ADMIN_COOKIE" -X POST "$BASE/admin/users/$VNUM/delete")" "302"
check "user row gone" "$(wrangler d1 execute cf-picbed-db --local --command "SELECT COUNT(*) c FROM users WHERE id=$VNUM;" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d)[0].results[0].c)}catch(e){console.log('err')}})" )" "0"
check "user images gone" "$(wrangler d1 execute cf-picbed-db --local --command "SELECT COUNT(*) c FROM images WHERE public_id='$VID';" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d)[0].results[0].c)}catch(e){console.log('err')}})" )" "0"
check "user sessions gone" "$(wrangler d1 execute cf-picbed-db --local --command "SELECT COUNT(*) c FROM sessions WHERE user_id=$VNUM;" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d)[0].results[0].c)}catch(e){console.log('err')}})" )" "0"

# ===== v1.18: audit log =====
# login/upload/delete/admin.* events were produced above; wait for waitUntil writes to land
sleep 1
ACOUNT=$(wrangler d1 execute cf-picbed-db --local --command "SELECT COUNT(*) c FROM audit_log;" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d)[0].results[0].c)}catch(e){console.log('err')}})")
check "audit rows written" "$([ "${ACOUNT:-0}" -ge 5 ] && echo yes || echo no)" "yes"
check "audit has login" "$(wrangler d1 execute cf-picbed-db --local --command "SELECT COUNT(*) c FROM audit_log WHERE action='login';" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d)[0].results[0].c>0?'yes':'no')}catch(e){console.log('err')}})" )" "yes"
check "audit has upload" "$(wrangler d1 execute cf-picbed-db --local --command "SELECT COUNT(*) c FROM audit_log WHERE action='upload';" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d)[0].results[0].c>0?'yes':'no')}catch(e){console.log('err')}})" )" "yes"
check "audit has admin.user_disable" "$(wrangler d1 execute cf-picbed-db --local --command "SELECT COUNT(*) c FROM audit_log WHERE action='admin.user_disable';" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d)[0].results[0].c>0?'yes':'no')}catch(e){console.log('err')}})" )" "yes"
# /audit page: admin sees all, plain user sees only own
check "audit page 200 admin" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$ADMIN_COOKIE" "$BASE/audit")" "200"
check "audit page admin shows all" "$(curl -s -b "picbed_session=$ADMIN_COOKIE" "$BASE/audit" | grep -o '（全站）' | wc -l | tr -d ' ')" "1"
check "audit page user scoped" "$(curl -s -b "picbed_session=$COOKIE" "$BASE/audit" | grep -o '（仅本人）' | wc -l | tr -d ' ')" "1"
check "audit page filter bar" "$(curl -s -b "picbed_session=$ADMIN_COOKIE" "$BASE/audit" | grep -o 'class="filterbar"' | wc -l | tr -d ' ')" "1"
check "audit action filter rows" "$(curl -s -b "picbed_session=$ADMIN_COOKIE" "$BASE/audit?action=upload" | grep -o '<td><b>上传图片</b>' | wc -l | tr -d ' ' | awk '{print ($1>=1)?"yes":"no"}')" "yes"
check "audit action filter empty" "$(curl -s -b "picbed_session=$ADMIN_COOKIE" "$BASE/audit?action=zzznope" | grep -o '没有审计记录' | wc -l | tr -d ' ')" "1"
AQN=$(curl -s -b "picbed_session=$ADMIN_COOKIE" "$BASE/audit?q=admin%40example.com" | grep -o '共 <b>[0-9]*</b>' | head -1 | sed 's/[^0-9]//g')
check "audit q filter" "$([ "${AQN:-0}" -gt 0 ] && echo yes || echo no)" "yes"
check "audit api non-admin 403" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" "$BASE/api/admin/audit")" "403"
check "audit api admin 200" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$ADMIN_COOKIE" "$BASE/api/admin/audit")" "200"
check "audit api shape" "$(curl -s -b "picbed_session=$ADMIN_COOKIE" "$BASE/api/admin/audit?per_page=5" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(Array.isArray(j.logs)&&j.logs.length<=5&&typeof j.total==='number'?'ok':'bad')}catch(e){console.log('err')}})" )" "ok"
check "audit api action label" "$(curl -s -b "picbed_session=$ADMIN_COOKIE" "$BASE/api/admin/audit?action=login" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(j.logs.length&&j.logs[0].action_label==='登录'?'ok':'bad')}catch(e){console.log('err')}})" )" "ok"
check "audit docs endpoints" "$(curl -s -b "picbed_session=$ADMIN_COOKIE" "$BASE/docs" | grep -o '/api/admin/audit' | wc -l | tr -d ' ')" "1"
check "admin page audit link" "$(curl -s -b "picbed_session=$ADMIN_COOKIE" "$BASE/admin" | grep -o '查看审计日志' | wc -l | tr -d ' ')" "1"
check "settings page audit link" "$(curl -s -b "picbed_session=$COOKIE" "$BASE/settings" | grep -o '查看我的操作记录' | wc -l | tr -d ' ')" "1"
check "audit unauth 302" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/audit")" "302"
check "docs list user quota endpoint" "$(curl -s -b "picbed_session=$ADMIN_COOKIE" "$BASE/docs" | grep -o '/api/admin/users/:id/quota' | wc -l | tr -d ' ')" "1"

# v1.11: trash auto-cleanup (retention setting + admin sweep + expiry hints)
sval() { curl -s -b "picbed_session=$ADMIN_COOKIE" "$BASE/api/admin/settings" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).trash_retention_days)}catch(e){console.log('err')}})"; }
IDS3=$(upload "sw1"); IDS4=$(upload "sw2")
curl -s -o /dev/null -X POST -b "picbed_session=$COOKIE" "$BASE/images/$IDS3/delete"
curl -s -o /dev/null -X POST -b "picbed_session=$COOKIE" "$BASE/images/$IDS4/delete"
# backdate sw1 in SQLite format (raw-SQL shape); sw2 keeps the app's ISO shape
wrangler d1 execute cf-picbed-db --local --command "UPDATE images SET deleted_at = datetime('now','-5 days') WHERE public_id='$IDS3';" > /dev/null 2>&1
check "default retention 30" "$(sval)" "30"
# default 30d sweep keeps both (5d old is not yet expired)
check "default sweep 302" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$ADMIN_COOKIE" -X POST "$BASE/admin/trash-sweep")" "302"
check "default sweep keeps 5d-old" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" "$BASE/i/$IDS3")" "410"
check "retention form 302" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$ADMIN_COOKIE" -X POST -d "trash_retention_days=2" "$BASE/admin/settings")" "302"
check "retention set 2" "$(sval)" "2"
check "retention negative 400" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$ADMIN_COOKIE" -X PUT -H 'content-type: application/json' -d '{"trash_retention_days":-1}' "$BASE/api/admin/settings")" "400"
check "retention too big 400" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$ADMIN_COOKIE" -X PUT -H 'content-type: application/json' -d '{"trash_retention_days":99999}' "$BASE/api/admin/settings")" "400"
check "retention empty put 400" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$ADMIN_COOKIE" -X PUT -H 'content-type: application/json' -d '{}' "$BASE/api/admin/settings")" "400"
check "retention put 7" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$ADMIN_COOKIE" -X PUT -H 'content-type: application/json' -d '{"trash_retention_days":7}' "$BASE/api/admin/settings")" "200"
check "retention put applied" "$(sval)" "7"
check "retention form back to 2" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$ADMIN_COOKIE" -X POST -d "trash_retention_days=2" "$BASE/admin/settings")" "302"
check "sweep non-admin 403" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" -X POST "$BASE/admin/trash-sweep")" "403"
check "sweep 302" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$ADMIN_COOKIE" -X POST "$BASE/admin/trash-sweep")" "302"
check "swept sqlite-format old row gone" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" "$BASE/i/$IDS3")" "404"
check "fresh iso row still in trash" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" "$BASE/i/$IDS4")" "410"
check "sweep notice" "$(curl -s -b "picbed_session=$ADMIN_COOKIE" "$BASE/admin?msg=trash_swept&n=1" | grep -c '回收站清理完成')" "1"
check "trash page policy line" "$(curl -s -b "picbed_session=$COOKIE" "$BASE/trash" | grep -c '回收站保留')" "1"
check "trash page expiry hint" "$(curl -s -b "picbed_session=$COOKIE" "$BASE/trash" | grep -o '天后自动清除' | wc -l | tr -d ' ')" "1"
# backdate the remaining (ISO-format) row and sweep again — both stored
# shapes must be swept (regression: string compare missed ISO rows)
wrangler d1 execute cf-picbed-db --local --command "UPDATE images SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 days') WHERE public_id='$IDS4';" > /dev/null 2>&1
curl -s -o /dev/null -X POST -b "picbed_session=$ADMIN_COOKIE" "$BASE/admin/trash-sweep"
check "swept iso-format old row gone" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" "$BASE/i/$IDS4")" "404"
check "trash empty after sweep" "$(curl -s -b "picbed_session=$COOKIE" "$BASE/trash" | grep -c '回收站是空的')" "1"
# retention 0 -> sweep keeps everything (and page says so)
curl -s -o /dev/null -X POST -b "picbed_session=$ADMIN_COOKIE" -d "trash_retention_days=0" "$BASE/admin/settings"
check "retention 0 applied" "$(sval)" "0"
curl -s -o /dev/null -X POST -b "picbed_session=$ADMIN_COOKIE" "$BASE/admin/trash-sweep"
check "trash page keep-forever policy" "$(curl -s -b "picbed_session=$COOKIE" "$BASE/trash" | grep -c '不自动清理')" "1"
# admin page sections + docs
check "admin page trash section" "$(curl -s -b "picbed_session=$ADMIN_COOKIE" "$BASE/admin" | grep -c '回收站清理')" "1"
check "admin page sweep button" "$(curl -s -b "picbed_session=$ADMIN_COOKIE" "$BASE/admin" | grep -o '立即清理回收站' | wc -l | tr -d ' ')" "1"
check "admin page retention input" "$(curl -s -b "picbed_session=$ADMIN_COOKIE" "$BASE/admin" | grep -o 'name="trash_retention_days"' | wc -l | tr -d ' ')" "1"
check "docs retention field" "$(curl -s -b "picbed_session=$ADMIN_COOKIE" "$BASE/docs" | grep -o 'trash_retention_days' | wc -l | tr -d ' ')" "1"

# v2.38.0: the cron scheduled handler is gone with the Worker deployment
# (Pages Functions has no cron). Auto-purge is no longer exercised here;
# the admin "立即清理回收站" sweep above is the only purge path.

# cleanup
DRIVE_IDS=$(wrangler d1 execute cf-picbed-db --local --command "SELECT group_concat(drive_file_id) g FROM images;" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d)[0].results[0].g)}catch(e){console.log('')}})")
if [ -n "$DRIVE_IDS" ]; then
  NODE_USE_ENV_PROXY=1 node --input-type=module -e "
    const m = await import('./src/drive.js');

    const env = process.env;
    for (const id of '$DRIVE_IDS'.split(',')) { try { await m.deleteFile(env, id); } catch(e) {} }
    console.log('ok');
  " 2>/dev/null
  echo "PASS  cleanup"; PASS=$((PASS+1))
fi
wrangler d1 execute cf-picbed-db --local --command "DELETE FROM images; DELETE FROM api_keys; DELETE FROM rate_limits; DELETE FROM sessions; DELETE FROM invite_codes; DELETE FROM share_links; DELETE FROM settings; DELETE FROM users WHERE email LIKE '%example.com' OR email='admin@example.com';" > /dev/null 2>&1

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ]
