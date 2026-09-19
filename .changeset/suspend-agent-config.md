---
"@runko/agent": minor
---

挂起有了自己的配置项：`suspend.memoryWindow`、`suspend.onPresence`，以及 `runtime.reportPresence(conversationId)`。

```ts
createAgentRuntime({
  agent,
  prepareTurn,
  suspend: {
    memoryWindow: "5m", // 先在内存里等多久，等不到就挂起。可写毫秒数或 "300ms" / "30s" / "5m" / "1h"
    onPresence: "extend", // 收到 reportPresence 时把窗口往后推（缺省）；"ignore" 不推
  },
});
```

- **`memoryWindow: 0`**：一等人就挂起、不起定时器，挂起理由记 `"immediate"`（`SuspendReason` 多了这一值）。不可寻址的宿主（Vercel Functions、Durable Object）用这一档。
- **写错了构造时就抛 `RangeError`**（负数、`NaN`、`"1e3s"`、超过定时器上限约 24.8 天），不会悄悄按默认跑。新导出类型 `Duration`。
- **`reportPresence(conversationId)`**：人还盯着这条会话时调它，正在等人的那一轮的窗口从此刻起重新计时。同步、不落库；没轮在等人时什么都不做。**请基于真实交互上报**（页面可见 + 窗口聚焦 + 路由停在这条会话），别拿「连接还在」当在场。

⚠️ **默认窗口从 240 秒变成 5 分钟**（与审批保活预算对齐）。没配任何参数的宿主，等人的时间会长一分钟，到点之后是挂起而不是拒绝（见同批「挂起」那条）。

**旧参数仍然生效，但已废弃**：`human.approvalTimeoutMs` 只管审批、`human.askUserTimeoutMs` 只管提问，没配的那一路用 `memoryWindow`——只配旧参数的宿主行为不变，会多一行 warn。新旧都配时以新的为准，旧的记一行 warn 说被忽略了。
