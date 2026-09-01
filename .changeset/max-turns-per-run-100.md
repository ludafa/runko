---
"@nimbo/core": minor
---

`maxTurnsPerRun` 的默认值从 40 提到 100。没有显式设置这个字段的 agent，一次 `send()`/`stream()` 里最多能跑 100 个模型步（原来 40 步就会以 `max_turns` 收场）。显式设置过的调用方不受影响。

⚠️ **这会影响单轮的费用上限**：没设过这个字段的 agent，一次调用现在最多能烧 100 个模型步而不是 40 步。原来靠默认值兜住成本的，需要显式把它设回去（`defineAgent({ maxTurnsPerRun: 40 })`）。
