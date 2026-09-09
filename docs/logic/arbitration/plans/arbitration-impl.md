---
title: "归属仲裁机制 · 租约版（施工计划）"
slug: arbitration-impl
view: 施工
layer: 逻辑层
module: 归属仲裁
packages: ["@runko/persist-kysely", "@runko/persist-mongo", "@runko/agent"]
tags: ["租约", "心跳", "租期标识", "多进程", "CAS"]
related: ["logic/arbitration/features/arbitration-impl.md", "logic/arbitration/tech/arbitration-impl.md", "architecture/plans/agent-kernel.md", "host/node/plans/multi-replica.md"]
---

# 归属仲裁机制 · 租约版（施工计划）

> 相关：[功能手册](../features/arbitration-impl.md) ·
> [技术方案](../tech/arbitration-impl.md) ·
> [架构总纲 · 施工](../../../architecture/plans/agent-kernel.md)（这是其中的 **K6**）

## 0. 一句话

把「同一份对话同时刻只有一个执行在跑」这件事，从**内存里一个 Map**（只在单进程成立）
换成**数据库里一张租约表**（多进程也成立）。轮编排一行不改。

## 1. 现状盘点：哪些已经有了，缺口在哪

> ⚠️ **本节是 2026-09-01 立项当时的快照，不是当前事实。** 里面写着「租约版实现 ❌ 不存在」——
> 它当天就交付了。**当前事实以 §3 的阶段表与 §8 的变更记录为准**，别照着本节重做一遍。
> 保留它是因为它解释了当时为什么这么拆单。

**这是本计划最要紧的一节**——接口在 K2 就定形了，很多人以为还没开始的东西其实已经在跑。

| 件 | 现状 | 位置 |
|---|---|---|
| `Arbitration` 接口 | ✅ **已定形并发布** | [`packages/agent/src/arbitration.ts`](../../../../packages/agent/src/arbitration.ts) |
| `Grant`（`signal` / `valid` / `nextSeq` / `release`） | ✅ 已定形 | 同上 |
| 「失去独占权」的表达 | ✅ 已定形：`grant.signal` abort + `nextSeq` 报 `lost_ownership` | 同上 |
| 内存版实现 | ✅ 已交付 | `packages/agent/src/builtin/in-process-arbitration.ts` |
| 轮编排对「失去独占权」的处置 | ✅ 已交付且有用例 | `packages/agent/src/runtime/turn.ts` |
| **租约版实现** | ❌ **不存在** | 本计划要做的 |
| 持久化的 `WriteResult`（拒绝是结果不是异常） | ✅ 已交付，五个实现都满足 | `packages/agent/src/persistence.ts` |
| 一致性套件（持久化） | ✅ 已交付，31 条 | [`packages/conformance/src/persistence.ts`](../../../../packages/conformance/src/persistence.ts) |
| **一致性套件（仲裁）** | ❌ **不存在** | 本计划要做的 |
| `held_by_other` 的转发 | ❌ 路由目前回 **500** 并丢消息 | `apps/node-server/src/routes/chat.ts:591` |

### 1.1 技术方案 §8 那四个 TODO，其实已经答了两个

技术方案的「TODO（未定）」写于 K2 之前，现在要**逐条更新**，否则会照着它重新设计一遍：

| TODO | 现状 |
|---|---|
| ① 接口方法签名（授予/回收/续期/执法） | ✅ **已答**。`acquire`/`release`/`nextSeq`/`inspect`/`listStale`/`clearStale`。注意**没有显式的「续期」方法**——心跳是实现内部的事，接口上看不见（这是对的：轮编排不该知道租约） |
| ④ 「失去独占权」怎么通知 | ✅ **已答**，而且是两条路并行：`grant.signal`（推，让正在跑的轮走既有的中断收尾）+ `nextSeq` 的 `lost_ownership`（拉，保证写入不会漏过） |
| ② 心跳间隔与超时接管阈值 | ❌ 仍未定 → 见 §2 |
| ③ 交权宽限期 | ❌ 仍未定 → 见 §2 |

### 1.2 现有的 drizzle 版**不是**租约版，别被名字骗了

`apps/node-server/src/agent/persistence.ts` 的 `createChatArbitration` 是
**check-then-set**：读一次 `turn_holder`，不为空就报 busy，否则写进去。没有租期标识、
没有心跳、没有 CAS。

它今天是对的，**只因为 better-sqlite3 是全同步的单进程**——读和写之间插不进别的东西。
换成 `pg.Pool` 或多进程，两个请求会同时读到 `null` 然后都写进去。所以它**不能**当租约版
的起点，只能当「内存版的一个跨重启变体」。

## 2. 三个默认值（✅ 已定案 2026-09-01）

| 参数 | **定案** | 我原本的建议 |
|---|---|---|
| **心跳间隔** | **5 秒** | 10 秒 |
| **超时接管阈值** | **60 秒**（12 个心跳） | 30 秒（3 个心跳） |
| **交权宽限期** | **15 秒** | 15 秒（一致，复用 `DEFAULT_SHUTDOWN_GRACE_MS`） |

**这是把 safety 与 liveness 两头都往保守挪的组合，不是折中**，理由要写进实现的注释里：

- **心跳快（5s）→ 老持有者更快知道自己出局。** 它的心跳 CAS 打不中就说明 token 被换了，
  5 秒内就能 abort 掉正在跑的那一轮。这是**安全侧**。
- **阈值长（60s）→ 别人几乎不可能误接管。** 要连丢 12 拍。这是**故意牺牲 liveness**：
  宁可崩溃后让用户多转一分钟圈，也不要出现两个写入方。

**两个代价，实现时不要偷偷抹掉：**

1. **崩溃后的接管延迟是 60 秒**，不是 30 秒。界面上那一轮会转圈转满一分钟。
   宿主如果想让用户早点知道，应该在**接入层**做提示（「这一轮所在的节点失联了，正在等待接管」），
   而不是把阈值调小。
2. **写库频率翻倍**：一个会话一条 UPDATE / 5s，1000 个并发会话 ≈ 200 QPS（原建议是 100）。
   对三档库都不算负担，但要写进文档，别让人以为租约是免费的。

**三个都要可配**，且**阈值必须 ≥ 3× 心跳间隔**——`leaseArbitration()` 的入参里做这条校验，
**配错当场抛**，不等线上误接管。当前定案是 12×，离这条红线很远。

## 3. 阶段拆单

依赖是线性的：**L1 → L2 → L3 → L4** 是一条链（表 → 抢占 → 心跳 → 取号），L5 起可以并行。

| 阶段 | 目标 | 状态 |
|---|---|---|
| **L0** | 定案三个值；更新技术方案 §8 | ✅ 已交付（2026-09-01） |
| **L1** | 租约表 + CAS 原语 | ✅ `agent_leases` 四档 DDL + `schema.sql` |
| **L2** | `acquire` / `release` / `inspect` | ✅ `persist-kysely/src/arbitration.ts` |
| **L3** | 心跳 + 超时接管 | ✅ 同上 |
| **L4** | `nextSeq` 的 CAS + 失效通知 | ✅ 同上（推 `signal` + 拉 `lost_ownership` 两条路） |
| **L5** | `listStale` / `clearStale` 的租约语义 | ✅ 同上 |
| **L6** | **仲裁一致性套件** | ✅ `@runko/conformance` 的 `arbitrationCases` / `arbitrationMultiNodeCases` / `arbitrationTakeoverCases` |
| **L9 场景 3** | **被误判的老持有者写入被拒** | ✅ 四个方言全过（含真 Postgres / 真 MySQL） |
| **L7** | 三个薄壳导出 `*Arbitration()` | ✅ 2026-09-09，见[多副本部署 · 施工](../../../host/node/plans/multi-replica.md) M1 |
| **L8** | Mongo 版 | ⬜ 未开工，见[多副本部署 · 施工](../../../host/node/plans/multi-replica.md) M2 |
| **L9 完整版** | 两个**真进程**的 e2e | ✅ 2026-09-09（SQLite 文件档四场景），真 Postgres 档见[多副本部署 · 施工](../../../host/node/plans/multi-replica.md) M6 |
| **L10** | 接入层转发（`held_by_other` 不再回 500） | ✅ 2026-09-09，示范在 `persist-demo`，见[多副本部署 · 施工](../../../host/node/plans/multi-replica.md) M5 |

### 与计划的偏差（四处，都是有意的）

**① 租期标识用 `crypto.randomUUID()`，不是 ULID。** 技术方案 §4.1 写的是 ULID，但它给的
理由是「**只需唯一、不需递增**」——ULID 的可排序性在这里一次都没用到。`randomUUID` 满足
同样的要求且**零依赖**，给一个要对外发布的持久化包加一个只为生成不排序的 ID 的依赖不划算。
语义完全一致：粒度仍是「一次租期」，校验仍是等值判断。

**② L9 目前是「两个 `Arbitration` 实例」，不是两个 OS 进程。** 它们共享同一个真库、
`holder` 不同，走的是与真·多进程**完全相同**的那条路（令牌 CAS 落在数据库里），所以
「被误判的老持有者写入被拒」这条核心断言已经是真库上的真行为。但它**不能替代**真开两个
进程的 e2e——那条还要验进程崩溃、连接池独立、时钟不同步这些只有跨进程才有的东西。
留在 L9 完整版。

**③ `acquire` 走的是四步，不是计划里写的「一条语句」。** 计划 §3.1 L2 原文是「抢占本身是
一条条件插入或条件更新，**不能是先查再写**」。实现是：快路 SELECT（判 busy，顺带让
`seedSeq` 保持惰性）→ 幂等插入（确保行存在）→ **条件 UPDATE**（决胜负）→ 读回确认。
形状与计划相反，但**结论上是安全的**：决胜负的仍是那一条原子的条件 UPDATE，前面那次
SELECT 只是优化，并发下输的那一方会在读回时看到别人的令牌。MySQL 的 `ON DUPLICATE KEY
UPDATE` 不支持 WHERE 子句，一条语句做不到跨三方言一致，这是拆成四步的直接原因。

**④ `holder` / `lease_token` 是可空的，计划的 DDL 写的是 `NOT NULL`。** `release()` 靠把
这两列置空表示「没人持有」，行本身保留（`seq_watermark` 要跨释放留着）。

### 实现上的三个关键点（读代码前先看这三条）

1. **所有条件写都是「条件 UPDATE + 读回确认」两步，不看 `affectedRows`。** MySQL 把
   「匹配到了但值没变」也报成 0 行，跟「没匹配到」分不开（本仓在幂等插入那里已经踩过一次）。
2. **`release()` 只在还持有时才放手**（`WHERE lease_token = ?`）。被接管之后再 release
   会把新持有者的租约擦掉——一致性套件里有一条专门钉这个。
3. **不删行，只把 `holder`/`lease_token` 置空。** `seq_watermark` 要跨释放保留，否则下一轮
   会从账本水位重新起，撞上已经发出去但还没落盘的号。

**每一阶段都独立跑绿**——L1–L5 期间租约版还没被任何人用上，不影响现有测试。

### 3.1 各阶段的关键内容

**L1 · 租约表**

```sql
CREATE TABLE agent_leases (
  conversation_id varchar(255) NOT NULL,   -- MySQL 上要 COLLATE utf8mb4_bin
  holder          varchar(255) NOT NULL,   -- 不透明字符串，框架不解释
  lease_token     varchar(64)  NOT NULL,   -- ULID，调用方生成
  seq_watermark   bigint       NOT NULL,   -- 账本水位（租约版从这儿取号）
  heartbeat_at    bigint       NOT NULL,
  acquired_at     bigint       NOT NULL,
  CONSTRAINT agent_leases_pk PRIMARY KEY (conversation_id)
);
```

**seq 水位放在租约行上**，跟归属同生共死——这样「取号」和「校验我还持有」是**同一条
UPDATE**，不需要两次往返，也不可能出现「校验通过但取号用的是别人的水位」。

CAS 原语只有一条：

```sql
UPDATE agent_leases
   SET seq_watermark = seq_watermark + 1, heartbeat_at = ?
 WHERE conversation_id = ? AND lease_token = ?
```

**⚠️ MySQL 的 `affectedRows` 在这里有坑**（本仓已经踩过一次，见 `persist-kysely`
的 `append`）：MySQL 默认把「匹配到了但值没变」报成 0 行，跟「没匹配到」分不开。
本表上每条 CAS 都会改 `heartbeat_at`（永远是新值），所以**天然绕开**——但这条约束
必须写进注释，将来加一条「只读校验」的 CAS 时会立刻踩上。**纯校验要用
`SELECT ... WHERE token = ?`，不要用「更新成相同值」的 UPDATE。**

**L2 · acquire**

抢占本身是一条**条件插入或条件更新**，不能是「先查再写」：

```sql
-- 没人持有 → 插入；持有者已超时 → 抢过来。两种都是一条语句。
INSERT INTO agent_leases (...) VALUES (...)
ON CONFLICT (conversation_id) DO UPDATE
   SET holder = ?, lease_token = ?, heartbeat_at = ?, acquired_at = ?
 WHERE agent_leases.heartbeat_at < ?   -- 只有超时的才让抢
```

写完**读回来比对 `lease_token`**——`ON CONFLICT DO UPDATE ... WHERE` 不满足条件时是
静默 no-op，跟成功分不开（跟 `enqueue` 那次是同一类问题，同一个解法）。

`seq_watermark` 只在**首次插入**时用 `ctx.seedSeq()` 播种；抢占已有行时**不能重播**
——那会让 seq 倒退、撞上账本里已有的行。

**L3 · 心跳**

一个 `setInterval` 挂在 `Grant` 上，`release()` 时清掉。心跳自己就是一条 CAS：
打不中（token 已被别人换掉）就说明**我已经被接管了** → 立刻 abort `grant.signal`，
让正在跑的那一轮走既有的中断收尾。

**这是「失去独占权」最主要的发现路径**——比 `nextSeq` 更早，因为一轮里可能很久
才写一次账本。

**L4 · nextSeq**

每次取号一条 CAS。**这是写放大**：一轮里每条成品消息一条 UPDATE。可接受（账本本来
就要写一行），但要在文档里写明白：**租约版下每条消息是两次写**（租约 + 账本）。

**L5 · listStale 在租约版下是什么**

内存版里 `listStale` 恒空（标记跟进程同生共死）。租约版下它是「**心跳已超时但行还在**」
的那些会话——语义跟内存版**不一样但都正确**：内存版看不到自己上次崩溃的残留，租约版
看得到。一致性套件要允许这个差异（见 §5）。

**L9 · 多进程 e2e 怎么做**

`persist-demo` 起**两个真进程**（不是两个 `createDemoApp`），指向同一个 Postgres：

1. 两个进程同时对一个会话 POST 消息 → 一个 202 `started`，另一个拿到 `held_by_other` 且带对方的 holder；
2. `kill -9` 持有者 → 30 秒后另一个能接管；
3. **被误判的老持有者**（用 `SIGSTOP` 冻住再 `SIGCONT` 唤醒）此后的写入一律被拒 → 账本没被写坏。

第 3 条是这一整个功能**唯一真正要证明的东西**，其余都是它的推论。

## 4. 三处容易做错的地方

**① 别把 `holder` 当租期标识。** 技术方案 §4.1 写了理由：「A 失联 → B 接管 → B 挂 →
A 重新抢占」时，A 滞留在网络里的旧写入会被放行。**粒度必须是一次租期**。

**② 心跳失败不等于失去归属。** 一次网络抖动打不中，可能只是这一次超时；要连续失败
到接近阈值才 abort。但**取号的 CAS 打不中就是真的失去了**（那说明 token 已被换掉）
——两者处置不同，别混用同一个判定。

**③ `release()` 必须是幂等的，而且要能在 `signal` 已 abort 之后调。** 轮编排的收尾
路径无条件调它（本批刚修过一个 `release` 泄漏），实现不能因为「我已经不是持有者了」
就抛。

## 5. 验收标准

逐条对上[功能手册 §5](../features/arbitration-impl.md) 那四条：

| # | 功能手册的标准 | 怎么验 |
|---|---|---|
| 1 | 单进程下不装任何东西，行为与今天完全一致 | 现有 2118 个用例照跑，一个不改 |
| 2 | 两个进程同时起轮只有一个成功，另一个拿到 `holder` 能转发 | L9 场景 1 + L10 |
| 3 | 杀掉持有者能被接管；**被误判的老持有者写入一律被拒** | L9 场景 2、3 —— **这条是核心** |
| 4 | Durable Object 那档能干净绕过 | 不在本计划（那是 K9 的 `@runko/durable-object`），但仲裁一致性套件要保证「什么都不做」的平凡实现也能过 |

另加两条工程标准：

5. **仲裁一致性套件**：内存版与租约版跑同一套；差异（如 `listStale` 语义）由套件显式表达，不靠各写各的。
6. **CI 里真的跑**：租约版必须在 Postgres/MySQL/Mongo 容器上跑（CI 已经有这三个 service container 了，本批刚加）。

## 6. 非目标

- **不做跨会话的资源冲突**（本机 CLI 多个会话共用一个项目目录那种）。
- **不替宿主转发**——框架只给 `holder`。L10 做的是 chat 应用自己的转发，是示范不是框架能力。
- **不改崩溃恢复的语义**：进程被强杀仍走老路（补一条「已停止」），因为它没停在干净边界上。
- **不做 `@runko/durable-object`**（K9）与 `@runko/stream-redis`。多节点要完整可用还需要它们，
  但那是另外两条独立的线——**本计划做完，多进程共享一个 Postgres 的部署就成立了**
  （流分发在同机多进程下可以先用「谁持有谁推流 + 接入层转发」兜住）。

## 7. 工作量估计

L1–L5 是主体（一个新文件 + 表），L6 一致性套件是**收益最高**的一段（一次投入，五个实现都受益），
L9 的多进程 e2e 最花时间但也最不可省——**没有它，这个功能等于没验**（单进程测试跑绿
不代表租约版没问题，功能手册 §3① 明说了）。

建议先做 **L0–L6 + L9 场景 3**（那条误判拒绝的路），跑通了再补 L7/L8/L10。

## 8. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-01 | L0–L6 + L9 场景 3 交付：租约表 DDL 四档、`leaseArbitration`、心跳与超时接管、仲裁一致性套件、SQLite/pglite/真 Postgres/真 MySQL 四档全绿 |
| 2026-09-02 | **一致性套件拆成独立包 [`@runko/conformance`](../../../../packages/conformance/README.md)**。此前它是 `@runko/agent` 的子路径导出，代价是 `vitest` 成了那个**运行时**包的可选 peer——测试框架不该出现在运行时包的依赖里。拆包后套件自带手写断言，只导出 `{ name, run }` 用例数据，任何测试框架都能接 |
| 2026-09-02 | **心跳自我围栏改成「每拍开头先判」**。此前围栏判断只写在 `catch` 里，只覆盖「库抛错」；库**挂住不返回**（TCP 黑洞 / 连接池耗尽）时防重入标志永久为真，后面每一拍都提前 return，老持有者永不停手。同批把围栏的时间基准从「往返回来之后的 `now()`」改成「写进 `heartbeat_at` 的那个时刻」——别的节点判死看的就是后者，用前者会在往返接近心跳间隔时把余量吃光 |
| 2026-09-02 | **`nextSeq` 一律不抛**。接口注释写死了「不抛错」，三个调用点也都没有 try，但库抖动时异常会从 `appendSettleMessage` 里逃出去——那是收尾的最后一段。现在库出错归到 `lost_ownership`（含义是「你现在不许写」），是否真的失去归属仍由心跳的自我围栏判定 |
| 2026-09-02 | **`expire` 测试钩子改成冻结持有者那一侧的时钟**。只改 `heartbeat_at` 会被持有者的下一拍心跳刷回来，接管随机失败（真库上尤其明显）；一致性套件里 `listStale` / `clearStale` 那条也改成从**另一个节点**扫——那才是这个接口的真实场景 |
