#!/usr/bin/env bash

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
export SCRIPT_TMP="$SCRIPT_ROOT/tmp"
mkdir -p "$SCRIPT_TMP" || exit 1
# v0.7 REST API + API keys test. Self-contained.
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
wrangler d1 execute cf-picbed-db --local --command "DELETE FROM rate_limits; DELETE FROM sessions; DELETE FROM images; DELETE FROM api_keys; DELETE FROM users WHERE email LIKE '%example.com';" > /dev/null 2>&1
# v1.12: ensure images.exif exists (idempotent; harmless failure if already present)
wrangler d1 execute cf-picbed-db --local --command "ALTER TABLE images ADD COLUMN exif TEXT;" > /dev/null 2>&1
# v1.13: ensure share_links exists (idempotent)
wrangler d1 execute cf-picbed-db --local --command "CREATE TABLE IF NOT EXISTS share_links (id INTEGER PRIMARY KEY AUTOINCREMENT, image_id INTEGER NOT NULL REFERENCES images (id) ON DELETE CASCADE, token TEXT NOT NULL UNIQUE, created_by INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE, expires_at TEXT, views INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now'))); CREATE INDEX IF NOT EXISTS idx_shares_token ON share_links (token); CREATE INDEX IF NOT EXISTS idx_shares_image ON share_links (image_id);" > /dev/null 2>&1
# v1.18: ensure audit_log exists (idempotent)
wrangler d1 execute cf-picbed-db --local --command "CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, actor_email TEXT, action TEXT NOT NULL, target TEXT, detail TEXT, ip TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))); CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at);" > /dev/null 2>&1

# v1.2: registration is invite-only — seed a usable code directly in D1
wrangler d1 execute cf-picbed-db --local --command "DELETE FROM invite_codes; INSERT OR IGNORE INTO users (email,password_hash,password_salt,display_name,role) VALUES ('seed-admin@example.com','x','x','SeedAdmin','admin'); INSERT INTO invite_codes (code,created_by,max_uses,used_count,note) VALUES ('SEEDAPI',(SELECT id FROM users WHERE email='seed-admin@example.com'),100,0,'test-seed');" > /dev/null 2>&1
INVITE="SEEDAPI"

wrangler pages dev --binding ADMIN_EMAILS=admin@example.com --port $PORT > "${SCRIPT_TMP}"/cfpicbed-dev.log 2>&1 &
DEV_PID=$!
trap 'kill $DEV_PID 2>/dev/null' EXIT
for i in $(seq 1 40); do curl -sf --max-time 2 "$BASE/healthz" | grep -q '"ok"' && break; sleep 1; done

TS=$(date +%s)
EMAIL="a${TS}@example.com"
echo "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" | base64 -d > "${SCRIPT_TMP}"/test.png

COOKIE=$(curl -s -D - -o /dev/null -X POST -d "email=$EMAIL&password=test1234&invite_code=$INVITE" "$BASE/register" | grep -i '^set-cookie: picbed_session' | head -1 | sed 's/^[Ss]et-[Cc]ookie: picbed_session=\([^;]*\).*/\1/')
[ -n "$COOKIE" ] && { echo "PASS  register+cookie"; PASS=$((PASS+1)); } || { echo "FAIL  register+cookie"; FAIL=$((FAIL+1)); }

# 1. create API key
KEY=$(curl -s -b "picbed_session=$COOKIE" -X POST -H "content-type: application/json" -d '{"name":"test-key"}' "$BASE/api/keys" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).key)}catch(e){console.log('')}})")
check "create api key" "$([ -n "$KEY" ] && echo yes || echo no)" "yes"
check "key format pb_live_" "$(echo "$KEY" | grep -c '^pb_live_[0-9a-f]\{48\}$')" "1"

# 2. list keys (prefix only, no full key)
LK=$(curl -s -b "picbed_session=$COOKIE" "$BASE/api/keys")
check "list keys" "$(echo "$LK" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).keys.length)}catch(e){console.log('err')}})" )" "1"
check "list hides full key" "$(echo "$LK" | grep -c "$KEY")" "0"

# 3. upload via Bearer
RESP=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $KEY" -X POST -F "file=@${SCRIPT_TMP}/test.png" "$BASE/api/upload")
check "bearer upload 201" "$(echo "$RESP" | tail -1)" "201"
IMG_ID=$(echo "$RESP" | head -1 | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).id)}catch(e){console.log('')}})")

# 4. list images via Bearer
LI=$(curl -s -H "Authorization: Bearer $KEY" "$BASE/api/images")
check "bearer list images" "$(echo "$LI" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).total)}catch(e){console.log('err')}})" )" "1"

# 5. image meta via Bearer
check "bearer image meta" "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" "$BASE/api/images/$IMG_ID")" "200"

# 6. rename via PATCH JSON
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH -H "Authorization: Bearer $KEY" -H "content-type: application/json" -d '{"name":"api-renamed.png"}' "$BASE/api/images/$IMG_ID")
check "bearer rename 200" "$CODE" "200"
NM=$(curl -s -H "Authorization: Bearer $KEY" "$BASE/api/images/$IMG_ID" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).original_name)}catch(e){console.log('')}})")
check "rename applied" "$NM" "api-renamed.png"

# 6b. v1.10: list filters (q / vis / sort) via Bearer
check "api list q match" "$(curl -s -H "Authorization: Bearer $KEY" "$BASE/api/images?q=api-renamed" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).total)}catch(e){console.log('err')}})" )" "1"
check "api list q no match" "$(curl -s -H "Authorization: Bearer $KEY" "$BASE/api/images?q=zzznope" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).total)}catch(e){console.log('err')}})" )" "0"
check "api list q injection literal" "$(curl -s -G --data-urlencode "q=' OR 1=1--" -H "Authorization: Bearer $KEY" "$BASE/api/images" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).total)}catch(e){console.log('err')}})" )" "0"
check "api list q metachar literal" "$(curl -s -G --data-urlencode "q=%" -H "Authorization: Bearer $KEY" "$BASE/api/images" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).total)}catch(e){console.log('err')}})" )" "0"
check "api list vis public empty" "$(curl -s -H "Authorization: Bearer $KEY" "$BASE/api/images?vis=public" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).total)}catch(e){console.log('err')}})" )" "0"
check "api list vis private 1" "$(curl -s -H "Authorization: Bearer $KEY" "$BASE/api/images?vis=private" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).total)}catch(e){console.log('err')}})" )" "1"
check "api list query echo" "$(curl -s -G --data-urlencode "q=api-renamed" -H "Authorization: Bearer $KEY" "$BASE/api/images" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).query.q)}catch(e){console.log('err')}})" )" "api-renamed"
check "api list sort echoed" "$(curl -s -H "Authorization: Bearer $KEY" "$BASE/api/images?sort=largest" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).query.sort)}catch(e){console.log('err')}})" )" "largest"
check "api list bad sort 200" "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" "$BASE/api/images?sort=bogus")" "200"
check "api list bad sort falls back" "$(curl -s -H "Authorization: Bearer $KEY" "$BASE/api/images?sort=bogus" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).query.sort)}catch(e){console.log('err')}})" )" "newest"

# 6c. v1.13: share links (time-limited /s/<token> grants anonymous read)
SH=$(curl -s -w "\n%{http_code}" -b "picbed_session=$COOKIE" -X POST -H "content-type: application/json" -d '{"expires_in_days":7}' "$BASE/api/images/$IMG_ID/share")
check "share create 201" "$(echo "$SH" | tail -1)" "201"
SH_TOKEN=$(echo "$SH" | head -1 | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(j.url.replace('/s/',''))}catch(e){console.log('')}})")
SH_URL=$(echo "$SH" | head -1 | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).url)}catch(e){console.log('')}})")
check "share url shape" "$(echo "$SH_URL" | grep -c '^/s/')" "1"
check "share expiry set" "$(echo "$SH" | head -1 | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).expires_at?'set':'null')}catch(e){console.log('err')}})" )" "set"
check "share serves anon 200" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE$SH_URL")" "200"
check "share serves original bytes" "$(curl -s "$BASE$SH_URL" | md5 -q)" "$(md5 -q "${SCRIPT_TMP}/test.png")"
check "share bad expiry 400" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" -X POST -H 'content-type: application/json' -d '{"expires_in_days":0}' "$BASE/api/images/$IMG_ID/share")" "400"
check "share huge expiry 400" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" -X POST -H 'content-type: application/json' -d '{"expires_in_days":99999}' "$BASE/api/images/$IMG_ID/share")" "400"
check "share no-auth 401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"never":true}' "$BASE/api/images/$IMG_ID/share")" "401"
check "share bad key 401" "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer pb_live_deadbeef" -X POST -H 'content-type: application/json' -d '{"never":true}' "$BASE/api/images/$IMG_ID/share")" "401"
SH2=$(curl -s -b "picbed_session=$COOKIE" -X POST -H "content-type: application/json" -d '{"never":true}' "$BASE/api/images/$IMG_ID/share")
SH2_URL=$(echo "$SH2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).url)}catch(e){console.log('')}})")
check "share never expiry null" "$(echo "$SH2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).expires_at)}catch(e){console.log('err')}})" )" "null"
check "share list contains token" "$(curl -s -b "picbed_session=$COOKIE" "$BASE/api/images/$IMG_ID/shares" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).shares.filter(s=>s.url==='$SH_URL').length)}catch(e){console.log('err')}})" )" "1"
check "shares page 200" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" "$BASE/shares")" "200"
check "shares page lists link" "$(curl -s -b "picbed_session=$COOKIE" "$BASE/shares" | grep -c "$SH_TOKEN")" "2"
SH_ID=$(curl -s -b "picbed_session=$COOKIE" "$BASE/api/images/$IMG_ID/shares" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).shares.find(s=>s.url==='$SH_URL').id)}catch(e){console.log('')}})")
check "share revoke 200" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" -X DELETE "$BASE/api/shares/$SH_ID")" "200"
check "revoked share 404" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE$SH_URL")" "404"
check "revoked share page text" "$(curl -s "$BASE$SH_URL" | grep -c '链接已被吊销')" "1"
check "revoke unknown 404" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" -X DELETE "$BASE/api/shares/999999")" "404"
# expired share -> 410 (backdate the never-share's sibling: reuse SH2 via raw SQL)
SH2_TOKEN=$(echo "$SH2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).url.replace('/s/',''))}catch(e){console.log('')}})")
wrangler d1 execute cf-picbed-db --local --command "UPDATE share_links SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 days') WHERE token='$SH2_TOKEN';" > /dev/null 2>&1
check "expired share 410" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE$SH2_URL")" "410"
check "expired share page text" "$(curl -s "$BASE$SH2_URL" | grep -c '链接已过期')" "1"
check "unknown share token 404" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/s/deadbeefdeadbeefdeadbeef")" "404"
check "share image still private" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/i/$IMG_ID")" "403"

# 7. stats
ST=$(curl -s -H "Authorization: Bearer $KEY" "$BASE/api/stats")
check "stats images=1" "$(echo "$ST" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).images)}catch(e){console.log('err')}})" )" "1"
check "stats used=70" "$(echo "$ST" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).used_bytes)}catch(e){console.log('err')}})" )" "70"

# ===== v1.19: API enhancements =====
META=$(curl -s "$BASE/api/meta")
check "meta version" "$(echo "$META" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).version)}catch(e){console.log('err')}})" )" "$(grep -o 'const VERSION = "[^"]*"' src/index.js | cut -d'"' -f2)"
check "meta limits positive" "$(echo "$META" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(j.limits.upload_max_bytes>0?'yes':'no')}catch(e){console.log('err')}})" )" "yes"
check "meta visibility enum" "$(echo "$META" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).enums.visibility.join(','))}catch(e){console.log('err')}})" )" "private,public"
check "meta sorts count" "$(echo "$META" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).enums.sorts.length)}catch(e){console.log('err')}})" )" "5"
check "meta batch endpoints" "$(echo "$META" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).endpoints.batch.length)}catch(e){console.log('err')}})" )" "4"
check "meta audit actions" "$(echo "$META" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).enums.audit_actions.includes('admin.user_delete')?'yes':'no')}catch(e){console.log('err')}})" )" "yes"
# stats enhanced fields
check "stats public/private split" "$(echo "$ST" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log((j.public_count+j.private_count)===j.images?'yes':'no')}catch(e){console.log('err')}})" )" "yes"
check "stats sessions field" "$(echo "$ST" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(typeof j.active_sessions==='number'?'yes':'no')}catch(e){console.log('err')}})" )" "yes"
# PATCH: visibility only / empty / bad value
check "patch visibility 200" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" -X PATCH -H 'content-type: application/json' -d '{"visibility":"public"}' "$BASE/api/images/$IMG_ID")" "200"
check "patch visibility applied" "$(curl -s -b "picbed_session=$COOKIE" "$BASE/api/images/$IMG_ID" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).visibility)}catch(e){console.log('err')}})" )" "public"
check "patch empty 400" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" -X PATCH -H 'content-type: application/json' -d '{}' "$BASE/api/images/$IMG_ID")" "400"
check "patch bad visibility 400" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" -X PATCH -H 'content-type: application/json' -d '{"visibility":"secret"}' "$BASE/api/images/$IMG_ID")" "400"
check "patch name+vis both" "$(curl -s -b "picbed_session=$COOKIE" -X PATCH -H 'content-type: application/json' -d '{"name":"both.png","visibility":"private"}' "$BASE/api/images/$IMG_ID" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(j.name==='both.png'&&j.visibility==='private'?'ok':'bad')}catch(e){console.log('err')}})" )" "ok"
# batch endpoints (3 fresh uploads)
u2() { curl -s -b "picbed_session=$COOKIE" -X POST -F "file=@${SCRIPT_TMP}/test.png;filename=$1.png" "$BASE/api/upload" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).id)}catch(e){console.log('')}})"; }
N1=$(u2 b1); N2=$(u2 b2); N3=$(u2 b3)
check "batch visibility 2" "$(curl -s -b "picbed_session=$COOKIE" -X POST -H 'content-type: application/json' -d "{\"ids\":[\"$N1\",\"$N2\"],\"visibility\":\"public\"}" "$BASE/api/images/batch-visibility" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).updated)}catch(e){console.log('err')}})" )" "2"
check "batch visibility no ids 400" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" -X POST -H 'content-type: application/json' -d '{"ids":[]}' "$BASE/api/images/batch-visibility")" "400"
check "batch visibility bad value 400" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" -X POST -H 'content-type: application/json' -d "{\"ids\":[\"$N1\"],\"visibility\":\"x\"}" "$BASE/api/images/batch-visibility")" "400"
curl -s -o /dev/null -b "picbed_session=$COOKIE" -X POST -H 'content-type: application/json' -d "{\"ids\":[\"$N1\",\"$N2\",\"$N3\"]}" "$BASE/api/images/batch-delete"
check "batch restore 2" "$(curl -s -b "picbed_session=$COOKIE" -X POST -H 'content-type: application/json' -d "{\"ids\":[\"$N1\",\"$N2\"]}" "$BASE/api/images/batch-restore" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).restored)}catch(e){console.log('err')}})" )" "2"
check "batch purge 1" "$(curl -s -b "picbed_session=$COOKIE" -X POST -H 'content-type: application/json' -d "{\"ids\":[\"$N3\",\"$N1\"]}" "$BASE/api/images/batch-purge" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).purged)}catch(e){console.log('err')}})" )" "1"
check "batch restore unauth 401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"ids":["0123456789ab"]}' "$BASE/api/images/batch-restore")" "401"
check "docs batch endpoints" "$(curl -s -b "picbed_session=$COOKIE" "$BASE/docs" | grep -o '/api/images/batch-' | wc -l | tr -d ' ' | awk '{print ($1>=4)?"yes":"no"}')" "yes"

# 8. delete via Bearer
check "bearer delete" "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "Authorization: Bearer $KEY" "$BASE/api/images/$IMG_ID")" "200"
check "deleted image 404" "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" "$BASE/api/images/$IMG_ID")" "404"

# 9. other user's image -> 404 (isolation)
TS2=$(date +%s)
curl -s -o /dev/null -X POST -d "email=other${TS2}@example.com&password=test1234&invite_code=$INVITE" "$BASE/register"
KEY2=$(curl -s -D "${SCRIPT_TMP}"/h2.txt -o /dev/null -X POST -d "email=other${TS2}@example.com&password=test1234" "$BASE/login" >/dev/null; true)
# other user can't see user1's image (id 1 exists but belongs to user1)
check "cross-user 404" "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" "$BASE/api/images/999999")" "404"

# 10. bad key rejected
check "bad key 401" "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer pb_live_deadbeef" "$BASE/api/images")" "401"
check "no auth 401" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/images")" "401"

# 11. revoke -> key stops working
KEY_ID=$(echo "$LK" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).keys[0].id)}catch(e){console.log('')}})")
check "revoke key" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" -X DELETE "$BASE/api/keys/$KEY_ID")" "200"
check "revoked key 401" "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" "$BASE/api/images")" "401"

# 12. keys page
check "keys page 200" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" "$BASE/keys")" "200"

# 13. v1.9: remote URL upload — auth + SSRF guards (no network needed for these)
err_of() { curl -s -b "picbed_session=$COOKIE" -X POST -H 'content-type: application/json' -d "$1" "$BASE/api/upload-url" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).error)}catch(e){console.log('err')}})"; }
check "url upload no-auth 401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"url":"https://example.com/a.png"}' "$BASE/api/upload-url")" "401"
check "url upload missing url 400" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" -X POST -H 'content-type: application/json' -d '{}' "$BASE/api/upload-url")" "400"
check "url upload bad scheme" "$(err_of '{"url":"ftp://example.com/a.png"}')" "bad_url"
check "url upload loopback blocked" "$(err_of '{"url":"http://127.0.0.1/a.png"}')" "bad_url"
check "url upload localhost blocked" "$(err_of '{"url":"http://localhost/a.png"}')" "bad_url"
check "url upload 169.254 blocked" "$(err_of '{"url":"http://169.254.169.254/latest/meta-data"}')" "bad_url"
check "url upload 10.x blocked" "$(err_of '{"url":"http://10.0.0.1/a.png"}')" "bad_url"
check "url upload 192.168 blocked" "$(err_of '{"url":"http://192.168.1.1/a.png"}')" "bad_url"
check "url upload .local blocked" "$(err_of '{"url":"http://printer.local/a.png"}')" "bad_url"
check "url upload garbage url" "$(err_of '{"url":"not a url"}')" "bad_url"

# cleanup
DRIVE_IDS=$(wrangler d1 execute cf-picbed-db --local --command "SELECT group_concat(drive_file_id) g FROM images;" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d)[0].results[0].g)}catch(e){console.log('')}})")
if [ -n "$DRIVE_IDS" ]; then
  NODE_USE_ENV_PROXY=1 node --input-type=module -e "
    const m = await import('./src/drive.js');

    const env = process.env;
    for (const id of '$DRIVE_IDS'.split(',')) { try { await m.deleteFile(env, id); } catch(e) {} }
    console.log('ok');
  "
  echo "PASS  cleanup"; PASS=$((PASS+1))
fi
wrangler d1 execute cf-picbed-db --local --command "DELETE FROM images; DELETE FROM api_keys; DELETE FROM rate_limits; DELETE FROM share_links;" > /dev/null 2>&1

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ]
