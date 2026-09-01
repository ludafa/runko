---
"@nimbo/agent": minor
---

裁决记录的 `scope` 从 `'once' | 'broader'` 改成 **`'once' | 'conversation'`**。

影响 `DecisionRecord.scope` 与 `SubmittedDecision.scope` 两处。

原来记的是含糊的「比这一次更宽」，理由是「框架不知道有『会话』这个粒度」——**这条理由不成立**：
框架的 API 全是 `enqueue(conversationId, …)` / `subscribe(conversationId)` / `conversation-drained`，
它当然知道。既然知道，就该记准确的范围名。

**框架只记，不执行**：它不会在后续轮里查裁决表替宿主自动放行。记账粒度（按整条调用的入参指纹？
按命令段拆？按用户分账？）是宿主的产品决策，框架不该替它定。

传 `'broader'` 的宿主改传 `'conversation'`；已落库的旧值需要自己刷一遍（`scope` 只是审计字段，
没有代码读它回来做放行判断）。
