---
"@runko/core": minor
---

**交权信号：节点要下线时，一轮可以停在干净的位置交给别的节点接着跑，而不是被中断。**

- `TurnOptions.handover`（与 `signal` 分开的第二个信号）：模型正在输出 → 掐断、这半步整个扔掉；工具正在跑 → **工具不停**，这一轮带着悬空调用以新的收尾状态 `handed-over` 结束，还在跑的调用经 `TurnResult.handedOver.running` 交给调用方继续持有（每个带一个从不 reject 的 `outcome` promise）。
- `Session.continueTurn()`：不追加任何消息，从账本当前的样子接着跑——接手的一方在模型输出段交权之后用它。
- `Settlement` 新增 `{ kind: "error", errorText }`：结清一次「执行过但失败了」的调用（写成 `output-error`）。
- `SessionOptions.toolTimeoutMs`：单次工具执行的上限。到点先 abort 工具，再等两秒，还不回来就给模型一个「超过最长执行时间，已终止」的结果。
- `RunkoMessageMetadata.status` 多了 `"handed-over"`，并带 `handedOver: { callIds }`。
- `Tool.waitsForPerson`：在 `execute` 里等人的工具（如 `ask-user`）不受工具最长执行时间约束，交权时也不被交出去（由宿主让它挂起）。
- `settleAndRun` 的选项 `alsoSettle`：同一轮里一起结清另外几次「执行过了」的调用——交权时并行在跑的几个工具要全部有结果后一起结清。
- 工具超时之后在宽限期里真跑完了的，保留它的真实结果，不改写成「已终止」。
