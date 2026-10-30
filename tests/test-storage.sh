#!/usr/bin/env bash

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
export SCRIPT_TMP="$SCRIPT_ROOT/tmp"
mkdir -p "$SCRIPT_TMP" || exit 1
# v1.24 sharded storage test: <md5(email)[0:4]>/<1..255>/<8-char id>.<ext>
# Self-contained; starts its own wrangler dev on :8787.
set -u
: "${GOOGLE_CLIENT_ID:?Set GOOGLE_CLIENT_ID}"
: "${GOOGLE_CLIENT_SECRET:?Set GOOGLE_CLIENT_SECRET}"
: "${GOOGLE_REFRESH_TOKEN:?Set GOOGLE_REFRESH_TOKEN}"
: "${DRIVE_FOLDER_ID:?Set DRIVE_FOLDER_ID}"
export GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_REFRESH_TOKEN DRIVE_FOLDER_ID
cd "$(dirname "$0")/.."
PORT=8787
BASE="http://127.0.0.1:$PORT"
PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1"; PASS=$((PASS+1)); else echo "FAIL  $1 (got:$2 want:$3)"; FAIL=$((FAIL+1)); fi; }
yesno() { if [ "$1" = "1" ]; then echo yes; else echo no; fi; }


# schema guard first: the local D1 persists between suites
. ./tests/_schema.sh

TS=$(date +%s)
E1="st${TS}a@example.com"
E2="st${TS}b@example.com"
P1=$(md5 -q -s "$E1" | cut -c1-4)
P2=$(md5 -q -s "$E2" | cut -c1-4)

# scoped cleanup (never a bare DELETE: production D1 shares this syntax);
# rate_limits is wiped because register is capped at 5/hour per IP
wrangler d1 execute cf-picbed-db --local --command "
DELETE FROM images WHERE user_id IN (SELECT id FROM users WHERE email IN ('$E1','$E2'));
DELETE FROM users WHERE email IN ('$E1','$E2');
DELETE FROM storage_dirs WHERE owner_key IN ('$P1','$P2');
DELETE FROM rate_limits;" > /dev/null 2>&1
wrangler d1 execute cf-picbed-db --local --command "DELETE FROM invite_codes; INSERT OR IGNORE INTO users (email,password_hash,password_salt,display_name,role) VALUES ('seed-admin@example.com','x','x','SeedAdmin','admin'); INSERT INTO invite_codes (code,created_by,max_uses,used_count,note) VALUES ('SEEDSTG',(SELECT id FROM users WHERE email='seed-admin@example.com'),100,0,'test-seed');" > /dev/null 2>&1
INVITE="SEEDSTG"

# dq "<sql>" -> first column of every row, one per line
dq() {
  wrangler d1 execute cf-picbed-db --local --command "$1" --json 2>/dev/null | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  try{const j=JSON.parse(d);const rows=(Array.isArray(j)?j[0]:j).results||[];
    console.log(rows.map(r=>Object.keys(r).map(k=>r[k]).join('|')).join('\n'));}catch(e){console.log('ERR')}});"
}

wrangler pages dev --binding ADMIN_EMAILS=admin@example.com --port $PORT > "${SCRIPT_TMP}"/cfpicbed-storage.log 2>&1 &
DEV_PID=$!
# teardown: this suite seeds 255 shard rows, they must not pollute later runs
cleanup() {
  kill $DEV_PID 2>/dev/null
  wrangler d1 execute cf-picbed-db --local --command "
DELETE FROM images WHERE user_id IN (SELECT id FROM users WHERE email IN ('$E1','$E2'));
DELETE FROM users WHERE email IN ('$E1','$E2');
DELETE FROM storage_dirs WHERE owner_key IN ('$P1','$P2');" > /dev/null 2>&1
}
trap cleanup EXIT
for i in $(seq 1 40); do
  curl -sf --max-time 2 --noproxy '*' "$BASE/healthz" | grep -q '"ok"' && break
  sleep 1
done

PNG_B64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
echo "$PNG_B64" | base64 -d > "${SCRIPT_TMP}"/st.png

login() { # login <email> <password> -> cookie
  curl -s -D - -o /dev/null --noproxy '*' -X POST -d "email=$1&password=$2" "$BASE/login" \
    | grep -i '^set-cookie: picbed_session' | head -1 | sed 's/^[Ss]et-[Cc]ookie: picbed_session=\([^;]*\).*/\1/'
}
reg() { curl -s -o /dev/null --noproxy '*' -X POST -d "email=$1&password=$2&invite_code=$INVITE" "$BASE/register"; }

# Warm-up: the first Drive call of a fresh isolate fetches the OAuth token
# through the sandbox proxy, which is occasionally slow right after boot and
# would surface as a one-off 500. Prime it with a throwaway upload that is not
# part of the assertion set.
EW="warm${TS}@example.com"
PW=$(md5 -q -s "$EW" | cut -c1-4)
reg "$EW" test1234
CW=$(login "$EW" test1234)
if [ -n "$CW" ]; then
  curl -s -o /dev/null --noproxy '*' -b "picbed_session=$CW" -X POST -F "file=@${SCRIPT_TMP}/st.png" "$BASE/api/upload"
fi
wrangler d1 execute cf-picbed-db --local --command "
DELETE FROM images WHERE user_id IN (SELECT id FROM users WHERE email='$EW');
DELETE FROM users WHERE email='$EW';
DELETE FROM storage_dirs WHERE owner_key='$PW';" > /dev/null 2>&1

reg "$E1" test1234
reg "$E2" test1234
C1=$(login "$E1" test1234)
C2=$(login "$E2" test1234)
check "register user1+cookie" "$([ -n "$C1" ] && echo yes)" "yes"
check "register user2+cookie" "$([ -n "$C2" ] && echo yes)" "yes"
check "prefix is md5[0:4] of email" "$(echo "$P1" | grep -cE '^[0-9a-f]{4}$')" "1"
check "two users got different prefixes" "$([ "$P1" != "$P2" ] && echo yes || echo no)" "yes"

upload() { # upload <cookie> -> body+code
  curl -s -w "\n%{http_code}" -b "picbed_session=$1" -X POST -F "file=@${SCRIPT_TMP}/st.png" --noproxy '*' "$BASE/api/upload"
}
jid() { echo "$1" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d.split('\n')[0]).id)}catch(e){console.log('')}})"; }

# ---- 1. first upload lands in <prefix>/1/ with an 8-char id -------------
R=$(upload "$C1"); CODE=$(echo "$R" | tail -1); IMG1=$(jid "$R")
check "upload 1 -> 201" "$CODE" "201"
SP=$(dq "SELECT storage_path FROM images WHERE public_id='$IMG1'")
check "prefix segment" "$(echo "$SP" | cut -d/ -f1)" "$P1"
check "bucket segment 1" "$(echo "$SP" | cut -d/ -f2)" "1"
check "name is 8 chars + ext" "$(echo "$SP" | cut -d/ -f3 | grep -cE '^[0-9a-z]{8}\.png$')" "1"
check "images.name == path basename" "$(dq "SELECT name FROM images WHERE public_id='$IMG1'")" "$(echo "$SP" | cut -d/ -f3)"
check "dir_id set" "$(yesno "$([ -n "$(dq "SELECT dir_id FROM images WHERE public_id='$IMG1'")" ] && echo 1)")" "yes"
check "storage_dirs row created" "$(dq "SELECT bucket||':'||file_count FROM storage_dirs WHERE owner_key='$P1'")" "1:1"
check "level-1 folder cached" "$(yesno "$([ -n "$(dq "SELECT root_folder_id FROM storage_dirs WHERE owner_key='$P1'")" ] && echo 1)")" "yes"
check "level-2 folder cached" "$(yesno "$([ -n "$(dq "SELECT drive_folder_id FROM storage_dirs WHERE owner_key='$P1'")" ] && echo 1)")" "yes"
check "only expected shards for this prefix" "$(dq "SELECT COUNT(*) FROM storage_dirs WHERE owner_key='$P1' AND bucket NOT IN (1,2)")" "0"

# ---- 2. second upload reuses the same shard ----------------------------
R=$(upload "$C1"); IMG2=$(jid "$R")
check "upload 2 -> 201" "$(echo "$R" | tail -1)" "201"
check "upload 2 same bucket" "$(dq "SELECT storage_path FROM images WHERE public_id='$IMG2'" | cut -d/ -f2)" "1"
check "same-prefix counter = 2" "$(dq "SELECT file_count FROM storage_dirs WHERE owner_key='$P1' AND bucket=1")" "2"
check "names are distinct" "$([ "$(dq "SELECT name FROM images WHERE public_id='$IMG1'")" != "$(dq "SELECT name FROM images WHERE public_id='$IMG2'")" ] && echo yes || echo no)" "yes"

# ---- 3. API surface ----------------------------------------------------
META=$(curl -s --noproxy '*' "$BASE/api/meta")
check "meta max_files_per_dir" "$(echo "$META" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).storage.max_files_per_dir)}catch(e){console.log('?')}})")" "255"
check "meta capacity" "$(echo "$META" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const s=JSON.parse(d).storage;console.log(s.max_dirs_per_prefix*s.max_files_per_dir)}catch(e){console.log('?')}})")" "65025"
check "meta layout template" "$(echo "$META" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).storage.layout.includes('[0:4]')?'yes':'no')}catch(e){console.log('?')}})")" "yes"
check "image api exposes storage_path" "$(curl -s --noproxy '*' -b "picbed_session=$C1" "$BASE/api/images/$IMG1" | grep -c '"storage_path":"'"$P1"'/1/')" "1"

# admin session (needed by the page + guards below); asserted here while the
# shard table is still short enough to be fully rendered
reg admin@example.com adminpass1234
CA=$(login admin@example.com adminpass1234)
check "admin cookie" "$([ -n "$CA" ] && echo yes)" "yes"
check "admin page lists the prefix" "$(curl -s --noproxy '*' -b "picbed_session=$CA" "$BASE/admin/storage" | grep -E -c ">$P1<")" "1"
check "admin page shows shard counters" "$(curl -s --noproxy '*' -b "picbed_session=$CA" "$BASE/admin/storage" | grep -c '已用槽位')" "1"
check "version 1.28.0" "$(curl -s --noproxy '*' "$BASE/healthz" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).version)}catch(e){console.log('?')}})")" "1.28.0"

# ---- 4. 255-file cap rolls over to the next shard ----------------------
wrangler d1 execute cf-picbed-db --local --command "UPDATE storage_dirs SET file_count = 255 WHERE owner_key='$P1' AND bucket=1;" > /dev/null 2>&1
R=$(upload "$C1"); IMG3=$(jid "$R")
check "upload 3 -> 201" "$(echo "$R" | tail -1)" "201"
check "full shard rolls over to bucket 2" "$(dq "SELECT storage_path FROM images WHERE public_id='$IMG3'" | cut -d/ -f2)" "2"
check "bucket 1 untouched at 255" "$(dq "SELECT file_count FROM storage_dirs WHERE owner_key='$P1' AND bucket=1")" "255"
check "bucket 2 created with 1" "$(dq "SELECT file_count FROM storage_dirs WHERE owner_key='$P1' AND bucket=2")" "1"
check "prefix now owns 2 shards" "$(dq "SELECT COUNT(*) FROM storage_dirs WHERE owner_key='$P1'")" "2"

# ---- 5. recount rebuilds counters from the images table ----------------
wrangler d1 execute cf-picbed-db --local --command "UPDATE storage_dirs SET file_count = 99 WHERE owner_key='$P1';" > /dev/null 2>&1
curl -s -o /dev/null --noproxy '*' -b "picbed_session=$CA" -X POST "$BASE/admin/storage/recount"
check "recount bucket 1 = 2 images" "$(dq "SELECT file_count FROM storage_dirs WHERE owner_key='$P1' AND bucket=1")" "2"
check "recount bucket 2 = 1 image" "$(dq "SELECT file_count FROM storage_dirs WHERE owner_key='$P1' AND bucket=2")" "1"

# ---- 6. purge frees the slot, soft delete does not --------------------
curl -s -o /dev/null --noproxy '*' -b "picbed_session=$C1" -X POST "$BASE/images/$IMG3/delete"
check "soft delete keeps the slot" "$(dq "SELECT file_count FROM storage_dirs WHERE owner_key='$P1' AND bucket=2")" "1"
curl -s -o /dev/null --noproxy '*' -b "picbed_session=$C1" -X POST "$BASE/images/$IMG3/purge"
check "purge frees the slot" "$(dq "SELECT file_count FROM storage_dirs WHERE owner_key='$P1' AND bucket=2")" "0"

# ---- 7. hard cap: 255 full shards -> 507 storage_full -----------------
wrangler d1 execute cf-picbed-db --local --command "INSERT INTO storage_dirs (owner_key, bucket, file_count) WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < 255) SELECT '$P2', n, 255 FROM seq;" > /dev/null 2>&1
check "seeded 255 full shards" "$(dq "SELECT COUNT(*) FROM storage_dirs WHERE owner_key='$P2' AND file_count=255")" "255"
R=$(upload "$C2"); CODE=$(echo "$R" | tail -1)
check "overflow -> 507" "$CODE" "507"
check "overflow code storage_full" "$(echo "$R" | head -1 | grep -c 'storage_full')" "1"
check "overflow wrote no image row" "$(dq "SELECT COUNT(*) FROM images WHERE user_id=(SELECT id FROM users WHERE email='$E2')")" "0"
check "overflow added no shard" "$(dq "SELECT COUNT(*) FROM storage_dirs WHERE owner_key='$P2'")" "255"

# ---- 8. admin page + guards -------------------------------------------
check "admin storage page 200" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' -b "picbed_session=$CA" "$BASE/admin/storage")" "200"
check "non-admin 403" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' -b "picbed_session=$C1" "$BASE/admin/storage")" "403"
check "recount needs admin" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' -b "picbed_session=$C1" -X POST "$BASE/admin/storage/recount")" "403"
check "migrate bad limit refused" "$(curl -s -o /dev/null -w '%{redirect_url}' --noproxy '*' -b "picbed_session=$CA" -X POST -d 'limit=0' "$BASE/admin/storage/migrate" | grep -c 'err=bad_limit')" "1"
check "admin link on /admin" "$(curl -s --noproxy '*' -b "picbed_session=$CA" "$BASE/admin" | grep -c 'href="/admin/storage"')" "1"

# ---- 9. legacy migration --------------------------------------------
FID=$(dq "SELECT drive_file_id FROM images WHERE public_id='$IMG1'")
NODE_USE_ENV_PROXY=1 node tests/mk-legacy.mjs "$FID" > "${SCRIPT_TMP}"/mklegacy.log 2>&1
check "legacy file moved back to root" "$(grep -c 'legacy:' "${SCRIPT_TMP}/mklegacy.log")" "1"
wrangler d1 execute cf-picbed-db --local --command "UPDATE images SET dir_id = NULL, storage_path = NULL, name = 'legacyfl00r0000000000000000000000.png' WHERE public_id = '$IMG1';" > /dev/null 2>&1
check "staged legacy row" "$(dq "SELECT COUNT(*) FROM images WHERE dir_id IS NULL AND public_id = '$IMG1'")" "1"
LOC=$(curl -s -o /dev/null -w '%{redirect_url}' --noproxy '*' -b "picbed_session=$CA" -X POST -d 'limit=5' "$BASE/admin/storage/migrate")
check "migrate redirects with a count" "$(echo "$LOC" | grep -cE 'msg=migrated&m=[0-9]+')" "1"
check "legacy row now sharded" "$(yesno "$([ -n "$(dq "SELECT dir_id FROM images WHERE public_id='$IMG1'")" ] && echo 1)")" "yes"
check "legacy row renamed to 8 chars" "$(dq "SELECT name FROM images WHERE public_id='$IMG1'" | grep -cE '^[0-9a-z]{8}\.png$')" "1"
check "legacy row path written" "$(dq "SELECT storage_path FROM images WHERE public_id='$IMG1'" | cut -d/ -f1)" "$P1"
check "download still works" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' -b "picbed_session=$C1" "$BASE/i/$IMG1")" "200"

# second pass must leave the already-sharded row alone
NEWNAME=$(dq "SELECT name FROM images WHERE public_id='$IMG1'")
curl -s -o /dev/null --noproxy '*' -b "picbed_session=$CA" -X POST -d 'limit=5' "$BASE/admin/storage/migrate"
check "migrate is idempotent" "$(dq "SELECT name FROM images WHERE public_id='$IMG1'")" "$NEWNAME"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
