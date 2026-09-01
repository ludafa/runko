"""把 SSE 直播流压成一行一条的摘要——判定用得上的四类帧 + 收尾状态。

`WATCH_SEQ_FILE` 若已设置，会把见过的最大 seq 落进去，供外层重连时作 `?after=` 用
（`/stream` 是 follow:'turn'，一轮结束就关，重连不带 after 会把历史整份重放一遍）。
"""
import datetime
import io
import json
import os
import sys

SEQ_FILE = os.environ.get("WATCH_SEQ_FILE")
_max_seq = 0


def remember(seq):
    global _max_seq
    if SEQ_FILE and isinstance(seq, int) and seq > _max_seq:
        _max_seq = seq
        io.open(SEQ_FILE, "w").write(str(seq))


_last = None


def emit(line):
    """重连时 /stream 会把队列/轮状态原样重放一遍——内容跟上一行一模一样就不再刷。"""
    global _last
    if line == _last:
        return
    _last = line
    print("%s  %s" % (ts(), line))
    sys.stdout.flush()


def ts():
    return datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3]


def brief(parts, limit=90):
    out = []
    for p in parts or []:
        t = p.get("type", "")
        if t == "text":
            out.append(p.get("text", ""))
        elif t == "reasoning":
            out.append("(思考)")
        elif t.startswith("tool-"):
            out.append("[%s %s]" % (t[5:], p.get("state", "")))
    s = " ".join(" ".join(out).split())
    return s[:limit] + ("…" if len(s) > limit else "")


try:
    for raw in sys.stdin:
        if not raw.startswith("data: "):
            continue
        try:
            o = json.loads(raw[6:])
        except ValueError:
            continue
        remember(o.get("seq"))
        if "turnActive" in o:
            emit("%s 轮 turnActive=%s" % ("▶" if o["turnActive"] else "■", str(o["turnActive"]).lower()))
        elif "queue" in o:
            q = o["queue"]
            emit("☰ 队列 %d 条 %s" % (len(q), [(i.get("text") or "")[:20] for i in q]))
        elif "message" in o:
            m = o["message"]
            emit("✉ seq=%s %s %s" % (o.get("seq"), m.get("role"), brief(m.get("parts"))))
        elif "chunk" in o:
            c = o["chunk"]
            t = c.get("type", "")
            if t == "message-metadata":
                emit("⏹ 收尾 status=%s" % ((c.get("messageMetadata") or {}).get("status"),))
            elif "approval" in t or str(c.get("state", "")).startswith("approval"):
                emit("⚖ 审批 %s %s callId=%s" % (t, c.get("state", ""), c.get("toolCallId")))
except (BrokenPipeError, KeyboardInterrupt):
    pass
