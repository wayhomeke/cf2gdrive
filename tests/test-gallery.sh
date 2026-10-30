#!/usr/bin/env bash

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
export SCRIPT_TMP="$SCRIPT_ROOT/tmp"
mkdir -p "$SCRIPT_TMP" || exit 1
# v0.6 gallery + rename + delete test. Self-contained.
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
wrangler d1 execute cf-picbed-db --local --command "DELETE FROM rate_limits; DELETE FROM sessions; DELETE FROM images; DELETE FROM users WHERE email LIKE '%example.com';" > /dev/null 2>&1
# v1.12: ensure images.exif exists (idempotent; harmless failure if already present)
wrangler d1 execute cf-picbed-db --local --command "ALTER TABLE images ADD COLUMN exif TEXT;" > /dev/null 2>&1
# v1.13: ensure share_links exists (idempotent)
wrangler d1 execute cf-picbed-db --local --command "CREATE TABLE IF NOT EXISTS share_links (id INTEGER PRIMARY KEY AUTOINCREMENT, image_id INTEGER NOT NULL REFERENCES images (id) ON DELETE CASCADE, token TEXT NOT NULL UNIQUE, created_by INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE, expires_at TEXT, views INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now'))); CREATE INDEX IF NOT EXISTS idx_shares_token ON share_links (token); CREATE INDEX IF NOT EXISTS idx_shares_image ON share_links (image_id);" > /dev/null 2>&1
# v1.18: ensure audit_log exists (idempotent)
wrangler d1 execute cf-picbed-db --local --command "CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, actor_email TEXT, action TEXT NOT NULL, target TEXT, detail TEXT, ip TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))); CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at);" > /dev/null 2>&1

# v1.2: registration is invite-only — seed a usable code directly in D1
wrangler d1 execute cf-picbed-db --local --command "DELETE FROM invite_codes; INSERT OR IGNORE INTO users (email,password_hash,password_salt,display_name,role) VALUES ('seed-admin@example.com','x','x','SeedAdmin','admin'); INSERT INTO invite_codes (code,created_by,max_uses,used_count,note) VALUES ('SEEDGAL',(SELECT id FROM users WHERE email='seed-admin@example.com'),100,0,'test-seed');" > /dev/null 2>&1
INVITE="SEEDGAL"

wrangler pages dev --binding ADMIN_EMAILS=admin@example.com --port $PORT > "${SCRIPT_TMP}"/cfpicbed-dev.log 2>&1 &
DEV_PID=$!
trap 'kill $DEV_PID 2>/dev/null' EXIT
for i in $(seq 1 40); do curl -sf --max-time 2 "$BASE/healthz" | grep -q '"ok"' && break; sleep 1; done

TS=$(date +%s)
EMAIL="g${TS}@example.com"
echo "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" | base64 -d > "${SCRIPT_TMP}"/test.png

COOKIE=$(curl -s -D - -o /dev/null -X POST -d "email=$EMAIL&password=test1234&invite_code=$INVITE" "$BASE/register" | grep -i '^set-cookie: picbed_session' | head -1 | sed 's/^[Ss]et-[Cc]ookie: picbed_session=\([^;]*\).*/\1/')
[ -n "$COOKIE" ] && { echo "PASS  register+cookie"; PASS=$((PASS+1)); } || { echo "FAIL  register+cookie"; FAIL=$((FAIL+1)); }

# upload 3 images
IDS=()
for i in 1 2 3; do
  RESP=$(curl -s -b "picbed_session=$COOKIE" -X POST -F "file=@${SCRIPT_TMP}/test.png;filename=pic$i.png" "$BASE/api/upload")
  ID=$(echo "$RESP" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).id)}catch(e){console.log('')}})")
  IDS+=("$ID")
done
check "3 uploads ok" "${#IDS[@]}" "3"

# gallery page renders 3 cells
G=$(curl -s -b "picbed_session=$COOKIE" "$BASE/gallery")
check "gallery 200" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" "$BASE/gallery")" "200"
CELLS=$(echo "$G" | grep -o 'class="cell"' | wc -l | tr -d ' ')
check "gallery shows 3 cells" "$CELLS" "3"
check "gallery shows stats" "$(echo "$G" | grep -c '配额使用')" "1"
check "gallery shows pic2 name" "$(echo "$G" | grep -c 'pic2.png')" "3"

# rename image 2
CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "picbed_session=$COOKIE" -X POST -d "name=renamed-pic.png" "$BASE/images/${IDS[1]}/rename")
check "rename 200" "$CODE" "200"
NM=$(wrangler d1 execute cf-picbed-db --local --command "SELECT original_name FROM images WHERE public_id='${IDS[1]}';" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d)[0].results[0].original_name)}catch(e){console.log('err')}})")
check "renamed in db" "$NM" "renamed-pic.png"
check "gallery shows new name" "$(curl -s -b "picbed_session=$COOKIE" "$BASE/gallery" | grep -c 'renamed-pic.png')" "3"

# delete image 3
CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "picbed_session=$COOKIE" -X POST "$BASE/images/${IDS[2]}/delete")
check "delete 200" "$CODE" "200"
DEL=$(wrangler d1 execute cf-picbed-db --local --command "SELECT deleted FROM images WHERE public_id='${IDS[2]}';" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d)[0].results[0].deleted)}catch(e){console.log('err')}})")
check "deleted flag in db" "$DEL" "1"
USED=$(wrangler d1 execute cf-picbed-db --local --command "SELECT used_bytes FROM users WHERE email='$EMAIL';" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d)[0].results[0].used_bytes)}catch(e){console.log('err')}})")
check "quota refunded (140=2x70)" "$USED" "140"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "picbed_session=$COOKIE" "$BASE/i/${IDS[2]}")
check "deleted image serves 410" "$CODE" "410"
CELLS=$(curl -s -b "picbed_session=$COOKIE" "$BASE/gallery" | grep -o 'class="cell"' | wc -l | tr -d ' ')
check "gallery shows 2 cells after delete" "$CELLS" "2"

# gallery without login -> 302
check "gallery no-auth 302" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/gallery")" "302"

# delete non-existent -> 404
check "delete missing 404" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" -X POST "$BASE/images/999999/delete")" "404"

# v1.5: thumbnails — gallery binds /t/, Drive-rendered, same gate as /i/
G2=$(curl -s -b "picbed_session=$COOKIE" "$BASE/gallery")
check "gallery cells use /t/ thumbnails" "$(echo "$G2" | grep -Eo 'src="/t/[0-9a-f]{12}"' | wc -l | tr -d ' ')" "2"
check "gallery cells keep /i/ link" "$(echo "$G2" | grep -Eo 'href="/i/[0-9a-f]{12}"' | wc -l | tr -d ' ')" "2"
check "gallery imgs async decode" "$(echo "$G2" | grep -o 'decoding="async"' | wc -l | tr -d ' ')" "2"
TCT=$(curl -s -o "${SCRIPT_TMP}"/thumb.bin -w '%{content_type}' -b "picbed_session=$COOKIE" "$BASE/t/${IDS[0]}")
check "thumb content-type image/*" "$(echo "$TCT" | cut -d/ -f1)" "image"
TSZ=$(wc -c < "${SCRIPT_TMP}"/thumb.bin | tr -d ' ')
[ "$TSZ" -gt 0 ] && { echo "PASS  thumb bytes served ($TSZ B)"; PASS=$((PASS+1)); } || { echo "FAIL  thumb bytes ($TSZ)"; FAIL=$((FAIL+1)); }
check "thumb cache-control private 7d" "$(curl -s -D - -o /dev/null -b "picbed_session=$COOKIE" "$BASE/t/${IDS[0]}" | grep -i '^cache-control' | tr -d '\r' | grep -c 'private, max-age=604800')" "1"
check "thumb anon 403" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/t/${IDS[0]}")" "403"
check "thumb deleted 410" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" "$BASE/t/${IDS[2]}")" "410"
check "thumb missing 404" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" "$BASE/t/999999")" "404"
check "thumb 304 on etag" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" -H "if-none-match: W/\"t${IDS[0]}-70\"" "$BASE/t/${IDS[0]}")" "304"
check "favicon 200" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/favicon.ico")" "200"
check "favicon svg" "$(curl -s "$BASE/favicon.ico" | grep -c '<svg')" "1"
check "layout links favicon" "$(echo "$G2" | grep -c 'rel="icon"')" "1"

# v1.7: lightbox + keyboard/touch navigation
check "gallery lightbox container" "$(echo "$G2" | grep -c 'id="lightbox"')" "1"
check "gallery openLb fn" "$(echo "$G2" | grep -c 'function openLb')" "1"
check "gallery keyboard handlers" "$(echo "$G2" | grep -o 'ArrowRight' | wc -l | tr -d ' ')" "1"
check "gallery lightbox dataset" "$(echo "$G2" | grep -c 'const IMGS = \[{')" "1"
check "gallery cell opens lightbox" "$(echo "$G2" | grep -o 'onclick="openLb(0);return false"' | wc -l | tr -d ' ')" "1"
check "gallery lightbox info bar" "$(echo "$G2" | grep -o 'id="lbmeta"' | wc -l | tr -d ' ')" "1"

# v1.10: search + visibility filter + sort
check "gallery filter bar" "$(echo "$G2" | grep -c 'class="filterbar"')" "1"
check "gallery search input" "$(echo "$G2" | grep -o 'name="q"' | wc -l | tr -d ' ')" "1"
check "gallery vis filter select" "$(echo "$G2" | grep -o '<select name="vis"' | wc -l | tr -d ' ')" "1"
check "gallery sort select" "$(echo "$G2" | grep -o 'name="sort"' | wc -l | tr -d ' ')" "1"
check "gallery result line" "$(echo "$G2" | grep -c 'class="resultline"')" "1"
check "gallery result count" "$(echo "$G2" | grep -o '共 <b>2</b> 张图片' | wc -l | tr -d ' ')" "1"
# search by name (renamed-pic.png survives; pic1.png also present)
check "search q=renamed 1 cell" "$(curl -s -b "picbed_session=$COOKIE" "$BASE/gallery?q=renamed" | grep -o 'class="cell"' | wc -l | tr -d ' ')" "1"
check "search q=renamed shows name" "$(curl -s -b "picbed_session=$COOKIE" "$BASE/gallery?q=renamed" | grep -c 'renamed-pic.png')" "3"
check "search q=pic matches both" "$(curl -s -b "picbed_session=$COOKIE" "$BASE/gallery?q=pic" | grep -o 'class="cell"' | wc -l | tr -d ' ')" "2"
check "search no match empty state" "$(curl -s -b "picbed_session=$COOKIE" "$BASE/gallery?q=zzzznomatch" | grep -c '没有匹配的图片')" "1"
check "search no match clear link" "$(curl -s -b "picbed_session=$COOKIE" "$BASE/gallery?q=zzzznomatch" | grep -o '清除筛选条件' | wc -l | tr -d ' ')" "1"
# LIKE metacharacters are literal, not wildcards
check "search percent literal" "$(curl -s -G --data-urlencode "q=%" -b "picbed_session=$COOKIE" "$BASE/gallery" | grep -c '没有匹配的图片')" "1"
check "search underscore literal" "$(curl -s -G --data-urlencode "q=_" -b "picbed_session=$COOKIE" "$BASE/gallery" | grep -c '没有匹配的图片')" "1"
check "search injection literal" "$(curl -s -G --data-urlencode "q=' OR 1=1--" -b "picbed_session=$COOKIE" "$BASE/gallery" | grep -c '没有匹配的图片')" "1"
# visibility filter (both survivors are private)
check "vis all 2 cells" "$(curl -s -b "picbed_session=$COOKIE" "$BASE/gallery?vis=all" | grep -o 'class="cell"' | wc -l | tr -d ' ')" "2"
check "vis public empty" "$(curl -s -b "picbed_session=$COOKIE" "$BASE/gallery?vis=public" | grep -c '没有匹配的图片')" "1"
check "vis private 2 cells" "$(curl -s -b "picbed_session=$COOKIE" "$BASE/gallery?vis=private" | grep -o 'class="cell"' | wc -l | tr -d ' ')" "2"
# sort: oldest first = pic1 (lowest id), newest first = renamed-pic
check "sort oldest first pic1" "$(curl -s -b "picbed_session=$COOKIE" "$BASE/gallery?sort=oldest" | grep -Eo 'class="cell" data-id="[0-9a-f]{12}"' | head -1 | grep -Eo '[0-9a-f]{12}')" "${IDS[0]}"
check "sort newest first pic2" "$(curl -s -b "picbed_session=$COOKIE" "$BASE/gallery?sort=newest" | grep -Eo 'class="cell" data-id="[0-9a-f]{12}"' | head -1 | grep -Eo '[0-9a-f]{12}')" "${IDS[1]}"
check "sort default first pic2" "$(curl -s -b "picbed_session=$COOKIE" "$BASE/gallery" | grep -Eo 'class="cell" data-id="[0-9a-f]{12}"' | head -1 | grep -Eo '[0-9a-f]{12}')" "${IDS[1]}"
# invalid values fall back safely (no 500)
check "bad sort 200" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" "$BASE/gallery?sort=bogus")" "200"
check "bad vis 200" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" "$BASE/gallery?vis=bogus")" "200"
check "bad sort still lists" "$(curl -s -b "picbed_session=$COOKIE" "$BASE/gallery?sort=bogus" | grep -o 'class="cell"' | wc -l | tr -d ' ')" "2"
# active filter is echoed into the form + result line
check "filter bar echoes q" "$(curl -s -b "picbed_session=$COOKIE" "$BASE/gallery?q=renamed" | grep -o 'value="renamed"' | wc -l | tr -d ' ')" "1"
check "result line shows keyword" "$(curl -s -b "picbed_session=$COOKIE" "$BASE/gallery?q=renamed" | grep -o '关键词「renamed」' | wc -l | tr -d ' ')" "1"
check "clear link only when active" "$(echo "$G2" | grep -o 'class="clear"' | wc -l | tr -d ' ')" "0"
check "clear link present when active" "$(curl -s -b "picbed_session=$COOKIE" "$BASE/gallery?q=renamed" | grep -o 'class="clear"' | wc -l | tr -d ' ')" "1"

# v1.13: share links — cell button + modal + nav
check "gallery share buttons" "$(echo "$G2" | grep -o 'onclick="shareImg(' | wc -l | tr -d ' ')" "2"
check "gallery share modal" "$(echo "$G2" | grep -c 'id="shmodal"')" "1"
check "gallery share options" "$(echo "$G2" | grep -o 'shareCreate(7)' | wc -l | tr -d ' ')" "1"
check "gallery share never option" "$(echo "$G2" | grep -o 'shareCreate(0)' | wc -l | tr -d ' ')" "1"
check "nav shares link" "$(echo "$G2" | grep -o 'href="/shares"' | wc -l | tr -d ' ')" "1"
# create a share from the UI path and check the page renders it
SHURL=$(curl -s -b "picbed_session=$COOKIE" -X POST -H 'content-type: application/json' -d '{"expires_in_days":7}' "$BASE/api/images/${IDS[0]}/share" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).url)}catch(e){console.log('')}})")
[ -n "$SHURL" ] && { echo "PASS  gallery share create via api"; PASS=$((PASS+1)); } || { echo "FAIL  gallery share create via api"; FAIL=$((FAIL+1)); }
check "shares page lists it" "$(curl -s -b "picbed_session=$COOKIE" "$BASE/shares" | grep -c "${SHURL#/s/}")" "2"

# ---- v1.20: multi-select UI + batch flows ----
dbq() { wrangler d1 execute cf-picbed-db --local --command "$1" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const r=JSON.parse(d)[0].results;console.log(Object.values(r[0]||{})[0])}catch(e){console.log('err')}})"; }
GCELLS=$(echo "$G2" | grep -o 'class="cell"' | wc -l | tr -d ' ')
check "gallery selbar rendered" "$(echo "$G2" | grep -c 'id="selbar"')" "1"
check "gallery pick checkboxes match cells" "$(echo "$G2" | grep -o 'class="pick"' | wc -l | tr -d ' ')" "$GCELLS"
check "gallery grid has id" "$(echo "$G2" | grep -c 'class="grid" id="grid"')" "1"
check "gallery batch vis buttons" "$(echo "$G2" | grep -oE "batchVis\('(public|private)'\)" | wc -l | tr -d ' ')" "2"
check "gallery batch delete wired" "$(echo "$G2" | grep -c 'onclick="batchDel()"')" "1"
check "gallery select-all wired" "$(echo "$G2" | grep -c 'onclick="selAll()"')" "1"
check "gallery shift-range select" "$(echo "$G2" | grep -c 'e.shiftKey')" "1"
check "gallery esc clears selection" "$(echo "$G2" | grep -c "Escape' && lbIdx < 0")" "1"

# batch visibility: both live images -> public
BIDS=$(wrangler d1 execute cf-picbed-db --local --command "SELECT group_concat(public_id) g FROM images WHERE deleted=0;" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d)[0].results[0].g)}catch(e){console.log('')}})")
SQBIDS=$(node -e "console.log('$BIDS'.split(',').filter(Boolean).map(x=>\"'\"+x+\"'\").join(','))")
VISJSON=$(node -e "console.log(JSON.stringify({ids:'$BIDS'.split(',').filter(Boolean),visibility:'public'}))")
check "batch-visibility 200" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" -X POST -H 'content-type: application/json' -d "$VISJSON" "$BASE/api/images/batch-visibility")" "200"
check "batch-visibility updated count" "$(curl -s -b "picbed_session=$COOKIE" -X POST -H 'content-type: application/json' -d "$VISJSON" "$BASE/api/images/batch-visibility" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).updated)}catch(e){console.log(-1)}})")" "$GCELLS"
check "batch-visibility persisted" "$(dbq "SELECT COUNT(*) c FROM images WHERE deleted=0 AND visibility='public';")" "$GCELLS"

# batch delete -> trash page shows batch controls
DELJSON=$(curl -s -b "picbed_session=$COOKIE" -X POST -H 'content-type: application/json' -d "$VISJSON" "$BASE/api/images/batch-delete")
check "batch-delete 200" "$(echo "$DELJSON" | grep -c '"ok":true')" "1"
check "batch-delete affected all live rows" "$(echo "$DELJSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).deleted)}catch(e){console.log(-1)}})")" "$GCELLS"
check "the deleted ids are now in trash" "$(dbq "SELECT COUNT(*) c FROM images WHERE deleted=1 AND public_id IN ($SQBIDS);")" "$GCELLS"
T=$(curl -s -b "picbed_session=$COOKIE" "$BASE/trash")
TCELLS=$(echo "$T" | grep -o 'class="cell"' | wc -l | tr -d ' ')
TDEL=$(dbq "SELECT COUNT(*) c FROM images WHERE deleted=1;")
check "trash cell count matches db" "$TCELLS" "$TDEL"
check "trash selbar rendered" "$(echo "$T" | grep -c 'id="selbar"')" "1"
check "trash pick checkboxes match cells" "$(echo "$T" | grep -o 'class="pick"' | wc -l | tr -d ' ')" "$TCELLS"
check "trash batch restore wired" "$(echo "$T" | grep -c 'onclick="batchRestore()"')" "1"
check "trash batch purge wired" "$(echo "$T" | grep -c 'onclick="batchPurge()"')" "1"

# batch restore one -> back to live, quota credited
RID=$(wrangler d1 execute cf-picbed-db --local --command "SELECT MIN(public_id) i FROM images WHERE deleted=1 AND public_id IN ($SQBIDS);" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d)[0].results[0].i)}catch(e){console.log('')}})")
RJSON=$(node -e "console.log(JSON.stringify({ids:['$RID']}))")
check "batch-restore 200" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" -X POST -H 'content-type: application/json' -d "$RJSON" "$BASE/api/images/batch-restore")" "200"
check "restored row is live" "$(dbq "SELECT deleted FROM images WHERE public_id='$RID';")" "0"
# batch purge the rest -> only the purged ids disappear
check "batch-purge 200" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" -X POST -H 'content-type: application/json' -d "$VISJSON" "$BASE/api/images/batch-purge")" "200"
check "restored row survives batch-purge" "$(dbq "SELECT COUNT(*) c FROM images WHERE public_id = '$RID';")" "1"
check "other purged ids gone" "$(dbq "SELECT COUNT(*) c FROM images WHERE deleted=1 AND public_id IN ($SQBIDS);")" "0"

# cleanup drive files
DRIVE_IDS=$(wrangler d1 execute cf-picbed-db --local --command "SELECT group_concat(drive_file_id) g FROM images;" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d)[0].results[0].g)}catch(e){console.log('')}})")
if [ -n "$DRIVE_IDS" ]; then
  NODE_USE_ENV_PROXY=1 node --input-type=module -e "
    const m = await import('./src/drive.js');

    const env = process.env;
    for (const id of '$DRIVE_IDS'.split(',')) { try { await m.deleteFile(env, id); } catch(e) {} }
    console.log('drive cleanup done');
  "
  echo "PASS  cleanup"; PASS=$((PASS+1))
else
  echo "FAIL  cleanup (no drive ids)"; FAIL=$((FAIL+1))
fi
wrangler d1 execute cf-picbed-db --local --command "DELETE FROM images; DELETE FROM rate_limits; DELETE FROM share_links;" > /dev/null 2>&1

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ]
