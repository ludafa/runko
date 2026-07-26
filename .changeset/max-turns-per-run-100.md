---
"@nimbo/core": minor
---

`maxTurnsPerRun` 的默认值从 40 提到 100。没有显式设置这个字段的 agent，一次 `send()`/`stream()` 里最多能跑 100 个模型步（原来 40 步就会以 `max_turns` 收场）。显式设置过的调用方不受影响。
