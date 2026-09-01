# @nimbo/agent

**轮编排运行时**——`@nimbo/core` 给的是「跑一轮」，本包给的是「**一轮接一轮地跑下去，而且换个部署形态不用改业务代码**」。

> 文档：[使用手册](../../docs/logic/orchestration/features/agent-runtime.md) · [技术方案](../../docs/logic/orchestration/tech/agent-runtime.md) · [架构总纲](../../docs/architecture/tech/agent-kernel.md)

## 三十秒上手

```ts
import { defineAgent, localExec } from "@nimbo/sdk";
import { MemoryFS } from "@nimbo/virtual-fs";
import { createAgentRuntime } from "@nimbo/agent";

const runtime = createAgentRuntime({
  agent: defineAgent({ model: "anthropic/claude-sonnet-5" }),
  // 唯一必填：这个会话在哪儿干活
  prepareTurn: () => {
    const fs = new MemoryFS();
    return { fs, exec: localExec({ materialize: true, fs }) };
  },
});

await runtime.enqueue("conv_abc", { text: "把 src 里的 var 都改成 const" });

for await (const frame of runtime.subscribe("conv_abc")) {
  console.log(frame);
}
```

**持久化、流分发、归属仲裁三样全走内置实现**——账本在内存、流走进程内、独占靠一个 Map。够跑通、够写测试，进程一重启历史就没了。要留住就换掉 `persistence`，要上多进程再换掉 `arbitration`；**业务代码一行不动**。

## 它替你做了什么

| 你不用再写 | 框架里的位置 |
| --- | --- |
| 一轮跑完，下一条消息什么时候起 | `enqueue` 的三路分流 + 收尾时自动出队 |
| agent 忙时用户又发一条 | 待发队列（排队 / 插话由你配） |
| 「查完队列没活儿了」到「真正释放」之间的竞态 | `conversation-drained` + 入队方兜底，框架内实现一次 |
| 把人的裁决送回那个正 `await` 的 loop | 人在回路桥（审批 / `ask-user`） |
| 进程被强杀后界面永远转圈 | 起轮标记 + `recover()` 启动扫描 |
| 部署重启时让轮体面地停下 | `shutdown()` 交权 |

## 四样宿主能力

都可替换，**都带内置的平凡实现**：

| 能力 | 接口 | 内置实现 | 换成什么 |
| --- | --- | --- | --- |
| 工作区（沙盒） | `TurnPreparer` | —— | `@nimbo/virtual-fs` · `sandbox-*` |
| 持久化 | `LedgerStore` / `DecisionStore` / `QueueStore` | `memoryPersistence()` | 宿主自己实现（推荐）· `@nimbo/persist-*` |
| 流分发 | `StreamFanout` | `inProcessStream()` | `@nimbo/stream-redis` |
| 归属仲裁机制 | `Arbitration` | `inProcessArbitration()` | 租约版 · Durable Object |

真实的宿主实现长什么样，看 [`apps/node-server/src/agent/persistence.ts`](../../apps/node-server/src/agent/persistence.ts)——它把这四样全架在既有的 drizzle schema 上，没有引入第二套数据访问方式。

## 还没做的

- **挂起与恢复**：等人等太久时落盘退出、人回来在任意节点接着干。卡在一个未定的上游问题（core 的「恢复开轮」入口怎么加），见[施工进展](../../docs/logic/orchestration/plans/agent-runtime.md)。
- **租约版归属仲裁**：多进程共享 DB。接口已按它定形（`nextSeq` 会报「失去独占权」、`Grant` 带失效信号），换实现不用改轮编排。
