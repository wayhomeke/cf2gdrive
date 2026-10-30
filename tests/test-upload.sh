#!/usr/bin/env bash

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
export SCRIPT_TMP="$SCRIPT_ROOT/tmp"
mkdir -p "$SCRIPT_TMP" || exit 1
# v0.4 upload pipeline test against local wrangler dev. Self-contained.
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

# clean slate for deterministic rate-limit + quota behaviour
wrangler d1 execute cf-picbed-db --local --command "DELETE FROM rate_limits; DELETE FROM sessions; DELETE FROM images; DELETE FROM users WHERE email LIKE '%example.com';" > /dev/null 2>&1
# v1.12: ensure images.exif exists (idempotent; harmless failure if already present)
wrangler d1 execute cf-picbed-db --local --command "ALTER TABLE images ADD COLUMN exif TEXT;" > /dev/null 2>&1
# v1.13: ensure share_links exists (idempotent)
wrangler d1 execute cf-picbed-db --local --command "CREATE TABLE IF NOT EXISTS share_links (id INTEGER PRIMARY KEY AUTOINCREMENT, image_id INTEGER NOT NULL REFERENCES images (id) ON DELETE CASCADE, token TEXT NOT NULL UNIQUE, created_by INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE, expires_at TEXT, views INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now'))); CREATE INDEX IF NOT EXISTS idx_shares_token ON share_links (token); CREATE INDEX IF NOT EXISTS idx_shares_image ON share_links (image_id);" > /dev/null 2>&1
# v1.18: ensure audit_log exists (idempotent)
wrangler d1 execute cf-picbed-db --local --command "CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, actor_email TEXT, action TEXT NOT NULL, target TEXT, detail TEXT, ip TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))); CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at);" > /dev/null 2>&1

# v1.2: registration is invite-only — seed a usable code directly in D1
wrangler d1 execute cf-picbed-db --local --command "DELETE FROM invite_codes; INSERT OR IGNORE INTO users (email,password_hash,password_salt,display_name,role) VALUES ('seed-admin@example.com','x','x','SeedAdmin','admin'); INSERT INTO invite_codes (code,created_by,max_uses,used_count,note) VALUES ('SEEDUP',(SELECT id FROM users WHERE email='seed-admin@example.com'),100,0,'test-seed');" > /dev/null 2>&1
INVITE="SEEDUP"

wrangler pages dev --binding ADMIN_EMAILS=admin@example.com --port $PORT > "${SCRIPT_TMP}"/cfpicbed-dev.log 2>&1 &
DEV_PID=$!
trap 'kill $DEV_PID 2>/dev/null' EXIT

for i in $(seq 1 40); do
  curl -sf --max-time 2 "$BASE/healthz" | grep -q '"ok"' && break
  sleep 1
done

TS=$(date +%s)
EMAIL="u${TS}@example.com"
# 1x1 red PNG, 70 bytes
PNG_B64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
echo "$PNG_B64" | base64 -d > "${SCRIPT_TMP}"/test.png

# 1. register + cookie
COOKIE=$(curl -s -D - -o /dev/null -X POST -d "email=$EMAIL&password=test1234&invite_code=$INVITE" "$BASE/register" | grep -i '^set-cookie: picbed_session' | head -1 | sed 's/^[Ss]et-[Cc]ookie: picbed_session=\([^;]*\).*/\1/')
[ -n "$COOKIE" ] && { echo "PASS  register+cookie"; PASS=$((PASS+1)); } || { echo "FAIL  register+cookie"; FAIL=$((FAIL+1)); }

# 2. upload without auth -> 401
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST -F "file=@${SCRIPT_TMP}/test.png" "$BASE/api/upload")
check "upload no-auth 401" "$CODE" "401"

# 3. upload real PNG -> 201
RESP=$(curl -s -w "\n%{http_code}" -b "picbed_session=$COOKIE" -X POST -F "file=@${SCRIPT_TMP}/test.png" "$BASE/api/upload")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | head -1)
check "upload png 201" "$CODE" "201"
IMG_ID=$(echo "$BODY" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).id)}catch(e){console.log('')}})")
check "upload returns id" "$([ -n "$IMG_ID" ] && echo yes || echo no)" "yes"

# 4. DB row + quota
ROW=$(wrangler d1 execute cf-picbed-db --local --command "SELECT count(*) c, sum(size_bytes) s FROM images;" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const r=JSON.parse(d)[0].results[0];console.log(r.c+':'+r.s)}catch(e){console.log('err')}})")
check "d1 image row" "$ROW" "1:70"
QUOTA=$(wrangler d1 execute cf-picbed-db --local --command "SELECT used_bytes FROM users WHERE email='$EMAIL';" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d)[0].results[0].used_bytes)}catch(e){console.log('err')}})")
check "quota used_bytes=70" "$QUOTA" "70"

# 5. serve via /i/:id
CODE=$(curl -s -o "${SCRIPT_TMP}"/served.png -w "%{http_code}" -b "picbed_session=$COOKIE" "http://127.0.0.1:8787/i/$IMG_ID")
check "serve owner 200" "$CODE" "200"
MD5_LOCAL=$(md5 -q "${SCRIPT_TMP}"/test.png)
MD5_SERVED=$(md5 -q "${SCRIPT_TMP}"/served.png)
check "served bytes identical" "$MD5_SERVED" "$MD5_LOCAL"
CT=$(curl -s -D - -o /dev/null -b "picbed_session=$COOKIE" "http://127.0.0.1:8787/i/$IMG_ID" | grep -i '^content-type' | tr -d '\r' | awk '{print $2}')
check "content-type" "$CT" "image/png"
CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:8787/i/$IMG_ID")
check "serve anon 403 (private)" "$CODE" "403"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Range: bytes=0-9" -b "picbed_session=$COOKIE" "http://127.0.0.1:8787/i/$IMG_ID")
check "serve range 206" "$CODE" "206"
PART=$(curl -s -H "Range: bytes=0-9" -b "picbed_session=$COOKIE" "http://127.0.0.1:8787/i/$IMG_ID" | md5 -q)
WANT=$(head -c 10 "${SCRIPT_TMP}"/test.png | md5 -q)
check "range bytes correct" "$PART" "$WANT"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -I -b "picbed_session=$COOKIE" "http://127.0.0.1:8787/i/$IMG_ID")
check "serve HEAD 200" "$CODE" "200"

# 6. non-image rejected -> 415
echo "this is not an image" > "${SCRIPT_TMP}"/fake.png
CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "picbed_session=$COOKIE" -X POST -F "file=@${SCRIPT_TMP}/fake.png" "$BASE/api/upload")
check "fake image 415" "$CODE" "415"

# 7. quota exceeded -> 413
wrangler d1 execute cf-picbed-db --local --command "UPDATE users SET quota_bytes=10 WHERE email='$EMAIL';" > /dev/null 2>&1
CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "picbed_session=$COOKIE" -X POST -F "file=@${SCRIPT_TMP}/test.png" "$BASE/api/upload")
check "quota exceeded 413" "$CODE" "413"
wrangler d1 execute cf-picbed-db --local --command "UPDATE users SET quota_bytes=1073741824 WHERE email='$EMAIL';" > /dev/null 2>&1

# 8. v1.6: upload page quota awareness
UP=$(curl -s -b "picbed_session=$COOKIE" "$BASE/upload")
check "upload page quota bar" "$(echo "$UP" | grep -c 'class="qbar"')" "1"
check "upload page skip logic" "$(echo "$UP" | grep -c '已跳过：超出剩余配额')" "1"
check "upload page quota constants" "$(echo "$UP" | grep -c 'Q_USED = 70, Q_TOTAL = 1073741824')" "1"
# near-limit: quota 75 vs used 70 -> 93% -> warning colors on the bar
wrangler d1 execute cf-picbed-db --local --command "UPDATE users SET quota_bytes=75 WHERE email='$EMAIL';" > /dev/null 2>&1
UP2=$(curl -s -b "picbed_session=$COOKIE" "$BASE/upload")
check "near-limit remaining red" "$(echo "$UP2" | grep -c 'color:#dc2626">5 B<')" "1"
check "near-limit bar amber" "$(echo "$UP2" | grep -c 'background:#f59e0b')" "1"
check "upload blocked when projected over" "$(curl -s -o /dev/null -w '%{http_code}' -b "picbed_session=$COOKIE" -X POST -F "file=@${SCRIPT_TMP}/test.png" "$BASE/api/upload")" "413"
wrangler d1 execute cf-picbed-db --local --command "UPDATE users SET quota_bytes=1073741824 WHERE email='$EMAIL';" > /dev/null 2>&1

# v1.12: EXIF extraction on upload (JPEG APP1) + PNG dimensions + lightbox wiring
cat > "${SCRIPT_TMP}"/make-exif.mjs <<'NODE'
import { writeFileSync } from 'node:fs';
const u16 = (n) => [n & 0xff, (n >> 8) & 0xff];
const u32 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
const asc = (s) => [...Buffer.from(s, 'ascii'), 0];
// TIFF layout (offsets relative to TIFF start):
//   0 header | 8 IFD0(4 entries,54B) | 62 ExifIFD(6 entries,78B) | 140 GPS IFD(4 entries,54B) | 194 data
// ExifIFD is referenced by tag 0x8769 (the standard way), not the IFD chain.
const O = { make: 194, model: 202, dt: 208, latref: 228, lonref: 230, lat: 232, lon: 256, exp: 280, fn: 288 };
const t = [];
t.push(0x49, 0x49, 0x2a, 0x00, ...u32(8));                       // II, magic, IFD0@8
t.push(...u16(4));                                                // IFD0: 4 entries
t.push(...u16(0x010f), ...u16(2), ...u32(8), ...u32(O.make));     // Make ASCII
t.push(...u16(0x0110), ...u16(2), ...u32(6), ...u32(O.model));    // Model ASCII
t.push(...u16(0x8769), ...u16(4), ...u32(1), ...u32(62));         // ExifIFD pointer
t.push(...u16(0x8825), ...u16(4), ...u32(1), ...u32(140));        // GPS IFD pointer
t.push(...u32(62));                                               // next -> ExifIFD
t.push(...u16(6));                                                // ExifIFD: 6 entries
t.push(...u16(0x829a), ...u16(5), ...u32(1), ...u32(O.exp));      // ExposureTime 1/125
t.push(...u16(0x829d), ...u16(5), ...u32(1), ...u32(O.fn));       // FNumber 14/5
t.push(...u16(0x8827), ...u16(3), ...u32(1), ...u16(400), 0, 0);  // ISO 400 inline
t.push(...u16(0x9003), ...u16(2), ...u32(20), ...u32(O.dt));      // DateTimeOriginal
t.push(...u16(0xa002), ...u16(3), ...u32(1), ...u16(1600), 0, 0); // PixelXDimension
t.push(...u16(0xa003), ...u16(3), ...u32(1), ...u16(1200), 0, 0); // PixelYDimension
t.push(...u32(0));
t.push(...u16(4));                                                // GPS IFD: 4 entries
t.push(...u16(0x0001), ...u16(2), ...u32(2), ...u32(O.latref));   // LatRef "N"
t.push(...u16(0x0002), ...u16(5), ...u32(3), ...u32(O.lat));      // Latitude DMS
t.push(...u16(0x0003), ...u16(2), ...u32(2), ...u32(O.lonref));   // LonRef "E"
t.push(...u16(0x0004), ...u16(5), ...u32(3), ...u32(O.lon));      // Longitude DMS
t.push(...u32(0));
t.push(...asc('TestCam'), ...asc('X-100'), ...asc('2024:05:01 12:00:00'), ...asc('N'), ...asc('E'));
t.push(...u32(22), ...u32(1), ...u32(32), ...u32(1), ...u32(30), ...u32(1));  // 22°32'30"N
t.push(...u32(114), ...u32(1), ...u32(3), ...u32(1), ...u32(45), ...u32(1));  // 114°03'45"E
t.push(...u32(1), ...u32(125));                                   // exposure 1/125s
t.push(...u32(14), ...u32(5));                                    // f/2.8
const app1 = [...Buffer.from('Exif\0\0', 'ascii'), ...t];
const segLen = app1.length + 2;
writeFileSync(process.env.SCRIPT_TMP + '/exif.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe1, (segLen >> 8) & 0xff, segLen & 0xff, ...app1, 0xff, 0xd9]));
NODE
node "${SCRIPT_TMP}"/make-exif.mjs
RESP2=$(curl -s -w "\n%{http_code}" -b "picbed_session=$COOKIE" -X POST -F "file=@${SCRIPT_TMP}/exif.jpg;filename=photo.jpg" "$BASE/api/upload")
check "upload exif jpeg 201" "$(echo "$RESP2" | tail -1)" "201"
EXIF_ID=$(echo "$RESP2" | head -1 | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).id)}catch(e){console.log('')}})")
exifget() { curl -s -b "picbed_session=$COOKIE" "$BASE/api/images/$EXIF_ID" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const e=JSON.parse(d).exif||{};let v=e['$1'];if(Array.isArray(v))v=v.join(',');console.log(v===undefined?'null':v)}catch(e){console.log('err')}})"; }
check "exif camera" "$(exifget camera)" "TestCam X-100"
check "exif exposure" "$(exifget exposure)" "1/125s"
check "exif fnumber" "$(exifget fnumber)" "f/2.8"
check "exif iso" "$(exifget iso)" "400"
check "exif taken_at" "$(exifget taken_at)" "2024-05-01 12:00:00"
check "exif width" "$(exifget width)" "1600"
check "exif height" "$(exifget height)" "1200"
check "exif gps" "$(exifget gps)" "22.541667,114.0625"
check "exif list api includes it" "$(curl -s -b "picbed_session=$COOKIE" "$BASE/api/images" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).images.some(i=>i.exif&&i.exif.camera==='TestCam X-100')?'yes':'no')}catch(e){console.log('err')}})" )" "yes"
# PNG: no EXIF tags -> exif object carries IHDR dimensions only, camera absent
check "png exif camera null" "$(curl -s -b "picbed_session=$COOKIE" "$BASE/api/images/$IMG_ID" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const e=JSON.parse(d).exif||{};console.log(e.camera===undefined?'null':e.camera)}catch(e){console.log('err')}})" )" "null"
check "png dims from ihdr" "$(curl -s -b "picbed_session=$COOKIE" "$BASE/api/images/$IMG_ID" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const e=JSON.parse(d).exif;console.log(e?e.width+'x'+e.height:'none')}catch(e){console.log('err')}})" )" "1x1"
# gallery lightbox wiring
G3=$(curl -s -b "picbed_session=$COOKIE" "$BASE/gallery")
check "gallery lbexif element" "$(echo "$G3" | grep -c 'id="lbexif"')" "1"
check "gallery lbData carries exif" "$(echo "$G3" | grep -o '"exif":{"camera"' | wc -l | tr -d ' ')" "1"
# cleanup the exif test image (drive + d1)
EXIF_DRIVE=$(wrangler d1 execute cf-picbed-db --local --command "SELECT drive_file_id FROM images WHERE public_id='$EXIF_ID';" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d)[0].results[0].drive_file_id)}catch(e){console.log('')}})")
if [ -n "$EXIF_DRIVE" ]; then
  NODE_USE_ENV_PROXY=1 node --input-type=module -e "
    const m = await import('./src/drive.js');

    const env = process.env;
    await m.deleteFile(env, '$EXIF_DRIVE');
  " 2>/dev/null
  wrangler d1 execute cf-picbed-db --local --command "DELETE FROM images WHERE public_id='$EXIF_ID';" > /dev/null 2>&1
  echo "PASS  exif image cleanup"; PASS=$((PASS+1))
fi

# 9. cleanup: remove test image from Drive + D1
DRIVE_ID=$(wrangler d1 execute cf-picbed-db --local --command "SELECT drive_file_id FROM images WHERE public_id='$IMG_ID';" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d)[0].results[0].drive_file_id)}catch(e){console.log('')}})")
if [ -n "$DRIVE_ID" ]; then
  NODE_USE_ENV_PROXY=1 node -e "
    const m = await import('./src/drive.js');

    const env = process.env;
    await m.deleteFile(env, '$DRIVE_ID');
    console.log('drive file deleted');
  " --input-type=module 2>/dev/null || node --input-type=module -e "
    const m = await import('./src/drive.js');

    const env = process.env;
    await m.deleteFile(env, '$DRIVE_ID');
    console.log('drive file deleted');
  "
  wrangler d1 execute cf-picbed-db --local --command "DELETE FROM images WHERE public_id='$IMG_ID'; UPDATE users SET used_bytes=0 WHERE email='$EMAIL';" > /dev/null 2>&1
  echo "PASS  cleanup (drive + d1)"; PASS=$((PASS+1))
else
  echo "FAIL  cleanup (no drive id)"; FAIL=$((FAIL+1))
fi

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ]
