#!/usr/bin/env bash

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
export SCRIPT_TMP="$SCRIPT_ROOT/tmp"
mkdir -p "$SCRIPT_TMP" || exit 1
# v1.20 performance guard — asserts the hot queries keep using indexes and that
# the admin/audit pages stay on a single batched D1 round trip.
set -u
cd "$(dirname "$0")/.."
PORT=8787
BASE="http://127.0.0.1:$PORT"
PASS=0; FAIL=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1"; PASS=$((PASS+1)); else echo "FAIL  $1 (got:$2 want:$3)"; FAIL=$((FAIL+1)); fi; }

. ./tests/_schema.sh   # shared idempotent DDL (local D1 persists between suites)

# Schema must declare every index the queries rely on.
for idx in idx_images_user_created_id idx_images_user_vis idx_images_trash idx_images_sweep idx_shares_creator; do
  check "schema declares $idx" "$(grep -c "$idx" schema.sql)" "1"
done

# Apply schema locally so the plan check runs against the shipped DDL.
wrangler d1 execute cf-picbed-db --local --file=schema.sql > /dev/null 2>&1
NIDX=$(wrangler d1 execute cf-picbed-db --local --command "SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%';" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d)[0].results[0].c)}catch(e){console.log(0)}})")
check "index count >= 17" "$([ "${NIDX:-0}" -ge 17 ] && echo yes || echo no)" "yes"

# plan() runs EXPLAIN QUERY PLAN and prints the joined detail lines.
plan() {
  wrangler d1 execute cf-picbed-db --local --command "EXPLAIN QUERY PLAN $1" --json 2>/dev/null | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  try { console.log(JSON.parse(d)[0].results.map(r=>r.detail).join(' | ')); } catch(e) { console.log('parse-error'); }
});"
}
has() { case "$1" in *"$2"*) echo yes;; *) echo no;; esac; }

P1=$(plan "SELECT id FROM images WHERE user_id = 1 AND deleted = 0 AND visibility = 'public' ORDER BY created_at DESC, id DESC LIMIT 24")
check "vis filter uses idx_images_user_vis" "$(has "$P1" "idx_images_user_vis")" "yes"
check "vis filter no temp b-tree" "$(has "$P1" "TEMP B-TREE")" "no"

P2=$(plan "SELECT id FROM images WHERE user_id = 1 AND deleted = 1 ORDER BY deleted_at DESC")
check "trash list uses idx_images_trash" "$(has "$P2" "idx_images_trash")" "yes"
check "trash list no temp b-tree" "$(has "$P2" "TEMP B-TREE")" "no"

P3=$(plan "SELECT id FROM images WHERE deleted = 1 AND deleted_at IS NOT NULL AND julianday(deleted_at) < julianday('2026-01-01')")
check "cron sweep no full table scan" "$(has "$P3" "SCAN images")" "no"
check "cron sweep uses idx_images_sweep" "$(has "$P3" "idx_images_sweep")" "yes"

P4=$(plan "SELECT COUNT(*) FROM share_links WHERE created_by = 1 AND revoked = 0")
check "share count uses idx_shares_creator" "$(has "$P4" "idx_shares_creator")" "yes"
check "share count no full table scan" "$(has "$P4" "SCAN share_links")" "no"

P5=$(plan "SELECT id FROM images WHERE user_id = 1 AND deleted = 0 ORDER BY created_at DESC, id DESC LIMIT 24")
check "default sort uses index (no temp b-tree)" "$(has "$P5" "TEMP B-TREE")" "no"

# Source-level guards for the batched reads.
check "admin uses one batched query" "$(grep -c 'const \[usersRes, sysRes, invitesRes\] = await env.DB.batch' src/index.js)" "1"
check "audit page batches listing+histogram" "$(grep -c 'auditActionsStatement(env),' src/index.js)" "1"
check "audit listing carries total via window fn" "$(grep -c 'COUNT(\*) OVER () AS total_count' src/audit.js)" "1"
check "audit single-query path has count fallback" "$(grep -c 'data.unknown' src/audit.js)" "2"

# Live smoke (dev server on 8787; started by the caller or by this script).
if ! curl -sf --max-time 2 "$BASE/healthz" | grep -q '"ok"'; then
  wrangler pages dev --binding ADMIN_EMAILS=admin@example.com --port $PORT > "${SCRIPT_TMP}"/cfpicbed-dev-perf.log 2>&1 &
  DEV_PID=$!
  trap 'kill $DEV_PID 2>/dev/null' EXIT
  for i in $(seq 1 40); do curl -sf --max-time 2 "$BASE/healthz" | grep -q '"ok"' && break; sleep 1; done
fi
check "healthz 200" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/healthz")" "200"
check "meta reports batch_max_ids" "$(curl -s --max-time 5 "$BASE/api/meta" | grep -c '"batch_max_ids":100')" "1"
check "version >= 1.20" "$(curl -s --max-time 5 "$BASE/healthz" | grep -c '"version":"1.2')" "1"

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ]
