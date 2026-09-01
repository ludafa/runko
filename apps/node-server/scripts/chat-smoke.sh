#!/usr/bin/env bash
#
# 手工验证轮编排的小工具——对着一个**已经跑着的** node-server 打 HTTP。
# 它不起任何常驻进程，dev server 由开发者自己起（见根 CLAUDE.md）。
#
# 配套的操作序列见 docs/logic/orchestration/plans/agent-runtime.md §验证方案 · 手工复跑清单。
# 用法：./scripts/chat-smoke.sh help
#
set -euo pipefail

BASE="${BASE:-http://localhost:3900}"
HERE="$(cd "$(dirname "$0")" && pwd)"
STATE="${CHAT_SMOKE_STATE:-$HERE/.smoke}"
DB="${DATABASE_PATH:-$HERE/../data.db}"
EMAIL="${EMAIL:-test@test.com}"
PASS="${PASS:-1234asdf}"

mkdir -p "$STATE"
JAR="$STATE/cookies.txt"
CID_FILE="$STATE/cid"

j() { python3 -m json.tool 2>/dev/null || cat; }
cid() { if [ -n "${1:-}" ]; then echo "$1"; else cat "$CID_FILE"; fi; }
api() { curl -sS -b "$JAR" "$@"; }
jbody() { python3 -c 'import json,sys;print(json.dumps(json.loads(sys.argv[1])))' "$1"; }
# 每行打上「时分秒.毫秒」——第 5 组要量「按下停止到这一轮真的停」有多快。
stamp() { while IFS= read -r line; do printf '%s  %s\n' "$(python3 -c 'import datetime;print(datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3])')" "$line"; done; }

case "${1:-help}" in

login) # login —— 用 EMAIL/PASS 换 cookie
  curl -sS -c "$JAR" -H 'content-type: application/json' \
    -d "$(python3 -c 'import json,sys;print(json.dumps({"email":sys.argv[1],"password":sys.argv[2]}))' "$EMAIL" "$PASS")" \
    "$BASE/api/auth/sign-in/email" | j
  ;;

new) # new [标题] [provider] —— 建会话，id 记进 .smoke/cid
  payload=$(python3 -c 'import json,sys;d={"title":sys.argv[1]};
p=sys.argv[2] if len(sys.argv)>2 and sys.argv[2] else None
d.update({"provider":p} if p else {});print(json.dumps(d))' "${2:-轮编排验证}" "${3:-}")
  api -H 'content-type: application/json' -d "$payload" "$BASE/api/chat/conversations" \
    | tee "$STATE/last.json" | j
  python3 -c 'import json;print(json.load(open("'"$STATE"'/last.json"))["id"])' > "$CID_FILE"
  echo "→ 当前会话: $(cat "$CID_FILE")"
  ;;

use) # use <cid> —— 切到已有会话
  echo "$2" > "$CID_FILE"; echo "→ 当前会话: $2"
  ;;

tail) # tail [cid] —— 原始直播流（很吵），带时间戳
  api -N "$BASE/api/chat/conversations/$(cid "${2:-}")/stream" | stamp
  ;;

watch) # watch [cid] —— 一行一条的摘要；断线自动重连（/stream 是 follow:'turn'，一轮结束就会关）
  WATCH_CID="$(cid "${2:-}")"
  export WATCH_SEQ_FILE="$STATE/seq-$WATCH_CID"
  : > "$WATCH_SEQ_FILE"
  echo "--- watch ${WATCH_CID} （Ctrl-C 退出；WATCH_MAX_S 可设总时长上限）---"
  while [ -z "${WATCH_MAX_S:-}" ] || [ "$SECONDS" -lt "$WATCH_MAX_S" ]; do
    after="$(cat "$WATCH_SEQ_FILE" 2>/dev/null || true)"
    q=""; [ -n "$after" ] && q="?after=$after"
    api -N "$BASE/api/chat/conversations/$WATCH_CID/stream$q" \
      | python3 -u "$HERE/lib/watch-filter.py" || true
    sleep 1
  done
  ;;

say) # say "文本" [cid]
  api -H 'content-type: application/json' \
    -d "$(python3 -c 'import json,sys;print(json.dumps({"text":sys.argv[1]}))' "$2")" \
    "$BASE/api/chat/conversations/$(cid "${3:-}")/messages" | j
  ;;

steer) # steer "文本" [cid] —— 插进当前这一轮
  api -H 'content-type: application/json' \
    -d "$(python3 -c 'import json,sys;print(json.dumps({"text":sys.argv[1],"intent":"steer"}))' "$2")" \
    "$BASE/api/chat/conversations/$(cid "${3:-}")/messages" | j
  ;;

stop) # stop [cid]
  api -X POST "$BASE/api/chat/conversations/$(cid "${2:-}")/abort" | j
  ;;

show) # show [cid] —— turnInProgress / queuedMessages 的权威快照
  api "$BASE/api/chat/conversations/$(cid "${2:-}")" | j
  ;;

list) # list —— 列出全部会话
  api "$BASE/api/chat/conversations" | j
  ;;

pending) # pending [cid] —— 直接读裁决表里还没结清的（拿 callId 用）
  sqlite3 -header -column "$DB" \
    "select tool_call_id, kind, tool_name, substr(payload_json,1,60) as payload
     from conversation_decisions
     where conversation_id='$(cid "${2:-}")' and outcome is null;"
  ;;

approve) # approve <callId> [cid] —— 只准这一次
  api -X POST -H 'content-type: application/json' -d '{"behavior":"allow"}' \
    "$BASE/api/chat/conversations/$(cid "${3:-}")/approvals/$2" | j
  ;;

approve-session) # approve-session <callId> [cid] —— 会话内都允许
  api -X POST -H 'content-type: application/json' -d '{"behavior":"allow-session"}' \
    "$BASE/api/chat/conversations/$(cid "${3:-}")/approvals/$2" | j
  ;;

deny) # deny <callId> [理由] [cid]
  api -X POST -H 'content-type: application/json' \
    -d "$(python3 -c 'import json,sys;print(json.dumps({"behavior":"deny","message":sys.argv[1]}))' "${3:-不允许}")" \
    "$BASE/api/chat/conversations/$(cid "${4:-}")/approvals/$2" | j
  ;;

delq) # delq <messageId> [cid] —— 删待发队列里的一条
  api -X DELETE "$BASE/api/chat/conversations/$(cid "${3:-}")/queue/$2" | j
  ;;

clearq) # clearq [cid] —— 清空待发队列
  api -X DELETE "$BASE/api/chat/conversations/$(cid "${2:-}")/queue" | j
  ;;

holder) # holder —— 直接读库看起轮标记（判孤儿轮用）
  sqlite3 -header -column "$DB" \
    "select id, turn_holder, datetime(turn_started_at,'unixepoch','localtime') as started
     from conversations where turn_holder is not null;"
  ;;

ledger) # ledger [cid] —— 账本里这条会话有哪些行（验证「只写成品消息」）
  sqlite3 -header -column "$DB" \
    "select kind, count(*) as rows from conversation_events
     where conversation_id='$(cid "${2:-}")' group by kind;"
  ;;

*)
  sed -n '/^case/,/^esac/p' "$0" | grep -E '^[a-z-]+\) #' | sed 's/) #/  —/' | sed 's/^/  /'
  echo
  echo "环境变量：BASE(默认 $BASE)  EMAIL  PASS  DATABASE_PATH"
  echo "会话 id 记在 ${CID_FILE} ，多数命令的 cid 参数可省略。"
  ;;
esac
