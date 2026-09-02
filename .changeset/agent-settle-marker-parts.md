---
"@nimbo/agent": minor
---

**修一个会把会话写死的 bug**：收尾标记曾经写成 `parts: []`。

ai 的 `validateUIMessages()` 拒绝空 parts（`Message must contain at least one part`），而**每一轮起轮都要拿整个账本过一次校验**——账本里只要有一条这样的行，这个会话此后**永远起不了新轮**，每次都栽在 resume 上。

产出空 parts 的有两处，都已改成 `[{ type: "step-start" }]`（core 自己在「首步之前就失败」时用的同一个占位）：`recover()` 补的孤儿轮收尾，以及停止 / 失败路径写的收尾标记。

**存量数据会自愈**：`buildResumeState` 现在会滤掉 parts 为空的行，所以早期版本写坏的账本不用清库也能继续用。

> 单测抓不到它——测试用的假 session 不跑 `validateUIMessages`。是真机验证「`kill -9` 后崩溃恢复」时暴露的：恢复本身成功了，但那个会话之后再也起不了轮。

> 级别是 **minor 而不是 patch**：它同时改变了账本里落盘的消息形状（收尾标记从空 parts 变成一个 `step-start`），宿主若靠 `parts.length === 0` 认收尾标记会失配。
