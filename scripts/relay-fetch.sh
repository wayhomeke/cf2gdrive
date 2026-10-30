#!/usr/bin/env bash

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
export SCRIPT_TMP="$SCRIPT_ROOT/tmp"
mkdir -p "$SCRIPT_TMP" || exit 1
# relay-fetch.sh — 分片下载 → 自动合并 → 校验（命令行版）
#
# 用途：在链路不稳或文件较大时，不再赌一次完整下载，而是按服务端返回的
#       manifest 逐片 Range 拉取，最后合并并做 SHA-256 校验。
#
# 特性：
#   * 逐片重试（默认 6 次，指数退避并封顶）
#   * 断点续传（两级）：
#       1) 分片级 — 已存在且大小正确的分片自动跳过
#       2) 分片内 — 已存在但残缺的分片，只补拉缺失的尾部字节并追加，
#          不再整片重下（v2.34.0：跨境链路上短读频繁，整片重下代价极高）
#   * 可选并发 JOBS（默认 1，串行；慢链路调 4~6 通常能显著提速）
#   * 合并后与服务端 X-Checksum-Sha256 / manifest.checksum / SRC_SHA 比对
#   * 失败时明确报告是哪一片出问题，而不是静默产出损坏文件
#
# 用法：
#   COOKIE=<picbed_session> bash scripts/relay-fetch.sh <file_id> [output_path]
#   BASE=http://localhost:8787 RETRIES=6 JOBS=4 bash scripts/relay-fetch.sh 42 ./out.bin
#   SRC_SHA=<hex> 上传端的原始 SHA-256；服务端 manifest.checksum 为空时用它兜底校验
#
# 依赖：curl、shasum、node

set -u

BASE="${BASE:-http://localhost:8787}"
COOKIE="${COOKIE:-}"
ID="${1:-}"
OUT="${2:-}"
RETRIES="${RETRIES:-6}"
JOBS="${JOBS:-1}"
# 上传端原始 SHA-256（可选）。本次若未声明客户端校验和，manifest.checksum 会为空，
# 此时用它做端到端比对，避免出现“下载成功但内容无人验证”的盲区。
SRC_SHA="${SRC_SHA:-}"
# 分片大小（MiB）。大文件用更大的片可显著减少请求数，上限 16。
CHUNK_MB="${CHUNK_MB:-8}"
WORK="${WORK:-${SCRIPT_TMP}/relay-fetch/$ID}"

if [ -z "$ID" ]; then
  echo "用法: COOKIE=<session> bash scripts/relay-fetch.sh <file_id> [output_path]"
  exit 1
fi
if [ -z "$COOKIE" ]; then
  echo "错误: 需要 COOKIE 环境变量（picbed_session），manifest 接口要求登录态"
  exit 1
fi

mkdir -p "$WORK"

echo "=================================================================="
echo " 中转文件分片下载 · 自动合并 · 校验"
echo "=================================================================="
echo "目标: $BASE  文件 ID: $ID  分片目录: $WORK  并发: $JOBS  重试: $RETRIES"
echo ""

# ---------- 1. 获取 manifest ----------
MF="$WORK/manifest.json"
HTTP=$(curl -s --noproxy '*' -m 60 -o "$MF" -w '%{http_code}' -b "picbed_session=$COOKIE" "$BASE/api/relay/$ID/manifest?chunk_mb=$CHUNK_MB")
if [ "$HTTP" != "200" ]; then
  echo "获取 manifest 失败 (HTTP $HTTP): $(cat "$MF")"
  exit 1
fi

SIZE=$(node -e "const j=require('$MF');console.log(j.size)")
NAME=$(node -e "const j=require('$MF');console.log(j.name)")
COUNT=$(node -e "const j=require('$MF');console.log(j.count)")
WANT=$(node -e "const j=require('$MF');console.log(j.checksum||'')")
[ -z "$WANT" ] && [ -n "$SRC_SHA" ] && WANT="sha256:$SRC_SHA"
[ -z "$OUT" ] && OUT="./$NAME"

echo "文件名: $NAME"
echo "大小:   $SIZE 字节"
echo "分片数: $COUNT"
echo "校验值: ${WANT:-（服务端未记录，且未提供 SRC_SHA）}${SRC_SHA:+ [源哈希]}"
echo ""

# ---------- 2. 构造任务列表 + 单片下载器 ----------
JOBS_LIST="$WORK/jobs.txt"
node -e "
const j=require('$MF');
console.log(j.chunks.map(c=>[c.index,c.start,c.end,c.bytes].join(' ')).join('\n'));
" > "$JOBS_LIST"

ONE="$WORK/one.sh"
cat > "$ONE" <<'EOS'
#!/usr/bin/env bash
set -u
IDX=$1
START=$2
END=$3
EXPECT=$4
PART="$WORK/part-$IDX.bin"
A=1
while [ "$A" -le "$RETRIES" ]; do
  GOT=0
  [ -f "$PART" ] && GOT=$(wc -c < "$PART" | tr -d ' ')
  [ -z "$GOT" ] && GOT=0
  if [ "$GOT" -ge "$EXPECT" ]; then
    echo "p$IDX  已存在·跳过"
    exit 0
  fi
  # 分片内续传：只补拉缺失的尾部
  RS=$((START + GOT))
  TMP="$PART.tmp.$$"
  CODE=$(curl -s --noproxy '*' -m 300 -o "$TMP" \
    -b "picbed_session=$COOKIE" \
    -H "Range: bytes=$RS-$END" \
    -w '%{http_code}' "$BASE/f/$ID?download=1")
  if [ "$CODE" = "206" ]; then
    if [ "$GOT" -gt 0 ]; then cat "$TMP" >> "$PART"; else mv "$TMP" "$PART"; fi
  fi
  rm -f "$TMP"
  NOW=0
  [ -f "$PART" ] && NOW=$(wc -c < "$PART" | tr -d ' ')
  [ -z "$NOW" ] && NOW=0
  if [ "$NOW" -ge "$EXPECT" ]; then
    echo "p$IDX  完成 $NOW/$EXPECT${GOT:+ （自 $GOT 字节续传）}"
    exit 0
  fi
  # 退避：2,4,8,16,30,30...
  S=$((2 ** A)); [ "$S" -gt 30 ] && S=30
  echo "p$IDX  第${A}次未完成($NOW/$EXPECT, http=$CODE)，${S}s 后退避重试"
  A=$((A + 1))
  sleep "$S"
done
echo "p$IDX  失败（最终 $(wc -c < "$PART" 2>/dev/null | tr -d ' ')/$EXPECT）"
exit 1
EOS
chmod +x "$ONE"

export BASE COOKIE ID WORK RETRIES

printf "%-8s %s\n" "分片" "状态"
printf -- "----------------------------------------------------------\n"

T0=$(date +%s)
if [ "$JOBS" -gt 1 ]; then
  # 并发：每片一个进程，输出统一收集后排序展示
  xargs -P "$JOBS" -n 4 "$ONE" < "$JOBS_LIST" > "$WORK/log.txt" 2>&1
  RC=$?
  sort -V "$WORK/log.txt"
else
  RC=0
  while read -r A1 B1 C1 D1; do
    "$ONE" "$A1" "$B1" "$C1" "$D1" || RC=1
  done < "$JOBS_LIST"
fi
T1=$(date +%s)

echo ""
echo "下载耗时: $((T1 - T0)) 秒"

# ---------- 3. 检查完整性 ----------
FAIL=0
for I in $(seq 0 $((COUNT - 1))); do
  EXPECT=$(node -e "const j=require('$MF');console.log(j.chunks[$I].bytes)")
  P="$WORK/part-$I.bin"
  GOT=0
  [ -f "$P" ] && GOT=$(wc -c < "$P" | tr -d ' ')
  [ "$GOT" != "$EXPECT" ] && { echo "分片 p$I 不完整: $GOT/$EXPECT"; FAIL=$((FAIL + 1)); }
done

if [ "$FAIL" -gt 0 ] || [ "$RC" -ne 0 ]; then
  echo ""
  echo "有 $FAIL 个分片未完成（分片已保留在 $WORK，重跑本脚本可继续，残缺片只补尾部）"
  exit 2
fi

# ---------- 4. 合并 ----------
echo ""
echo "合并 $COUNT 个分片 -> $OUT"
: > "$OUT"
for I in $(seq 0 $((COUNT - 1))); do
  cat "$WORK/part-$I.bin" >> "$OUT"
done
ACTUAL=$(wc -c < "$OUT" | tr -d ' ')
echo "合并后大小: $ACTUAL 字节"

if [ "$ACTUAL" != "$SIZE" ]; then
  echo "大小不符（期望 $SIZE），合并结果可能不完整"
  exit 3
fi

# ---------- 5. 校验 ----------
if [ -n "$WANT" ]; then
  GOTSHA=$(shasum -a 256 "$OUT" | awk '{print $1}')
  WANTSHA=${WANT#sha256:}
  echo "本地 SHA-256: $GOTSHA"
  if [ "$GOTSHA" = "$WANTSHA" ]; then
    echo "校验: 一致 ✅"
  else
    echo "校验: 不一致 ❌"
    exit 4
  fi
else
  echo "（服务端未记录校验值，且未提供 SRC_SHA，跳过 SHA-256 比对）"
fi

rm -rf "$WORK"
echo ""
echo "=================================================================="
echo " 完成: $OUT"
echo "=================================================================="
