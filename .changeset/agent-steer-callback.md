---
"@nimbo/agent": minor
---

`queue.steer` 多了一档：**回调**。

原来只有三个枚举值（`'never'` / `'always'` / `'onRequest'`），现在多了一个 `(input) => boolean`：

```ts
createAgentRuntime(agent, {
  queue: {
    // 认出「停一下」这类指令就插进当前这一轮，其余排队
    steer: (input) => /^(停|等|stop|wait)/.test(input.text),
  },
});
```

适用于「客户端不显式表态，但想按消息内容自动分流」的宿主——`'onRequest'` 那档要求调用方在
`enqueue` 时传 `intent`，表达不了这件事。

回调拿到的是整条 `TurnInput`（`text` / `userId` / `meta` 都在），所以「只有发起者本人能插话」
「带某个 meta 标记的才插话」这类策略也写得出来。

**回调抛错一律当排队处理**，不会把 `enqueue` 打挂——排队是安全的回落，用户的话进队列、这一轮
收尾时自动出队，什么都不丢。

新导出 `SteerPolicy` 类型。三个枚举值的行为一字未改，缺省仍是 `'onRequest'`。
