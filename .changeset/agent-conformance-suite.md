---
"@nimbo/agent": minor
---

新增子路径导出 `@nimbo/agent/conformance`：**持久化一致性套件**。

一套用例，喂给任意一个 `Persistence` 实现，逐条断言接口注释里那些**写死了但从没验过**
的承诺：

```ts
import { runPersistenceConformance } from "@nimbo/agent/conformance";

runPersistenceConformance("我自己的实现", async () => ({
  persistence: myPersistence(),
  cleanup: async () => { /* … */ },
}));
```

覆盖 27 条不变量（内存 / SQLite / Postgres / MySQL 四种实现跑同一套），包括：`append` 同 `(conversationId, seq)` 重复写入不得写出两行、
`read({ afterSeq })` 不含自身且按 seq 升序、seq 允许有空洞、`maxSeq` 对空会话返回 0、
`dequeue` 取出即移除、`requeueFront` 不受 `max` 约束、队列满时不截断不覆盖、
`settle` 对已结清的返回 `false` 而不是抛。

自己实现这三个接口的宿主（这是**头等路径**，不是降级方案）可以直接引它自测，
不用把这些边角自己再想一遍。

`vitest` 因此成为本包的**可选 peer**——只用主入口的人完全不受影响。
