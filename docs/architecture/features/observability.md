---
title: "可观测性（事件与 OTel）— 使用手册"
slug: observability
view: 功能
layer: 总纲
module: —
packages: ["@runko/core", "@runko/agent", "@runko/persist-kysely", "@runko/otel", "@runko-chat/node-server"]
tags: ["可观测性", "事件", "OTel", "调用链", "diagnostics_channel", "日志", "破坏性变更"]
related: ["architecture/tech/observability.md", "architecture/plans/observability.md", "host/node/tech/multi-replica.md", "ingress/tech/telemetry.md"]
---

# 可观测性（事件与 OTel）— 使用手册

> 相关：[技术方案](../tech/observability.md) · [施工计划](../plans/observability.md)。
> 来由：[多副本部署 · 技术方案 附录 D](../../host/node/tech/multi-replica.md)（方案在那里对齐，七条结论）。
> 术语：[可观测性事件](../../terms.md) · [订阅者](../../terms.md) · [包裹](../../terms.md) · [调用链载体](../../terms.md) · [runko 通道](../../terms.md) · [遥测](../../terms.md)。

> **状态：方案已对齐，待施工。** 本文描述施工完成后的样子。

## 1. 一句话

**框架在关键时刻报出「发生了什么」，宿主自己决定怎么处理**——记日志、发推送、上报 OpenTelemetry（OTel），都是订阅同一份事件。

装一个 `@runko/otel`，就能在 Jaeger 这类界面里看到**一次请求跨副本的完整调用链**：从哪个副本进来、转给了谁、哪一轮跑了多久、里面调了几次模型和工具。

## 2. 它解决什么问题

今天框架对外说话有两个口子，都不好用：

| 口子 | 问题 |
|---|---|
| 注入式 `Logger`（框架里 42 处） | **文案和级别写死在框架里**。宿主只能决定写到哪，不能决定记不记、记成什么级别；想上报指标或调用链，只能去日志字符串里抠 |
| `RuntimeHooks`（6 个回调） | 只覆盖了起轮、收尾、首个 chunk、等审批这几处。**租约抢占、转发、接管、自我围栏一个都没有**——多副本排障最需要的恰恰是这些 |

另外，仓库里**没有 OTel**。chat 应用的「遥测」接的是 AI SDK 自己的回调，只记模型调用那一段，而且写的是 SQLite，不能进标准的监控系统。

## 3. 适合谁

- **想看清一次请求在多副本之间怎么走的人**：打开 Jaeger，一棵树就看完了，不用在几个副本的日志里对时间戳。
- **想接自家监控的人**：Datadog、Honeycomb、Grafana Tempo……凡是吃 OTel 的都能接；Sentry 这类直接订阅 [runko 通道](../../terms.md)，一行代码都不用改。
- **想按自己的格式记日志、发告警的人**：写一个订阅者，按事件类型分派即可。

## 4. 怎么用

### 4.1 接 OTel

```ts
import { otelObserver, otelTelemetry } from "@runko/otel";

const observers = [otelObserver()];   // 用全局注册好的 TracerProvider

createAgentRuntime({
  // ...
  observers,
  prepareTurn: ({ conversationId }) => ({
    // ...
    telemetry: otelTelemetry(),        // 让 AI SDK 的模型调用 span 也挂进同一棵树
  }),
});

// 租约仲裁是宿主自己构造的，同一份 observers 也交给它
const arbitration = postgresArbitration(pool, { holder, observers });
```

OTel SDK 本身（导出到哪、采样率）按 OTel 官方文档配置，runko 不管。

### 4.2 自己记日志、发推送

```ts
const observers: RunkoObserver[] = [
  {
    onEvent(event) {
      switch (event.type) {
        case "lease.taken-over":
          log.warn("took over a stale lease", { conversationId: event.conversationId, staleForMs: event.staleForMs });
          break;
        case "approval.pending":
          push.approvalPending(event);
          break;
      }
    },
  },
];
```

**订阅者抛错不会影响这一轮**——框架一律吞掉。

### 4.3 厂商零配置订阅（Node / Cloudflare Workers）

```ts
import diagnostics_channel from "node:diagnostics_channel";

diagnostics_channel.subscribe("runko:event", (event) => { /* 全部点状事件 */ });
diagnostics_channel.tracingChannel("runko:turn").subscribe({ start, asyncEnd, error });
```

没有这个模块的运行环境（Vercel Edge、浏览器）里，这个出口不存在，订阅者接口照常可用。

## 5. 能看到什么

### 5.1 调用链（Jaeger）

多副本下，请求打到副本 A、转发给持有者 B：

```
POST /api/chat/conversations/c1/messages            replica-a   52ms
└─ POST （转发）                                     replica-a   38ms
   └─ POST /api/chat/conversations/c1/messages      replica-b   18ms
      └─ invoke_agent                               replica-b   10.08s
         ├─ chat deepseek-v4                        replica-b    6.2s
         ├─ execute_tool bash                       replica-b    1.1s
         └─ chat deepseek-v4                        replica-b    2.6s
```

排队的消息在请求返回之后才被执行，它那一轮是一棵**新树**，带一条 link 指回「发这条消息的那次请求」，点一下就能跳回去。

### 5.2 事件

| 分组 | 事件（节选） | 什么时候 |
|---|---|---|
| 轮 | `turn.started` · `turn.first-chunk` · `turn.first-output` · `turn.settled` · `turn.ownership-lost` · `turn.displaced-settled` | 起轮、首个 chunk、首个可见输出、收尾、丢了归属、替被顶掉的持有者补「已停止」 |
| 队列 | `enqueue.resolved` · `queue.dequeued` · `queue.requeued` | 一条输入被起轮 / 排队 / 插话 / 拒绝；出队；放回 |
| 账本 | `ledger.write-rejected` | 写账本被拒（丢了归属或号冲突） |
| 人在回路 | `approval.pending` · `question.pending` | 等人裁决、agent 提问 |
| 租约 | `lease.acquired` · `lease.busy` · `lease.taken-over` · `lease.heartbeat-failed` · `lease.fenced` · `lease.lost` · `lease.released` | 多副本的归属变化 |
| 工具 | `tool.started` · `tool.finished` | 单次工具执行 |
| 恢复与关闭 | `recovery.swept` · `recovery.turn-recovered` · `shutdown.started` · `shutdown.settled` | 启动扫描、优雅关闭 |
| 意外 | `internal.error` | 框架自己碰到了不该发生的事（钩子抛错、收尾某一步失败…），带出错位置与原因 |

每个事件都带 `type`、`at`（毫秒时间戳），与会话有关的都带 `conversationId`。完整字段见[技术方案 §5](../tech/observability.md)。

## 6. 这是一次破坏性变更

| 删掉的 | 换成 |
|---|---|
| `createAgentRuntime({ logger })` 与 `Logger` / `noopLogger` 导出 | `observers` + 自己写一个记日志的订阅者 |
| `createAgentRuntime({ hooks })` 与 `RuntimeHooks` | 同一个 `observers`，按 `event.type` 分派 |

仓库里的宿主（chat 应用）随本次施工一起迁移。

## 7. 成功标准

- 框架里**没有一处**写死文案的日志；原来 42 处日志与 6 个钩子覆盖的时刻，事件全都有。
- chat 应用迁移后：推送通知（等审批、agent 提问、一轮结束）与「本轮准备」遥测**行为不变**。
- 多副本验证环境里：
  - 一次被转发的请求，在 Jaeger 里是**一棵树**，跨两个副本；
  - 排队后才执行的那一轮，能顺着 link 找回原请求；
  - 接管场景里能看到 `lease.taken-over` 与补「已停止」；
  - `timeline.log` 重新能读出租约的抢占、被占与自我围栏（由 demo 的日志订阅者打出）。
- 不装 `@runko/otel`、不传 `observers` 时，框架**零依赖**、行为与今天一致（除了不再打日志）。

## 8. 范围与非目标

- **只做调用链（traces）**，不做指标（metrics）与 OTel Logs API。事件里已经有算指标所需的字段，要做另起一期。
- **Cloudflare Workers、Vercel 放到下一期**：Workers 走平台自带的 tracing，Vercel 要在 `waitUntil` 里把 span 导出去。
- **不替你配 OTel SDK**：导出目的地、采样、资源属性，按 OTel 官方文档来。
- **不自动插桩第三方库**：HTTP、数据库驱动的 span 用 OTel 社区现成的插桩。
- **遥测（AI SDK 回调）保留**：chat 应用那套 SQLite 遥测照旧，`@runko/otel` 只是另外帮它把模型调用 span 接进同一棵树。
