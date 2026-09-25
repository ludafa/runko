---
"@runko/agent": minor
---

**`shutdown` 支持先等进行中的轮自然跑完，再中止剩下的。**

新增可选参数 `finishWindowMs`（也可以在 `createAgentRuntime` 的 `shutdown.finishWindowMs` 配缺省值，缺省 `0` = 老行为不变）：等人的轮照旧立刻挂起，干活的轮在这个窗口内自然收尾就不再被中止；窗口期间每 500 毫秒复查一次，中途转入等人的轮也会被立刻挂起，不必占到窗口结束；窗口到点还没收尾的按原规则处理（等人的挂起，其余用 `ABORT_REASON_SHUTDOWN` 中止）。`ShutdownResult` 新增 `finished` 字段，报告窗口内正常完成（`completed`）的轮数——窗口期间被用户停止或跑失败的轮不算在内。
