---
"@runko/core": minor
"@runko/agent": patch
---

**一轮显示「完成」时一定已经存好了；排队的下一轮紧接着跑，不再断流。**

- `@runko/core`：`RunkoError.code` 新增 `internal_error`（系统异常）。core 自己不产出，留给编排层报 core 之外的故障；它的 `message` 是一句不含细节的通用话。对 `code` 做穷举（比如 `Record<RunkoError["code"], …>`）的代码要补上这一项。
- `@runko/agent`：一轮的收尾帧（`message-metadata`）现在排在这一轮的成品消息帧**之后**——订阅者收到「完成了」时，回复已经写进账本。成品消息没能全部写进账本（库出错、写入被拒、归属丢了）时，不再发「完成了」，改发 `status: "failed"` + `internal_error`，并尽量补一条失败标记；具体原因只进日志。
- `@runko/agent`：一轮收尾时[待发队列](https://github.com/ludafa/runko/blob/main/docs/terms.md)里还有消息，持有者**不放手归属**，直接出队起下一轮；两轮之间不再广播 `activity:false`，`subscribe()` 的同一条订阅一路收到整个队列跑完。队列排空、最后一轮跑完才广播 `activity:false` 并放手。
