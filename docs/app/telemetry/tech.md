# 遥测（Telemetry）— 技术方案

> 相关：[产品与使用手册](./feature.md) · [施工进展](../chat-observability/plan.md)（遥测属「chat 可观测性」拆单）· 依赖 [app/chat-webapp/tech](../chat-webapp/tech.md)（§11 可观测性总览、注入落位）· [agent/single-ledger/tech](../../agent/single-ledger/tech.md)（账本侧计时数据 `data-tool-timing` 与消息 metadata 的定义）
> 术语：[遥测（telemetry）](../../terms.md)。本页讲怎么存、有效期、怎么用；产品行为与数据清单见产品文档。

## 1. 方案总览

ai@7 把 telemetry 转正为**纯回调的事件集成接口**（`Telemetry`，`experimental_telemetry` 已废弃）——无 OpenTelemetry 依赖，无 collector/exporter，实现一个带生命周期回调的对象即可。nimbo 的接入分三层：

1. **core 注入口**：`SessionOptions.telemetry`（`SessionTelemetry`，loop.ts）透传集成对象到每次 `streamText`；不注入时零开销。loop 恒在 `telemetry.functionId` 注入 **`"<nimbo 会话 id>#<turn>"` 关联键**——ai 的 `InferTelemetryEvent` 把 TelemetryOptions 字段并进每个事件，因此所有事件天然自带此键。
2. **工具事件补发**：nimbo 的工具由 loop 自己结算（[agent/single-ledger/tech](../../agent/single-ledger/tech.md)），AI SDK 自己永远没机会触发 `onToolExecutionStart/End`——core 的 `settleExecution` 在 `executeToolCall` 前后**替它补发**这两个事件（`loop.ts` 的 `notifyToolExecution*`，事件形状用 ai 导出的 widened 联合类型构造）。deny/未知工具/畸形调用从未执行，不发。
3. **server 落库**：`apps/node-server/src/telemetry.ts` 的 `createSqliteTelemetry(store)` 把每个事件写成一行 SQLite；生产装配是惰性单例（`getChatTelemetry`/`getChatTelemetryStore`），经 `ChatRouteDeps` 注入默认 chatApp（写侧 `telemetry` + 读侧 `telemetryStore` 两个口，测试可分别注入假件）。

三条硬纪律：

- **遥测永不影响 turn**：每个回调整体 try/catch 吞错，写库失败最多丢一行遥测。
- **产品功能不得依赖遥测**（依赖方向单向）：账本是统计弹窗概览/卡片的数据源，遥测只服务统计弹窗明细；`TELEMETRY_DISABLED=1` 后产品零损失。
- **正文不落盘**：载荷收敛（§2.3）+ 注入侧关死 `recordInputs`/`recordOutputs` 双保险。

## 2. 怎么存

### 2.1 存储形态：独立 `telemetry.db`

独立于聊天库 `data.db` 的 SQLite 文件（缺省 `apps/node-server/telemetry.db`，`TELEMETRY_DB_PATH` 覆盖），WAL 模式。**表结构自管**（启动时 `CREATE TABLE IF NOT EXISTS`），刻意不进 drizzle 迁移链——遥测是耗材（§3），schema 演化的兜底手段是删库重建，不背迁移债。

```sql
CREATE TABLE IF NOT EXISTS telemetry_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_session_id   TEXT,      -- functionId 前半段：nimbo 会话 id（非 chat 行 id！见 §2.2）
  turn         INTEGER,   -- functionId 后半段
  event_type   TEXT NOT NULL,   -- start / step-start / model-call-start / model-call-end / tool-execution-* / step-end / end / abort / error
  ts           INTEGER NOT NULL,   -- 落库时刻（epoch ms）
  payload_json TEXT NOT NULL      -- 收敛后的事件 JSON（§2.3）
);
CREATE INDEX IF NOT EXISTS telemetry_events_session_turn
  ON telemetry_events (agent_session_id, turn);
```

### 2.2 数据领域与关联

遥测键的是 **nimbo 会话 id**（core `SessionState.id`），不是 chat 行 id——chat 行经 `agent_session_id` 列（首轮优雅收尾时由 `finalizeTurnPersistence` 写入的会话 header）映射过去。查询端点做这一次翻译；会话尚无 header（首轮未完成/中途崩溃）时按「无数据」处理。

```mermaid
erDiagram
    conversations ||--o{ conversation_events : "id = conversation_id（账本，data.db）"
    conversations ||..o{ telemetry_events : "conversations.agent_session_id 对应（跨库逻辑关联，无外键）"
    conversation_events }o..o{ telemetry_events : "同轮数据按 (agent 会话 id, turn) join"

    conversations {
        text id PK "对话 id（URL 里的会话 id）"
        text agent_session_id "SDK agent 会话 id；首轮完成前为 NULL"
        integer agent_session_turn "agent 会话 header 的当前轮数"
    }
    conversation_events {
        text conversation_id PK "对话 id"
        integer seq PK
        text kind "message | chunk"
        text payload_json "含 data-tool-timing / 消息 metadata（账本侧计时）"
    }
    telemetry_events {
        integer id PK
        text agent_session_id "nimbo 会话 id（functionId 前半段）"
        integer turn
        text event_type
        integer ts
        text payload_json
    }
```

### 2.3 载荷收敛（写入即净化）

`curatePayload()` 三道闸，按序生效：

1. **删除键**（`DROPPED_KEYS`）：`functionId`（已拆列）、`recordInputs`/`recordOutputs`（随事件并入的选项噪音）——直接去掉。
2. **摘要键**（`OMITTED_KEYS`）：`messages`/`content`/`prompt`/`system`/`steps`/`request`/`response`/`text`/`reasoning` 等大块正文——替换为体量摘要（`[omitted: N items|chars]`），保留「有多大」的线索、丢原文。
3. **总长封顶**：收敛后仍超 16KB → 整体降级为 `{truncated: true, approximateLength}`；序列化本身抛错（循环引用等）→ `{serializationError}`。

补发的工具事件在源头就配合这一策略：`messages` 字段（"发起该调用的上下文"）置空数组，不为遥测多留一份账本引用。

### 2.4 起轮装配事件（`turn-prepare` / `turn-first-output`）

前三种事件（模型调用、step、工具执行）全部来自 turn **已经在跑之后**。但用户感知的等待是从「按下回车」开始算的，中间还夹着一段谁也没测量过的[起轮装配](../../terms.md)：取沙盒、续期、读账本、建会话——它整段跑在 `POST .../messages` 的请求生命周期里，慢了界面上一点反馈都没有。这两种事件补的就是这段空白。

| 事件 | 何时写 | 载荷字段 |
|---|---|---|
| `turn-prepare` | 这一轮**第一个 chunk** 抵达 turn runner 时 | `acquireMs` / `acquireMode`（`cache`\|`resume`\|`create`）/ `touchMs` / `loadStateMs` / `buildSessionMs` / `launchMs` / `firstChunkMs` |
| `turn-first-output` | 这一轮**第一个可见 chunk**（`text-start`／`reasoning-start`／`tool-input-available`）抵达时 | `firstOutputMs` |

字段口径（全部毫秒，墙钟）：

- `acquireMs` + `acquireMode`：`sandboxManager.acquire()` 的耗时与它走的哪条路——进程内缓存命中（`cache`，零远程调用）、按[重连令牌](../../terms.md)恢复（`resume`）、还是重建（`create`，含 clone + 装 skill + 切分支）。**解释「今天怎么这么慢」时先看这一格**。
- `touchMs`：沙盒续期（`touch`）的远程往返，每轮必做。
- `loadStateMs`：`loadResumeState`——读全部 `kind = 'message'` 账本行 + zod 校验，本地 SQLite，随历史增长。
- `buildSessionMs`：`buildSession`——其中几乎全部是 `Skill.fromFS()` 把 frontend-design skill 的 SKILL.md 与全部附属文件从沙盒读出来（每个文件一次远程往返），`createSession` 本身是同步的。
- `launchMs`：`launchTurn` 全程（≥ 上面四段之和，差额是 zod 校验、凭据解析等零散同步开销）。
- `firstChunkMs`：`startTurn` 返回到第一个 chunk 抵达——这段是 `session.stream()` 顶部的 `await`（把 skill 附属文件**写回**沙盒的 `mountSkillFiles`、账本 zod 校验）加 `convertToModelMessages`。**不含**模型首 token：core 的 loop 在发出请求之前就 yield 了 `start`/`start-step`。
- `firstOutputMs`：`startTurn` 到第一个可见 chunk——`firstOutputMs - firstChunkMs` 即模型首 token 的等待。（模型自报的 `timeToFirstOutputMs` 在 `model-call-end` 里，但那要等整次调用结束才落库，看不到「此刻还在等」。）

**为什么在第一个 chunk 抵达时才落库，而不是装配一结束就写**：遥测的关联键是 `functionId = "<nimbo 会话 id>#<turn>"`，而首轮的 nimbo 会话 id 是 `createSession` 现场 mint 的，装配阶段根本不知道；`turn` 号同理要等 `session.stream()` 把它 `+1`。第一个 chunk 抵达时两者都已确定，`session.toJSON()` 一读即得，且与 core 注入 `streamText` 的那个 functionId **逐字节相同**——同轮数据自然 join 得上。代价是这一轮若在产出任何 chunk 之前就崩了（沙盒装配失败），就没有 `turn-prepare` 行；那种失败会以 500 响应 + `turn-launcher` 的 error 日志现身，不靠遥测。

**依赖方向**：`turn-runner/` 不认识遥测，也不认识计时——它只多了两个生命周期通知点（`onMilestone`），与既有的 `onTurnSettled`（不认识「队列」只报告事件）是同一姿态；拼载荷、写库都在 `turn-launcher.ts`。

```mermaid
sequenceDiagram
    autonumber
    participant Web as web
    participant Route as POST .../messages
    participant Launch as turn-launcher（launchTurn）
    participant Box as 沙盒
    participant Runner as turn-runner（driveTurn）
    participant Core as core loop
    participant DB as telemetry.db

    Web->>Route: 发消息（此时界面只有乐观回显）
    Route->>Launch: launchTurn
    Launch->>Box: acquire（cache / resume / create）
    Launch->>Box: touch（续期）
    Launch->>Launch: loadResumeState（读账本 + 校验）
    Launch->>Box: buildSession → Skill.fromFS（读 skill 附属文件）
    Launch->>Runner: startTurn（登记后立即返回）
    Route-->>Web: 202（前端此刻才开 SSE）
    Runner->>Core: session.stream()
    Core->>Box: mountSkillFiles（写回 skill 附属文件）
    Core-->>Runner: start / start-step（模型请求已发出，尚无 token）
    Runner->>Launch: onMilestone('first-chunk')
    Launch->>DB: INSERT turn-prepare（含装配分段 + firstChunkMs）
    Core-->>Runner: text-start / reasoning-start / tool-input-available（模型首个可见输出）
    Runner->>Launch: onMilestone('first-output')
    Launch->>DB: INSERT turn-first-output
```

## 3. 有效期

**定位：耗材（无持久承诺），当前不自动清理。** 具体含义：

- **系统不承诺存续**：允许随时手动清空、允许 `TELEMETRY_DISABLED=1` 整体关闭、允许版本升级时因 schema 演化直接重建——所有消费方（统计弹窗、API）都按「数据可能缺席」设计，空数据是正常态不是错误。
- **当前没有自动清理**：没有任何代码会删 `telemetry_events` 行——不主动清就一直在。手动管理的两个姿势：
  - 整库清空：停服后删 `telemetry.db`（连同 `-wal`/`-shm`），下次启动自动重建；
  - 按时间裁剪：`DELETE FROM telemetry_events WHERE ts < <epoch_ms>;` 后接 `VACUUM;` 回收空间。
- **若未来需要自动保留期**（例如「只留 30 天」）：加一个启动时/定时的按 `ts` 删除即可，属一次小工单——记录在案，暂不做（本地单人开发场景数据量增长有限，YAGNI）。

## 4. 怎么用

### 4.1 写入与读取链路

```mermaid
sequenceDiagram
    autonumber
    participant Loop as core loop（runTurn/settleExecution）
    participant AI as ai streamText
    participant Int as SQLite 集成（createSqliteTelemetry）
    participant DB as telemetry.db
    participant Web as web TurnStatsButton
    participant API as GET .../turns/{turn}/telemetry

    Note over Loop,DB: 写入（turn 进行中，全程同步、吞错）
    Loop->>AI: streamText({ telemetry: { functionId: "<会话id>#<turn>", integrations } })
    AI->>Int: onStart / onStepStart / onLanguageModelCallStart|End / onStepEnd / onEnd
    Int->>DB: INSERT（拆 functionId → agent_session_id, turn；curatePayload）
    Loop->>Int: onToolExecutionStart|End（settleExecution 补发，deny 不发）
    Int->>DB: INSERT（同上）

    Note over Web,DB: 读取（用户点开统计弹窗，按需拉取）
    Web->>API: 首次打开弹窗才请求（组件内缓存）
    API->>API: 鉴权 + getChatSession → 取 agent_session_id（NULL → 空数组）
    API->>DB: TelemetryStore.list(agentSessionId, turn)
    DB-->>Web: events[]（payloadJson 前端零星 safeParse，坏行静默跳过）
```

### 4.2 三个消费入口

- **统计弹窗**：`TurnStatsButton`（`components/turn-stats-dialog.tsx`）挂在完成轮的 assistant 回复末尾，点开弹窗——概览来自消息 metadata（耗时/工具/agent/usage），有 `conversationId`/`turn` 时再拉遥测明细，三组行：**本轮准备**（`turn-prepare` + `turn-first-output`，§2.4——起轮装配分段、沙盒走的哪条路、到首个 chunk / 首个输出的耗时）、`model-call-end`（modelId / finishReason / responseTimeMs / timeToFirstOutputMs / 输入输出吞吐 / usage 三分含 cacheReadTokens·reasoningTokens）与 `tool-execution-end`（toolName / toolExecutionMs / 失败标记）。
- **API**：`GET /api/chat/conversations/{id}/turns/{turn}/telemetry`（openapi.yml 已含）——`{ events: [{ eventType, ts, payloadJson }] }`，payloadJson 原样透传字符串，服务端不做二次建模（形状随 ai 小版本演化，深度建模只会先碎在服务端）。
- **SQL**：
  ```sql
  -- 某轮全部事件（agent_session_id 用 conversations.agent_session_id 翻译）
  SELECT event_type, ts, payload_json FROM telemetry_events
   WHERE agent_session_id = ? AND turn = ? ORDER BY id;
  -- 最慢的 20 次模型调用（跨会话，运维排障）
  SELECT agent_session_id, turn, json_extract(payload_json, '$.performance.responseTimeMs') AS ms
    FROM telemetry_events WHERE event_type = 'model-call-end' ORDER BY ms DESC LIMIT 20;
  ```

### 4.3 配置面

| 环境变量 | 作用 | 缺省 |
|---|---|---|
| `TELEMETRY_DISABLED=1` | 整体关闭（不建库、不采集、端点恒空数组） | 开启 |
| `TELEMETRY_DB_PATH` | 库文件位置 | `telemetry.db`（server 进程 cwd） |

另有一道隐式守卫：vitest 环境（`VITEST` 存在）且未显式给 `TELEMETRY_DB_PATH` 时自动关闭——默认 chatApp 在模块顶层求值，没有它，任何 import 路由的测试都会在仓库里落一个 telemetry.db。

## 5. 关键接口

- `SessionTelemetry`（`@nimbo/core`，loop.ts）：`{ integrations: Telemetry[]; recordInputs?; recordOutputs? }`——SDK 门面原样透传（`@nimbo/sdk` 的 `createSession` 直接收 `CoreSessionOptions`）。
- `TelemetryStore`（`apps/node-server/src/telemetry.ts`）：`record(eventType, functionId, event)` / `list(agentSessionId, turn)` / `close()`——写读同一抽象，测试用 `createTelemetryStore(':memory:')`。
- functionId 约定：`"<nimbo 会话 id>#<turn>"`，`parseFunctionId` 按**最后一个** `#` 切分（防会话 id 含 `#`），不合形状时 turn 置 NULL、原文落 agent_session_id。

## 6. 取舍与已知限制

1. **API 新鲜度**：ai@7 的 telemetry 刚转正（7.0.20），字段仍可能小版本漂移——防御是「payload 整体 JSON + 消费端零星 `safeParse` + 坏行静默跳过」，而不是深度建模。
2. **工具事件是补发的**：`toolExecutionMs` 由 loop 自测（`executeToolCall` 前后 `Date.now()`），与账本 `data-tool-timing` 的执行区间同源同刻但独立记录；两者数值理论一致，权威口径以账本为准（产品数据）。
3. **单进程本地文件**：多实例部署时各写各的 telemetry.db，无汇聚——当前单进程场景够用，需要集中式再议（届时 `Telemetry` 集成换个后端即可，接口不变）。
4. **首轮未完成的会话查不到**：`agent_session_id` 在首轮优雅收尾才写入，此前端点返回空数组（数据其实已按 nimbo 会话 id 落库，只是缺翻译键）——可接受的边界，统计按钮本就只出现在完成轮上，无 `turn` 键时弹窗只出概览、不拉明细。
5. **turn 内时序**：`ts` 是落库时刻、`id` 单调递增，同轮内按 `id` 排序即事件顺序；跨轮/跨会话比较用各事件 payload 里的业务时间字段。
6. **起轮装配打点只覆盖成功起轮的那些轮**（§2.4）：装配途中失败（沙盒挂了、凭据缺失）永远产不出第一个 chunk，也就没有 `turn-prepare` 行——那条路径的可观测性归日志与 500 响应，遥测不兜底。同理，`intent: 'steer'`（[插话](../../terms.md)）与[排队](../../terms.md)不走 `launchTurn`，也没有这两种事件。
7. **`firstChunkMs` 里混着一段 core 内部的活**（`mountSkillFiles` + 账本校验 + `convertToModelMessages`），当前不再细分——继续拆需要在 `@nimbo/core` 里加打点口，那是发布包的破坏性面，等这层数据证明确有必要再动。
