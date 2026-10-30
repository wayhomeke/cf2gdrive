#!/usr/bin/env bash

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
export SCRIPT_TMP="$SCRIPT_ROOT/tmp"
mkdir -p "$SCRIPT_TMP" || exit 1
# v1.21 security hardening test — CSRF choke point, security headers, cookie
# flags, API-key expiry, upload type gate and reflected-content escaping.
set -u
cd "$(dirname "$0")/.."
PORT=8787
BASE="http://127.0.0.1:$PORT"
PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1"; PASS=$((PASS+1)); else echo "FAIL  $1 (got:$2 want:$3)"; FAIL=$((FAIL+1)); fi; }

. ./tests/_schema.sh   # shared idempotent DDL (local D1 persists between suites)
wrangler d1 execute cf-picbed-db --local --command "DELETE FROM rate_limits; DELETE FROM sessions; DELETE FROM images; DELETE FROM users WHERE email LIKE '%example.com';" > /dev/null 2>&1
wrangler d1 execute cf-picbed-db --local --command "ALTER TABLE api_keys ADD COLUMN expires_at TEXT;" > /dev/null 2>&1
wrangler d1 execute cf-picbed-db --local --command "CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, actor_email TEXT, action TEXT NOT NULL, target TEXT, detail TEXT, ip TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));" > /dev/null 2>&1
wrangler d1 execute cf-picbed-db --local --command "DELETE FROM invite_codes; INSERT OR IGNORE INTO users (email,password_hash,password_salt,display_name,role) VALUES ('seed-admin@example.com','x','x','SeedAdmin','admin'); INSERT INTO invite_codes (code,created_by,max_uses,used_count,note) VALUES ('SEEDSEC',(SELECT id FROM users WHERE email='seed-admin@example.com'),100,0,'sec-seed');" > /dev/null 2>&1
INVITE="SEEDSEC"

wrangler pages dev --binding ADMIN_EMAILS=admin@example.com --port $PORT > "${SCRIPT_TMP}"/cfpicbed-dev-sec.log 2>&1 &
DEV_PID=$!
trap 'kill $DEV_PID 2>/dev/null' EXIT
for i in $(seq 1 40); do curl -sf --max-time 2 "$BASE/healthz" | grep -q '"ok"' && break; sleep 1; done

TS=$(date +%s)
EMAIL="s${TS}@example.com"
echo "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" | base64 -d > "${SCRIPT_TMP}"/sec.png
printf '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' > "${SCRIPT_TMP}"/sec.svg
DBQ() { wrangler d1 execute cf-picbed-db --local --command "$1" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const r=JSON.parse(d)[0].results;console.log(Object.values(r[0]||{})[0])}catch(e){console.log('err')}})"; }

# ---- security headers ----
H=$(curl -s -D - -o /dev/null --noproxy '*' "$BASE/healthz")
check "hsts header" "$(echo "$H" | grep -ci 'strict-transport-security: max-age=31536000')" "1"
check "permissions-policy header" "$(echo "$H" | grep -ci 'permissions-policy: camera=()')" "1"
check "csp header" "$(echo "$H" | grep -ci "content-security-policy: .*frame-ancestors 'none'")" "1"
check "nosniff header" "$(echo "$H" | grep -ci 'x-content-type-options: nosniff')" "1"
check "x-frame-options header" "$(echo "$H" | grep -ci 'x-frame-options: DENY')" "1"
check "referrer-policy header" "$(echo "$H" | grep -ci 'referrer-policy: same-origin')" "1"

# ---- cookie flags ----
RC=$(curl -s -D - -o /dev/null --noproxy '*' -X POST -d "email=$EMAIL&password=test1234&invite_code=$INVITE" "$BASE/register")
COOKIE=$(echo "$RC" | grep -i '^set-cookie: picbed_session' | head -1 | sed 's/^[Ss]et-[Cc]ookie: picbed_session=\([^;]*\).*/\1/')
check "register ok" "$([ -n "$COOKIE" ] && echo yes || echo no)" "yes"
check "cookie httponly" "$(echo "$RC" | grep -ci 'set-cookie: picbed_session=.*HttpOnly')" "1"
check "cookie secure" "$(echo "$RC" | grep -ci 'set-cookie: picbed_session=.*Secure')" "1"
check "cookie samesite=lax" "$(echo "$RC" | grep -ci 'set-cookie: picbed_session=.*SameSite=Lax')" "1"

# ---- CSRF choke point ----
IMG=$(curl -s -b "picbed_session=$COOKIE" -X POST -F "file=@${SCRIPT_TMP}/sec.png;filename=sec1.png" --noproxy '*' "$BASE/api/upload")
ID=$(echo "$IMG" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).id)}catch(e){console.log('')}})")
check "upload works" "$([ -n "$ID" ] && echo yes || echo no)" "yes"
CROSS=$(curl -s -o "${SCRIPT_TMP}"/cross.json -w '%{http_code}' -b "picbed_session=$COOKIE" -H 'Origin: https://evil.example' -X POST --noproxy '*' "$BASE/images/$ID/delete")
check "cross-origin cookie write 403" "$CROSS" "403"
check "cross-origin body code" "$(grep -c 'cross_origin' ${SCRIPT_TMP}/cross.json)" "1"
check "row untouched after blocked write" "$(DBQ "SELECT deleted FROM images WHERE public_id='$ID';")" "0"
check "same-origin cookie write ok" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" -H "Origin: $BASE" -X POST --noproxy '*' "$BASE/images/$ID/rename" -d 'name=sec-renamed.png')" "200"
check "renamed via same-origin" "$(DBQ "SELECT original_name FROM images WHERE public_id='$ID';")" "sec-renamed.png"
check "no Origin header (curl) allowed" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" -X POST --noproxy '*' "$BASE/images/$ID/rename" -d 'name=sec-renamed2.png')" "200"
check "cross-origin Referer also blocked" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" -H 'Referer: https://evil.example/x' -X POST --noproxy '*' "$BASE/images/$ID/delete")" "403"

# ---- BAPI key: Bearer exempt from CSRF + expiry enforcement ----
KEYJSON=$(curl -s -b "picbed_session=$COOKIE" -X POST -H 'content-type: application/json' -d '{"name":"sec-key","expires_in_days":1}' --noproxy '*' "$BASE/api/keys")
KEY=$(echo "$KEYJSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).key)}catch(e){console.log('')}})")
check "key created with expiry" "$(echo "$KEYJSON" | grep -c '"expires_at":"')" "1"
check "bearer cross-origin allowed" "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" -H 'Origin: https://evil.example' --noproxy '*' "$BASE/api/stats")" "200"
check "bearer works before expiry" "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" --noproxy '*' "$BASE/api/stats")" "200"
wrangler d1 execute cf-picbed-db --local --command "UPDATE api_keys SET expires_at = datetime('now','-1 day') WHERE key_prefix LIKE 'pb_live_%';" > /dev/null 2>&1
check "bearer rejected after expiry" "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" --noproxy '*' "$BASE/api/stats")" "401"
check "keys page shows expiry column" "$(curl -s -b "picbed_session=$COOKIE" --noproxy '*' "$BASE/keys" | grep -c '<th>有效期</th>')" "1"
check "keys page flags expired" "$(curl -s -b "picbed_session=$COOKIE" --noproxy '*' "$BASE/keys" | grep -c '已过期')" "1"

# ---- upload type gate: SVG is rejected by byte sniffing ----
SVGCODE=$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" -X POST -F "file=@${SCRIPT_TMP}/sec.svg;filename=x.png" --noproxy '*' "$BASE/api/upload")
check "svg upload rejected 415" "$SVGCODE" "415"

# ---- reflected content: filename escaping ----
curl -s -b "picbed_session=$COOKIE" -X POST -F "file=@${SCRIPT_TMP}/sec.png;filename=<script>alert(1)</script>.png" --noproxy '*' "$BASE/api/upload" > /dev/null
GAL=$(curl -s -b "picbed_session=$COOKIE" --noproxy '*' "$BASE/gallery")
check "filename html-escaped in gallery" "$(echo "$GAL" | grep -c '&lt;script&gt;')" "2"
check "raw script tag not injected" "$(echo "$GAL" | grep -c '<script>alert(1)</script>')" "0"

# ---- meta + docs surface the security model ----
META=$(curl -s --noproxy '*' "$BASE/api/meta")
check "meta has security block" "$(echo "$META" | grep -c '"security":')" "1"
check "meta lists csrf policy" "$(echo "$META" | grep -c 'cross_origin')" "1"
check "meta lists rate limits" "$(echo "$META" | grep -c '"rate_limits":')" "1"
check "docs security section" "$(curl -s -b "picbed_session=$COOKIE" --noproxy '*' "$BASE/docs" | grep -c '安全模型')" "1"
check "docs mentions key expiry" "$(curl -s -b "picbed_session=$COOKIE" --noproxy '*' "$BASE/docs" | grep -c '密钥有效期')" "1"

# ---- v1.25: opaque image ids, sequential ids unreachable ----
UPJSON=$(curl -s -b "picbed_session=$COOKIE" --noproxy '*' -X POST -F "file=@${SCRIPT_TMP}/sec.png;filename=idcheck.png" "$BASE/api/upload")
SID=$(echo "$UPJSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).id)}catch(e){console.log('')}})")
check "upload id is 12 lowercase hex" "$(printf '%s' "$SID" | grep -Ec '^[0-9a-f]{12}$')" "1"
check "upload url carries opaque id" "$(echo "$UPJSON" | grep -c "\"url\":\"/i/$SID\"")" "1"
check "opaque image serves 200" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" --noproxy '*' "$BASE/i/$SID")" "200"
check "opaque thumb serves 200" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" --noproxy '*' "$BASE/t/$SID")" "200"
check "private image still 403 anon" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "$BASE/i/$SID")" "403"
check "uppercase id rejected 404" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "$BASE/i/$(printf '%s' "$SID" | tr 'a-f' 'A-F')")" "404"
# sequential row ids must not be addressable at all (no redirect, no login gate)
check "/i/1 is 404" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "$BASE/i/1")" "404"
check "/i/65 is 404" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "$BASE/i/65")" "404"
check "/t/1 is 404" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "$BASE/t/1")" "404"
check "/i/1+1 is 404" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "$BASE/i/1%2B1")" "404"
check "/api/images/65 is 404" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" --noproxy '*' "$BASE/api/images/65")" "404"
NID=$(DBQ "SELECT id FROM images WHERE public_id='$SID';")
check "row id exists but is hidden" "$(printf '%s' "$NID" | grep -Ec '^[0-9]+$')" "1"
check "row id path is 404" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "$BASE/i/$NID")" "404"
check "row id api is 404" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" --noproxy '*' "$BASE/api/images/$NID")" "404"
# no numeric links anywhere in the rendered pages
check "gallery has no numeric image links" "$(curl -s -b "picbed_session=$COOKIE" --noproxy '*' "$BASE/gallery" | grep -Eoc '/i/[0-9]+"')" "0"
check "gallery links are opaque" "$(curl -s -b "picbed_session=$COOKIE" --noproxy '*' "$BASE/gallery" | grep -Eo '/i/[0-9a-f]{12}"' | wc -l | tr -d ' ' | awk '{print ($1>=1)?"yes":"no"}')" "yes"
# every id in the list API is a token, never an integer
check "list ids are all opaque" "$(curl -s -b "picbed_session=$COOKIE" --noproxy '*' "$BASE/api/images" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);const a=j.images||[];console.log(a.length&&a.every(x=>/^[0-9a-f]{12}\$/.test(x.id))?'yes':'no')}catch(e){console.log('err')}})")" "yes"
# two uploads never share an id
SID2=$(curl -s -b "picbed_session=$COOKIE" --noproxy '*' -X POST -F "file=@${SCRIPT_TMP}/sec.png;filename=idcheck2.png" "$BASE/api/upload" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).id)}catch(e){console.log('')}})")
check "consecutive uploads get distinct ids" "$([ -n "$SID2" ] && [ "$SID2" != "$SID" ] && echo yes || echo no)" "yes"
check "meta documents the id format" "$(echo "$META" | grep -c '"ids":')" "1"
check "meta warns numeric ids 404" "$(echo "$META" | grep -c 'return 404')" "1"
check "meta exposes shard layout" "$(echo "$META" | grep -c 'max_files_per_dir')" "1"
check "docs id section present" "$(curl -s -b "picbed_session=$COOKIE" --noproxy '*' "$BASE/docs" | grep -c '图片标识')" "1"
check "docs says not enumerable" "$(curl -s -b "picbed_session=$COOKIE" --noproxy '*' "$BASE/docs" | grep -c '不可枚举')" "1"

# ---- login rate limit still enforced ----
for i in $(seq 1 11); do curl -s -o /dev/null --noproxy '*' -X POST -d "email=$EMAIL&password=wrongpass" "$BASE/login"; done
check "login rate limited 429" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' -X POST -d "email=$EMAIL&password=wrongpass" "$BASE/login")" "429"

wrangler d1 execute cf-picbed-db --local --command "DELETE FROM images; DELETE FROM rate_limits; DELETE FROM api_keys WHERE name='sec-key';" > /dev/null 2>&1

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ]
