#!/usr/bin/env bash

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
export SCRIPT_TMP="$SCRIPT_ROOT/tmp"
mkdir -p "$SCRIPT_TMP" || exit 1
# v1.22 data portability test — manifest export (CSV/JSON) and URL-list import.
set -u
cd "$(dirname "$0")/.."
PORT=8787
BASE="http://127.0.0.1:$PORT"
PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1"; PASS=$((PASS+1)); else echo "FAIL  $1 (got:$2 want:$3)"; FAIL=$((FAIL+1)); fi; }

. ./tests/_schema.sh   # shared idempotent DDL (local D1 persists between suites)
wrangler d1 execute cf-picbed-db --local --command "DELETE FROM rate_limits; DELETE FROM sessions; DELETE FROM images; DELETE FROM users WHERE email LIKE '%example.com';" > /dev/null 2>&1
wrangler d1 execute cf-picbed-db --local --command "CREATE TABLE IF NOT EXISTS share_links (id INTEGER PRIMARY KEY AUTOINCREMENT, image_id INTEGER NOT NULL, token TEXT NOT NULL UNIQUE, created_by INTEGER NOT NULL, expires_at TEXT, views INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));" > /dev/null 2>&1
wrangler d1 execute cf-picbed-db --local --command "CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, actor_email TEXT, action TEXT NOT NULL, target TEXT, detail TEXT, ip TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));" > /dev/null 2>&1
wrangler d1 execute cf-picbed-db --local --command "DELETE FROM invite_codes; INSERT OR IGNORE INTO users (email,password_hash,password_salt,display_name,role) VALUES ('seed-admin@example.com','x','x','SeedAdmin','admin'); INSERT INTO invite_codes (code,created_by,max_uses,used_count,note) VALUES ('SEEDDATA',(SELECT id FROM users WHERE email='seed-admin@example.com'),100,0,'data-seed');" > /dev/null 2>&1
INVITE="SEEDDATA"

wrangler pages dev --binding ADMIN_EMAILS=admin@example.com --port $PORT > "${SCRIPT_TMP}"/cfpicbed-dev-data.log 2>&1 &
DEV_PID=$!
trap 'kill $DEV_PID 2>/dev/null' EXIT
for i in $(seq 1 40); do curl -sf --max-time 2 "$BASE/healthz" | grep -q '"ok"' && break; sleep 1; done

TS=$(date +%s)
EMAIL="d${TS}@example.com"
echo "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" | base64 -d > "${SCRIPT_TMP}"/data.png
COOKIE=$(curl -s -D - -o /dev/null --noproxy '*' -X POST -d "email=$EMAIL&password=test1234&invite_code=$INVITE" "$BASE/register" | grep -i '^set-cookie: picbed_session' | head -1 | sed 's/^[Ss]et-[Cc]ookie: picbed_session=\([^;]*\).*/\1/')
check "register ok" "$([ -n "$COOKIE" ] && echo yes || echo no)" "yes"

# three images; the middle one is renamed to a CSV-hostile name afterwards
# (a comma inside curl's -F filename would be parsed as a file separator).
for n in plain.png mid.png third.png; do
  curl -s -b "picbed_session=$COOKIE" -X POST -F "file=@${SCRIPT_TMP}/data.png;filename=$n" --noproxy '*' "$BASE/api/upload" > /dev/null
done
MID=$(wrangler d1 execute cf-picbed-db --local --command "SELECT public_id i FROM images WHERE original_name='mid.png';" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d)[0].results[0].i)}catch(e){console.log('0')}})")
curl -s -b "picbed_session=$COOKIE" -X POST --noproxy '*' "$BASE/images/$MID/rename" -d 'name=a,b"c.png' > /dev/null
NIMG=$(wrangler d1 execute cf-picbed-db --local --command "SELECT COUNT(*) c FROM images WHERE deleted=0;" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d)[0].results[0].c)}catch(e){console.log(0)}})")
check "three images uploaded" "$NIMG" "3"
check "hostile name stored verbatim" "$(wrangler d1 execute cf-picbed-db --local --command "SELECT COUNT(*) c FROM images WHERE original_name='a,b\"c.png';" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d)[0].results[0].c)}catch(e){console.log(0)}})")" "1"

# ---- page ----
check "data page 200" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" --noproxy '*' "$BASE/data")" "200"
check "data page unauth 302" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "$BASE/data")" "302"
D=$(curl -s -b "picbed_session=$COOKIE" --noproxy '*' "$BASE/data")
check "data page export card" "$(echo "$D" | grep -c '下载 CSV')" "1"
check "data page json button" "$(echo "$D" | grep -c '下载 JSON')" "1"
check "data page import box" "$(echo "$D" | grep -c 'id=\"imp\"')" "1"
check "data page shows image count" "$(echo "$D" | grep -c "<b>$NIMG</b> 张图片")" "1"
check "nav has data link" "$(curl -s -b "picbed_session=$COOKIE" --noproxy '*' "$BASE/gallery" | grep -c 'href=\"/data\"')" "1"

# ---- export CSV ----
CSVH=$(curl -s -D - -o "${SCRIPT_TMP}"/export.csv -b "picbed_session=$COOKIE" --noproxy '*' "$BASE/api/export?format=csv")
check "csv content-type" "$(echo "$CSVH" | grep -ci 'content-type: text/csv')" "1"
check "csv attachment header" "$(echo "$CSVH" | grep -ci 'content-disposition: attachment; filename=\"cf-picbed-')" "1"
check "csv has BOM" "$(head -c 3 ${SCRIPT_TMP}/export.csv | od -An -tx1 | tr -d ' ')" "efbbbf"
check "csv header row" "$(tail -c +4 ${SCRIPT_TMP}/export.csv | head -1 | tr -d '\r')" "id,original_name,mime_type,size_bytes,visibility,views,shares,live_shares,created_at"
check "csv row count" "$(tail -n +2 ${SCRIPT_TMP}/export.csv | grep -c .)" "3"
check "csv quotes comma+quote name" "$(grep -c '\"a,b\"\"c.png\"' ${SCRIPT_TMP}/export.csv)" "1"
check "csv has no drive id column" "$(grep -c 'drive_file_id' ${SCRIPT_TMP}/export.csv)" "0"

# ---- export JSON ----
JH=$(curl -s -D - -o "${SCRIPT_TMP}"/export.json -b "picbed_session=$COOKIE" --noproxy '*' "$BASE/api/export?format=json")
check "json content-type" "$(echo "$JH" | grep -ci 'content-type: application/json')" "1"
check "json attachment header" "$(echo "$JH" | grep -ci 'content-disposition: attachment')" "1"
check "json item count" "$(node -e "const j=require(process.env.SCRIPT_TMP + '/export.json');console.log(j.items.length)")" "3"
check "json account summary" "$(node -e "const j=require(process.env.SCRIPT_TMP + '/export.json');console.log(j.account.images)")" "3"
VER=$(curl -s --noproxy '*' "$BASE/healthz" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).version)}catch(e){console.log('?')}})")
check "json has version" "$(node -e "const j=require(process.env.SCRIPT_TMP + '/export.json');console.log(j.version)")" "$VER"
check "json leaks no drive id" "$(grep -c 'drive_file_id' ${SCRIPT_TMP}/export.json)" "0"
check "json leaks no key" "$(grep -c 'key_hash\|pb_live_' ${SCRIPT_TMP}/export.json)" "0"
check "export unauth 401" "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "$BASE/api/export")" "401"

# ---- import ----
IMP() { curl -s -b "picbed_session=$COOKIE" -X POST -H 'content-type: application/json' -d "$1" --noproxy '*' "$BASE/api/import"; }
check "import unauth 401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"text":"https://example.com/a.png"}' --noproxy '*' "$BASE/api/import")" "401"
check "import empty 400" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" -X POST -H 'content-type: application/json' -d '{"text":"   "}' --noproxy '*' "$BASE/api/import")" "400"
check "import garbage 400 no_items" "$(IMP '{"text":"this is not a url"}' | grep -c '"error":"no_items"')" "1"
check "import bad json 400" "$(IMP '{"text":"[1,2"}' | grep -c '"error":"bad_json"')" "1"

# private address must be refused per-row, not crash the batch
BLK=$(IMP '{"text":"http://127.0.0.1:8787/i/1.png"}')
check "import ssrf row refused" "$(echo "$BLK" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(j.imported+'/'+j.failed)}catch(e){console.log('err')}})")" "0/1"
check "import row carries error code" "$(echo "$BLK" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(j.results[0].ok===false && !!j.results[0].error ? 'yes':'no')}catch(e){console.log('err')}})")" "yes"

# CSV text: header row skipped, name + visibility columns parsed
CSVIP=$(IMP '{"text":"url,name,visibility\nhttp://127.0.0.1/a.png,甲,public\nhttp://127.0.0.1/b.png,乙\n# comment\nhttps://127.0.0.1/c.png"}')
check "import csv requested count" "$(echo "$CSVIP" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).requested)}catch(e){console.log(-1)}})")" "3"
check "import csv keeps 3 rows" "$(echo "$CSVIP" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).results.length)}catch(e){console.log(-1)}})")" "3"

# JSON items payload accepted directly
JIMP=$(IMP '{"items":[{"url":"http://127.0.0.1/x.png","name":"x"},{"url":"http://127.0.0.1/y.png"}]}')
check "import json items count" "$(echo "$JIMP" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).requested)}catch(e){console.log(-1)}})")" "2"

# cap: 50 rows max per call
MANY=$(node -e "const a=[];for(let i=0;i<60;i++)a.push('http://127.0.0.1/'+i+'.png');console.log(JSON.stringify({text:a.join('\\n')}))")
check "import capped at 50" "$(IMP "$MANY" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).requested)}catch(e){console.log(-1)}})")" "50"

# docs + meta surface the endpoints
check "docs export endpoint" "$(curl -s -b "picbed_session=$COOKIE" --noproxy '*' "$BASE/docs" | grep -c '/api/export?format=csv|json')" "1"
check "docs import endpoint" "$(curl -s -b "picbed_session=$COOKIE" --noproxy '*' "$BASE/docs" | grep -c '/api/import')" "1"
check "meta lists data endpoints" "$(curl -s --noproxy '*' "$BASE/api/meta" | grep -c '"data":')" "1"

wrangler d1 execute cf-picbed-db --local --command "DELETE FROM images; DELETE FROM rate_limits;" > /dev/null 2>&1

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ]
