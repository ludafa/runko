---
"@nimbo/core": minor
"@nimbo/agent": minor
---

收尾状态多了第四种：`suspended`（挂起）。

- `@nimbo/core`：`NimboMessageMetadata.status` 与它的 zod schema 从三值扩到四值。
- `@nimbo/agent`：`TurnStatus` 跟着扩（它原样透传 core 的收尾 metadata）。

**挂起是主动且可恢复的**——一轮停在「正在等人」这个干净边界上收尾、释放归属，人回来之后由
**新的一轮**接着跑。它跟 `interrupted`（宿主主动中断）不是一回事，宿主别把它当失败处理：别重试、
别标红，界面上也不该显示成「已中断」。

**目前还没有产出方**：core 的 `finalizeTurn` 至今只写出前三态，真正产出 `suspended` 要等挂起与
恢复那一批。现在先进联合类型，是为了让宿主与界面提前把渲染分支占好，避免那天前后端不同步。

对 `switch` 做穷尽性收窄（`assertNever`）的调用方需要补一个分支——这是本次唯一的破坏面。
