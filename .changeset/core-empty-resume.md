---
"@nimbo/core": patch
---

`createSession({ resume })` 现在接受**空账本**（`messages: []`）。

此前会被 ai 的 `validateUIMessages()` 拒成 "Messages array must not be empty"，可 `sessionStateSchema` 本来就允许空数组——「resume 一个还没产出任何消息的会话」是完全合法的。宿主想让会话 id 从第一轮起就稳定（拿业务侧的会话 id 当 `session.id`，好让遥测的关联键跨轮不断）时，传的正是这种空 state。
