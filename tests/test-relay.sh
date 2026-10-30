#!/usr/bin/env bash

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
export SCRIPT_TMP="$SCRIPT_ROOT/tmp"
mkdir -p "$SCRIPT_TMP" || exit 1
# v1.26 文件中转 (file relay) — a feature deliberately unrelated to the gallery.
# Own table, own /f/<id> URLs, own trash, own per-user Drive folder.
set -u
cd "$(dirname "$0")/.."
PORT=8787
BASE="http://127.0.0.1:$PORT"
PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1"; PASS=$((PASS+1)); else echo "FAIL  $1 (got:$2 want:$3)"; FAIL=$((FAIL+1)); fi; }
yesno() { [ -n "$1" ] && echo yes || echo no; }

. ./tests/_schema.sh   # shared idempotent DDL (local D1 persists between suites)
wrangler d1 execute cf-picbed-db --local --command "DELETE FROM rate_limits; DELETE FROM sessions; DELETE FROM relay_files; DELETE FROM user_folders; DELETE FROM images; DELETE FROM users WHERE email LIKE '%example.com';" > /dev/null 2>&1

wrangler pages dev --binding ADMIN_EMAILS=admin@example.com --port $PORT > "${SCRIPT_TMP}"/cfpicbed-dev-relay.log 2>&1 &
DEV_PID=$!
trap 'kill $DEV_PID 2>/dev/null' EXIT
for i in $(seq 1 40); do curl -sf --noproxy '*' --max-time 2 "$BASE/healthz" | grep -q '"ok"' && break; sleep 1; done

TS=$(date +%s)
EMAIL="r${TS}@example.com"
wrangler d1 execute cf-picbed-db --local --command "DELETE FROM invite_codes; INSERT OR IGNORE INTO users (email,password_hash,password_salt,display_name,role) VALUES ('seed-relay@example.com','x','x','SeedRelay','admin'); INSERT INTO invite_codes (code,created_by,max_uses,used_count,note) VALUES ('RELAYSEED',(SELECT id FROM users WHERE email='seed-relay@example.com'),100,0,'relay-seed');" > /dev/null 2>&1
INVITE="RELAYSEED"

printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' | base64 -d > "${SCRIPT_TMP}"/relay.png
printf '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' > "${SCRIPT_TMP}"/relay.svg

COOKIE=$(curl -s -D - -o /dev/null --noproxy '*' -X POST -d "email=$EMAIL&password=test1234&invite_code=$INVITE" "$BASE/register" | grep -i '^set-cookie: picbed_session' | head -1 | sed 's/^[Ss]et-[Cc]ookie: picbed_session=\([^;]*\).*/\1/')
check "register ok" "$([ -n "$COOKIE" ] && echo yes || echo no)" "yes"

# warm-up upload (first Drive round trip after boot can be slow)
curl -s -o /dev/null --max-time 90 --noproxy '*' -b "picbed_session=$COOKIE" -X POST -F "file=@${SCRIPT_TMP}/relay.png;filename=warm.png" "$BASE/api/relay/upload"

UP() { curl -s --max-time 90 --noproxy '*' -b "picbed_session=$COOKIE" -X POST -F "file=@${SCRIPT_TMP}/relay.png;filename=$1.png" -F "visibility=$2" "$BASE/api/relay/upload"; }
JID() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(j.id)}catch(e){console.log('')}})"; }

# ---- 1. upload returns a sequential id and a /f/ url ----
U1=$(UP relay-a private)
RID1=$(echo "$U1" | JID)
check "upload 201 shape" "$(printf '%s' "$RID1" | grep -Ec '^[0-9]+$')" "1"
check "upload url is /f/<id>" "$(echo "$U1" | grep -c "\"url\":\"/f/$RID1\"")" "1"
check "upload echoes storage path" "$(echo "$U1" | grep -c '"storage_path":"')" "1"
FOLDER=$(echo "$U1" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).folder)}catch(e){console.log('')}})")
check "folder named after the email" "$FOLDER" "r$TS-at-example-com"
check "storage path is folder/file" "$(echo "$U1" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(j.storage_path.startsWith(j.folder+'/')?'yes':'no')}catch(e){console.log('err')}})")" "yes"

# second upload must not reuse the id
U2=$(UP relay-b public)
RID2=$(echo "$U2" | JID)
check "second id differs" "$([ -n "$RID2" ] && [ "$RID2" != "$RID1" ] && echo yes || echo no)" "yes"
check "second id is next-ish (sequential, not random)" "$([ "$RID2" -gt "$RID1" ] && echo yes || echo no)" "yes"

# ---- 2. serving ----
check "private relay 403 anon" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "$BASE/f/$RID1")" "403"
check "private relay 200 owner" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' -b "picbed_session=$COOKIE" "$BASE/f/$RID1")" "200"
check "public relay 200 anon" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "$BASE/f/$RID2")" "200"
check "relay serves image bytes" "$(curl -s --noproxy '*' -b "picbed_session=$COOKIE" "$BASE/f/$RID1" -o ${SCRIPT_TMP}/got.png -w '%{content_type}')" "image/png"
check "relay content is byte-identical" "$(cmp -s ${SCRIPT_TMP}/relay.png ${SCRIPT_TMP}/got.png && echo same || echo diff)" "same"
check "relay 404 for unknown id" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "$BASE/f/99999999")" "404"
check "relay 404 for non-numeric id" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "$BASE/f/abc")" "404"
check "relay has nosniff" "$(curl -s -D - -o /dev/null --noproxy '*' "$BASE/f/$RID2" | grep -ci 'x-content-type-options: nosniff')" "1"

# ---- 3. isolation from the gallery ----
check "relay id is not a gallery image" "$(wrangler d1 execute cf-picbed-db --local --command "SELECT COUNT(*) c FROM images WHERE id = $RID1;" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d)[0].results[0].c)}catch(e){console.log('err')}})")" "0"
check "relay file not in /i/" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "$BASE/i/$RID1")" "404"
GAL=$(curl -s --noproxy '*' "$BASE/gallery" || true)
check "gallery page does not list relay files" "$(echo "$GAL" | grep -c "/f/$RID1")" "0"

# ---- 4. rename / delete / restore / purge ----
RN=$(curl -s --noproxy '*' -b "picbed_session=$COOKIE" -X POST -d 'name=renamed-file.png' "$BASE/api/relay/$RID1/rename" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).name)}catch(e){console.log('')}})")
check "rename applied" "$RN" "renamed-file.png"
check "rename shows in list" "$(curl -s --noproxy '*' -b "picbed_session=$COOKIE" "$BASE/api/relay" | grep -c 'renamed-file.png')" "1"

DEL=$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' -b "picbed_session=$COOKIE" -X POST "$BASE/api/relay/$RID1/delete")
check "delete 200" "$DEL" "200"
check "deleted relay 410" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' -b "picbed_session=$COOKIE" "$BASE/f/$RID1")" "410"
check "deleted relay gone from live list" "$(curl -s --noproxy '*' -b "picbed_session=$COOKIE" "$BASE/api/relay" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(j.files.filter(f=>f.id===$RID1).length)}catch(e){console.log('err')}})")" "0"
check "deleted relay in trash list" "$(curl -s --noproxy '*' -b "picbed_session=$COOKIE" "$BASE/api/relay?filter=trash" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(j.files.filter(f=>f.id===$RID1).length)}catch(e){console.log('err')}})")" "1"

RS=$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' -b "picbed_session=$COOKIE" -X POST "$BASE/api/relay/$RID1/restore")
check "restore 200" "$RS" "200"
check "restored relay serves again" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' -b "picbed_session=$COOKIE" "$BASE/f/$RID1")" "200"
check "double restore 400" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' -b "picbed_session=$COOKIE" -X POST "$BASE/api/relay/$RID1/restore")" "400"

PG=$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' -b "picbed_session=$COOKIE" -X POST "$BASE/api/relay/$RID1/purge")
check "purge 200" "$PG" "200"
check "purged relay 404" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' -b "picbed_session=$COOKIE" "$BASE/f/$RID1")" "404"

# ---- 5. ownership isolation ----
TS2=$(date +%s)
curl -s -o /dev/null --noproxy '*' -X POST -d "email=other${TS2}@example.com&password=test1234&invite_code=$INVITE" "$BASE/register"
KEY2=$(curl -s --noproxy '*' -X POST -d "email=other${TS2}@example.com&password=test1234" "$BASE/login" >/dev/null; curl -s --noproxy '*' -b "picbed_session=$(curl -s -D - -o /dev/null --noproxy '*' -X POST -d "email=other${TS2}@example.com&password=test1234" "$BASE/login" | grep -i '^set-cookie: picbed_session' | head -1 | sed 's/^[Ss]et-[Cc]ookie: picbed_session=\([^;]*\).*/\1/')" "$BASE/api/keys" -X POST -H 'content-type: application/json' -d '{"name":"relay-other"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).key||JSON.parse(d).api_key||'')}catch(e){console.log('')}})")
PRIV=$(UP relay-private private | JID)
check "other user cannot read private relay" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' -H "Authorization: Bearer $KEY2" "$BASE/f/$PRIV")" "403"
check "public relay readable by anyone" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' -H "Authorization: Bearer $KEY2" "$BASE/f/$RID2")" "200"
check "other user cannot delete relay" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' -H "Authorization: Bearer $KEY2" -X POST "$BASE/api/relay/$PRIV/delete")" "404"
check "other user list is empty" "$(curl -s --noproxy '*' -H "Authorization: Bearer $KEY2" "$BASE/api/relay" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).total)}catch(e){console.log('err')}})")" "0"

# ---- 6. upload gates ----
check "svg rejected 415" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 90 --noproxy '*' -b "picbed_session=$COOKIE" -X POST -F "file=@${SCRIPT_TMP}/relay.svg;filename=x.svg" "$BASE/api/relay/upload")" "415"
check "missing file 400" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' -b "picbed_session=$COOKIE" -X POST "$BASE/api/relay/upload")" "400"
check "no auth 401" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' -X POST -F "file=@${SCRIPT_TMP}/relay.png" "$BASE/api/relay/upload")" "401"
check "bad rename 400" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' -b "picbed_session=$COOKIE" -X POST -d 'name=' "$BASE/api/relay/$RID2/rename")" "400"

# ---- 7. page + nav ----
P=$(curl -s --noproxy '*' -b "picbed_session=$COOKIE" "$BASE/files")
check "files page renders" "$(echo "$P" | grep -c '<h1>文件中转</h1>')" "1"
check "nav has 文件中转 after 图库" "$(echo "$P" | grep -oE '<a href="/gallery">图库</a><a href="/files">文件中转</a>' | wc -l | tr -d ' ')" "1"
check "files page lists /f/ links (thumb+anchor)" "$(echo "$P" | grep -Eoc "/f/$RID2")" "2"
check "files page has no /i/ links" "$(echo "$P" | grep -Eoc '/i/[0-9]+')" "0"
check "files page shows the folder (intro + every cell)" "$(echo "$P" | grep -o "$FOLDER" | wc -l | tr -d ' ' | awk '{print ($1>=3)?"yes":"no"}')" "yes"
check "trash tab present" "$(echo "$P" | grep -c 'filter=trash')" "1"
check "files page needs auth" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "$BASE/files")" "302"
T=$(curl -s --noproxy '*' -b "picbed_session=$COOKIE" "$BASE/files?filter=trash")
check "trash view renders" "$(echo "$T" | grep -c '中转回收站是空的')" "1"

# ---- 8. folder caching: a second upload must not re-create the folder ----
UF=$(wrangler d1 execute cf-picbed-db --local --command "SELECT COUNT(*) c FROM user_folders WHERE user_id = (SELECT id FROM users WHERE email='$EMAIL');" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d)[0].results[0].c)}catch(e){console.log('err')}})")
UP relay-c private > /dev/null
UF2=$(wrangler d1 execute cf-picbed-db --local --command "SELECT COUNT(*) c FROM user_folders WHERE user_id = (SELECT id FROM users WHERE email='$EMAIL');" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d)[0].results[0].c)}catch(e){console.log('err')}})")
check "one folder row per user" "$UF2" "1"
check "folder row existed before" "$UF" "1"

# ---- 9. quota (v1.33: dedicated relay quota) ----
wrangler d1 execute cf-picbed-db --local --command "UPDATE users SET relay_quota_bytes = 0 WHERE email='$EMAIL';" > /dev/null 2>&1
check "quota exceeded 413" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 90 --noproxy '*' -b "picbed_session=$COOKIE" -X POST -F "file=@${SCRIPT_TMP}/relay.png;filename=over.png" "$BASE/api/relay/upload")" "413"
check "failed upload left no row" "$(wrangler d1 execute cf-picbed-db --local --command "SELECT COUNT(*) c FROM relay_files WHERE original_name='over.png';" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d)[0].results[0].c)}catch(e){console.log('err')}})")" "0"
wrangler d1 execute cf-picbed-db --local --command "UPDATE users SET relay_quota_bytes = 1073741824 WHERE email='$EMAIL';" > /dev/null 2>&1

# ---- 10. batch ----
B1=$(UP batch-1 private | JID)
B2=$(UP batch-2 private | JID)
B3=$(UP batch-3 private | JID)
check "batch delete 2" "$(curl -s --noproxy '*' -b "picbed_session=$COOKIE" -X POST -H 'content-type: application/json' -d "{\"ids\":[$B1,$B2]}" "$BASE/api/relay/batch-delete" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).deleted)}catch(e){console.log('err')}})")" "2"
check "batch restore 2" "$(curl -s --noproxy '*' -b "picbed_session=$COOKIE" -X POST -H 'content-type: application/json' -d "{\"ids\":[$B1,$B2]}" "$BASE/api/relay/batch-restore" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).restored)}catch(e){console.log('err')}})")" "2"
check "batch purge 1" "$(curl -s --noproxy '*' -b "picbed_session=$COOKIE" -X POST -H 'content-type: application/json' -d "{\"ids\":[$B3,$B1]}" "$BASE/api/relay/batch-purge" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).purged)}catch(e){console.log('err')}})")" "1"
check "batch no ids 400" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' -b "picbed_session=$COOKIE" -X POST -H 'content-type: application/json' -d '{"ids":[]}' "$BASE/api/relay/batch-delete")" "400"
check "batch accepts numeric strings" "$(curl -s --noproxy '*' -b "picbed_session=$COOKIE" -X POST -H 'content-type: application/json' -d "{\"ids\":[\"$B1\"]}" "$BASE/api/relay/batch-delete" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).deleted)}catch(e){console.log('err')}})")" "1"
check "batch all-garbage ids 400" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' -b "picbed_session=$COOKIE" -X POST -H 'content-type: application/json' -d '{"ids":["abc",null,{}]}' "$BASE/api/relay/batch-delete")" "400"
check "batch unauth 401" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' -X POST -H 'content-type: application/json' -d '{"ids":[1]}' "$BASE/api/relay/batch-delete")" "401"

# ---- 11. upload UX & URL upload (v1.29) ----
# 11.1 SSRF protection: private IP blocked
check "url upload private ip 400" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' -b "picbed_session=$COOKIE" -X POST -H 'content-type: application/json' -d '{"url":"http://127.0.0.1:8787/test.png"}' "$BASE/api/relay/upload")" "400"
check "url upload bad scheme 400" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' -b "picbed_session=$COOKIE" -X POST -H 'content-type: application/json' -d '{"url":"ftp://example.com/test.png"}' "$BASE/api/relay/upload")" "400"
check "url upload missing url 400" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' -b "picbed_session=$COOKIE" -X POST -H 'content-type: application/json' -d '{"visibility":"public"}' "$BASE/api/relay/upload")" "400"

# 11.2 UI elements in /files page
FPAGE=$(curl -s --noproxy '*' -b "picbed_session=$COOKIE" "$BASE/files")
check "page has upzone" "$(echo "$FPAGE" | grep -c 'id=\"upzone\"')" "1"
check "page has file input" "$(echo "$FPAGE" | grep -c 'id=\"relayfileinput\"')" "1"
check "page has paste hint" "$(echo "$FPAGE" | grep -c 'Ctrl+V 粘贴截图')" "1"
check "page has url fetch box" "$(echo "$FPAGE" | grep -c 'id=\"upurlbox\"')" "1"

# ---- 12. search, sort & filter (v1.30) ----
check "filter by visibility public" "$(curl -s --noproxy '*' -b "picbed_session=$COOKIE" "$BASE/api/relay?visibility=public" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(j.files.every(f=>f.visibility==='public')?'yes':'no')}catch(e){console.log('err')}})")" "yes"
check "filter by visibility private" "$(curl -s --noproxy '*' -b "picbed_session=$COOKIE" "$BASE/api/relay?visibility=private" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(j.files.every(f=>f.visibility==='private')?'yes':'no')}catch(e){console.log('err')}})")" "yes"
check "search by keyword" "$(curl -s --noproxy '*' -b "picbed_session=$COOKIE" "$BASE/api/relay?q=batch" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(j.files.every(f=>f.name.includes('batch'))?'yes':'no')}catch(e){console.log('err')}})")" "yes"
check "sort by size" "$(curl -s --noproxy '*' -b "picbed_session=$COOKIE" "$BASE/api/relay?sort=size_desc" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(j.files.length>0?'yes':'no')}catch(e){console.log('err')}})")" "yes"
check "page has filterbar" "$(echo "$FPAGE" | grep -c 'class=\"filterbar\"')" "1"

# ---- 13. share links (v1.31) ----
SH_RESP=$(curl -s --noproxy '*' -b "picbed_session=$COOKIE" -X POST -H 'content-type: application/json' -d '{"days":7}' "$BASE/api/relay/$PRIV/share")
SH_TOKEN=$(echo "$SH_RESP" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).token)}catch(e){console.log('')}})")
SH_ID=$(echo "$SH_RESP" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).id)}catch(e){console.log('')}})")
check "create share token 22-char" "$(printf '%s' "$SH_TOKEN" | grep -Ec '^[A-Za-z0-9_-]{22}$')" "1"
check "share link anon 200" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "$BASE/f/s/$SH_TOKEN")" "200"
check "list shares has token" "$(curl -s --noproxy '*' -b "picbed_session=$COOKIE" "$BASE/api/relay/$PRIV/shares" | grep -c "$SH_TOKEN")" "1"
check "revoke share 200" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' -b "picbed_session=$COOKIE" -X DELETE "$BASE/api/relay/shares/$SH_ID")" "200"
check "revoked share 410" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "$BASE/f/s/$SH_TOKEN")" "410"

# ---- 14. arbitrary file types & attachment header (v1.32 & v2.2) ----
printf "PDF-1.4 mock content for relay file upload" > "${SCRIPT_TMP}"/relay-doc.pdf
DOC_U=$(curl -s --max-time 90 --noproxy '*' -b "picbed_session=$COOKIE" -X POST -F "file=@${SCRIPT_TMP}/relay-doc.pdf;filename=manual.pdf" -F "visibility=public" "$BASE/api/relay/upload")
DOC_ID=$(echo "$DOC_U" | JID)
check "upload pdf returns numeric id" "$([ -n "$DOC_ID" ] && echo yes || echo no)" "yes"
check "pdf response has attachment header" "$(curl -s -D - -o /dev/null --noproxy '*' "$BASE/f/$DOC_ID" | grep -i '^content-disposition:' | grep -c 'attachment')" "1"
check "pdf response has rfc5987 filename*" "$(curl -s -D - -o /dev/null --noproxy '*' "$BASE/f/$DOC_ID" | grep -i '^content-disposition:' | grep -c "filename\*=UTF-8''")" "1"
check "image response has inline header" "$(curl -s -D - -o /dev/null --noproxy '*' "$BASE/f/$RID2" | grep -i '^content-disposition:' | grep -c 'inline')" "1"
check "force download query param" "$(curl -s -D - -o /dev/null --noproxy '*' "$BASE/f/$RID2?download=1" | grep -i '^content-disposition:' | grep -c 'attachment')" "1"

# ---- 15. REST API & meta contract (v1.34 & v2.6) ----
check "batch visibility endpoint 200" "$(curl -s --noproxy '*' -b "picbed_session=$COOKIE" -X POST -H 'content-type: application/json' -d "{\"ids\":[$DOC_ID],\"visibility\":\"private\"}" "$BASE/api/relay/batch-visibility" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(j.ok?1:0)}catch(e){console.log(0)}})")" "1"
check "get single relay detail 200" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' -b "picbed_session=$COOKIE" "$BASE/api/relay/$RID2")" "200"
check "patch relay file name and vis" "$(curl -s --noproxy '*' -b "picbed_session=$COOKIE" -X PATCH -H 'content-type: application/json' -d '{"name":"api-patch.png","visibility":"public"}' "$BASE/api/relay/$RID2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(j.name+':'+j.visibility)}catch(e){console.log('err')}})")" "api-patch.png:public"
check "delete relay via REST DELETE 200" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' -b "picbed_session=$COOKIE" -X DELETE "$BASE/api/relay/$RID2")" "200"
check "meta contains relay contract" "$(curl -s --noproxy '*' "$BASE/api/meta" | grep -c 'relay')" "1"

# ---- 16. meta version ----
EXPECT_VER=$(grep -o 'const VERSION = "[^"]*"' "$(dirname "$0")/../src/index.js" | cut -d'"' -f2)
check "version matches index" "$(curl -s --noproxy '*' "$BASE/healthz" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).version)}catch(e){console.log('?')}})")" "$EXPECT_VER"

# ---- cleanup: purge the Drive objects we created ----
wrangler d1 execute cf-picbed-db --local --command "DELETE FROM relay_files; DELETE FROM user_folders; DELETE FROM rate_limits;" > /dev/null 2>&1
echo "drive cleanup best-effort (local dev Drive writes are real)"
echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ]
