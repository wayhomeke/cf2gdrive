#!/usr/bin/env bash

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
export SCRIPT_TMP="$SCRIPT_ROOT/tmp"
mkdir -p "$SCRIPT_TMP" || exit 1
# relay-put.sh — 分片上传（命令行版，支持中断续传）
#
# 与 relay-fetch.sh 配对：大文件不走单个巨型请求，而是按服务端给的 chunk_size
# 逐片上传；中断后重跑会自动从 Drive 实际持有的偏移继续，而不是从零开始。
#
# 用法：
#   COOKIE=<picbed_session> bash scripts/relay-put.sh <file> [public|private]
#
# 可选环境变量：
#   BASE        目标域名，默认 http://localhost:8787
#   SESSION_DIR 会话记录目录，默认 <project>/tmp/relay-put（用于续传）
#   HASH        是否计算并声明 SHA-256，默认 1（服务端据此记录校验值）
#
# 依赖：curl、shasum（可选）、node

set -u

BASE="${BASE:-http://localhost:8787}"
COOKIE="${COOKIE:-}"
FILE="${1:-}"
VIS="${2:-public}"
SESSION_DIR="${SESSION_DIR:-${SCRIPT_TMP}/relay-put}"
HASH="${HASH:-1}"

if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
  echo "用法: COOKIE=<session> bash scripts/relay-put.sh <file> [public|private]"
  exit 1
fi
if [ -z "$COOKIE" ]; then
  echo "错误: 需要 COOKIE 环境变量（picbed_session）"
  exit 1
fi

mkdir -p "$SESSION_DIR"
NAME=$(basename "$FILE")
SIZE=$(wc -c < "$FILE" | tr -d ' ')
KEY=$(printf '%s' "$NAME:$SIZE" | shasum -a 256 | awk '{print $1}' | cut -c1-16)
SESSION_FILE="$SESSION_DIR/$KEY.session"
DISK=$(df -P "$SCRIPT_TMP" | awk 'NR==2{print $4}')   # 1K blocks free

echo "=================================================================="
echo " 中转文件分片上传（命令行 · 可续传）"
echo "=================================================================="
echo "文件: $NAME"
echo "大小: $SIZE 字节 ($((SIZE / 1048576)) MiB)"
echo ""

# ---------- 客户端校验和（可选） ----------
CLI_SHA=""
if [ "$HASH" = "1" ]; then
  echo "计算本地 SHA-256（大文件可能需要几秒）..."
  CLI_SHA=$(shasum -a 256 "$FILE" | awk '{print $1}')
  echo "  $CLI_SHA"
fi

# ---------- 取得或复用会话 ----------
SID=""
if [ -f "$SESSION_FILE" ]; then
  SID=$(cat "$SESSION_FILE")
  ST=$(curl -s --noproxy '*' -m 60 -b "picbed_session=$COOKIE" "$BASE/api/relay/upload/status?session=$SID")
  OK=$(printf '%s' "$ST" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(j.done?'done':(j.received!=null?'live':'bad'))}catch(e){console.log('bad')}})")
  if [ "$OK" = "live" ]; then
    echo "复用已有会话 ${SID} (服务端已收 $(printf '%s' "$ST" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log(JSON.parse(d).received)})") 字节)"
  else
    echo "旧会话不可用，重新初始化"
    rm -f "$SESSION_FILE"
    SID=""
  fi
fi

if [ -z "$SID" ]; then
  INIT=$(curl -s --noproxy '*' -m 120 -b "picbed_session=$COOKIE" \
    -H "Origin: $BASE" -H "Referer: $BASE/files" -H "content-type: application/json" \
    -X POST -d "{\"name\":\"$NAME\",\"size\":$SIZE,\"mime\":\"application/octet-stream\",\"visibility\":\"$VIS\",\"client_sha256\":\"$CLI_SHA\"}" \
    "$BASE/api/relay/upload/init")
  SID=$(printf '%s' "$INIT" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).session_id||'')}catch(e){console.log('')}})")
  if [ -z "$SID" ]; then
    echo "初始化失败: $INIT"
    exit 1
  fi
  echo "新会话: $SID"
  printf '%s' "$SID" > "$SESSION_FILE"
fi

# ---------- 循环推片 ----------
printf "\n%-8s %-14s %-14s %s\n" "片" "偏移" "已收/总量" "状态"
printf -- "----------------------------------------------------------\n"

IDX=0
while true; do
  ST=$(curl -s --noproxy '*' -m 60 -b "picbed_session=$COOKIE" "$BASE/api/relay/upload/status?session=$SID")
  # 会话可能在上一片推送完成后已被 finalize 并删除，此时不必再推
  if printf '%s' "$ST" | grep -q 'session_not_found'; then
    echo ""
    echo "会话已结束（服务端已 finalize 并清理）。按文件名+大小回查文件："
    curl -s --noproxy '*' -m 60 -b "picbed_session=$COOKIE" \
      "$BASE/api/relay?sort=created_desc&per_page=5&page=1" \
      | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);const arr=j.items||j.files||j.list||[];const hit=arr.find(x=>x.name==='$NAME'&&(x.size_bytes||x.size)===$SIZE);console.log(hit?('命中文件 ID: '+hit.id+' · '+(hit.size_bytes||hit.size)+' 字节'):'未回查到同名同大小文件')}catch(e){console.log('回查失败')}})"
    rm -f "$SESSION_FILE"
    exit 0
  fi
  DONE=$(printf '%s' "$ST" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).done?'1':'0')}catch(e){console.log('0')}})")
  if [ "$DONE" = "1" ]; then
    FID=$(printf '%s' "$ST" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).file?.id||'')}catch(e){console.log('')}})")
    echo ""
    echo "上传完成，文件 ID: $FID"
    rm -f "$SESSION_FILE"
    exit 0
  fi

  RECEIVED=$(printf '%s' "$ST" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).received||0)}catch(e){console.log('0')}})")
  RECEIVED=${RECEIVED:-0}
  SERV_CHUNK=$(printf '%s' "$ST" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).chunk_size||0)}catch(e){console.log('0')}})")
  CHUNK=${SERV_CHUNK:-$((8 * 1048576))}
  [ "$CHUNK" -le 0 ] && CHUNK=$((8 * 1048576))
  START=$RECEIVED
  LEN=$CHUNK
  if [ $((START + LEN)) -gt "$SIZE" ]; then LEN=$((SIZE - START)); fi

  PART="${SCRIPT_TMP}/relay-put-part-$KEY.bin"
  dd if="$FILE" of="$PART" bs=1048576 skip=$((START / 1048576)) count=$((LEN / 1048576)) 2>/dev/null

  RESP=$(curl --http1.1 -s --noproxy '*' -m 900 -b "picbed_session=$COOKIE" \
    -H "Origin: $BASE" -H "Referer: $BASE/files" -H "content-type: application/octet-stream" \
    -X POST --data-binary @"$PART" "$BASE/api/relay/upload/chunk?session=$SID")
  NEWRECV=$(printf '%s' "$RESP" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).received||0)}catch(e){console.log('0')}})")
  NEWRECV=${NEWRECV:-0}

  # 最后一片由 chunk 响应直接给出 done + file，不必再查已销毁的会话
  CDONE=$(printf '%s' "$RESP" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).done?'1':'0')}catch(e){console.log('0')}})")
  if [ "$CDONE" = "1" ]; then
    FID=$(printf '%s' "$RESP" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).file?.id||'')}catch(e){console.log('')}})")
    rm -f "$PART"
    IDX=$((IDX + 1))
    printf "%-8s %-14s %-14s %s\n" "p$IDX" "$START" "$NEWRECV/$SIZE" "已推送 $((LEN / 1048576)) MiB"
    echo ""
    echo "上传完成，文件 ID: $FID"
    rm -f "$SESSION_FILE"
    exit 0
  fi

  rm -f "$PART"

  IDX=$((IDX + 1))
  printf "%-8s %-14s %-14s %s\n" "p$IDX" "$START" "$NEWRECV/$SIZE" "已推送 $((LEN / 1048576)) MiB"

  if [ "$NEWRECV" = "$RECEIVED" ]; then
    echo ""
    echo "偏移未推进 (received=${RECEIVED})，可能分片被拒或链路中断。响应: $RESP"
    echo "会话已保留，重跑本脚本可从该偏移继续。"
    exit 2
  fi
done
