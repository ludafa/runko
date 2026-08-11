# Cloudflare Worker Server（施工进展）

> 相关：[产品视角](./feature.md) · [技术方案](./tech.md)
> 依赖：[sandbox 技术方案](../../host/sandbox/tech.md)（§6 网关形态与协议、§7 workerd 实测）· [沙盒 provider 产品文档](../../host/sandbox-provider/feature.md) · [chat-webapp 技术方案](../chat-webapp/tech.md)
> 代码：[apps/cloudflare-worker-server](../../../apps/cloudflare-worker-server/README.md)
> 术语：[沙盒](../../terms.md) · [网关形态](../../terms.md) · [沙盒 provider](../../terms.md)

## 由来：从去风险 spike 到一个完整示例

本项目**始于一个 spike**（2026-07-20 立项，代号 `chat-worker-spike`），当时只验证一个命题：

> Hono + nimbo 跑在 Cloudflare Worker 里，能经 `getSandbox(env.Sandbox, id)` 直连驱动一个真实的 CF [沙盒](../../terms.md)，跑完一次 agent 会话。

命题在同日实测成立（见下方 S2/S3）。**随后（2026-07-20 晚）用户定案**：不把它当一次性探针丢掉，而是转正为一个**完整的示例项目**，并把原 `examples/cloudflare-gateway-ref/`（11 号真机段的 BYO 网关参考料）**并入其中**——两者本就共用同一套 `getSandbox` 接线与几乎相同的 `wrangler.jsonc`/`Dockerfile`。

于是它从「一次性去风险探针」变成「一个巨大的示例」，同时扮演两个角色（详见[技术方案 §1](./tech.md)）。下文保留 spike 阶段的盘点与实测结论——它们是本项目现有形态的由来与依据。

## 背景：为什么不能直接跑

`@nimbo/sandbox-cloudflare` 是[网关形态](../../terms.md)，前提是「agent 跑在任意电脑、Worker 里只放网关」。而本次诉求相反：**把 chat 服务端本身装进 Worker**，于是它与沙盒同进程，网关那层 HTTP 不必过网络。

需要说明的是，[sandbox 技术方案 §7](../../host/sandbox/tech.md) 已有实测结论「nimbo 核心零改动可跑 workerd」，但那只覆盖 **core**，不覆盖 **chat 服务端**。

## 现状盘点：chat 服务端上 workerd 的真实卡点

盘点自 `apps/node-server`（2026-07-20）。**Hono 那层几乎白送**——`app.ts` 导出的 `app.fetch` 本就是标准 fetch handler，`index.ts` 的 `@hono/node-server` 是唯一 Node 绑定，很薄。真正的阻塞在应用层：

| # | 卡点 | 位置 | 性质 |
|---|---|---|---|
| 1 | `better-sqlite3` 是原生插件，workerd 加载不了；且是模块级 `new Database()` | `src/db/instance.ts:6` | 必须换 D1 / DO-SQLite（schema 可留，驱动+迁移全改）。遥测那份 `TELEMETRY_DB_PATH` 同理 |
| 2 | 顶层静态 import 厂商 SDK，会炸 workerd bundle | `src/agent/sandbox-manager.ts:49-50` | `@vercel/sandbox` + `e2b` 需改条件/动态加载，或 Workers 构建只留 CF |
| 3 | sandboxManager 是**模块级**单例，但 `getSandbox` 依赖**每请求** `env` binding | `src/routes/chat.ts:922` | provider 构造时机须下沉到请求级，反过来改装配形状 |
| 4 | **CF idle 睡眠丢文件系统**，与 Vercel `persistent`/E2B `pause` 的「含未提交改动快照恢复」不等价 | — | **产品语义落差，非工程量**。chat 主打的「多轮改动累积、唤醒后原样还原」在 CF 上兑现不了，只能靠已 push 分支兜底 |
| 5 | better-auth 需换 D1 适配器 | `src/auth.ts` | 工程量 |
| 6 | 19 个 `process.env` 变量须改走 bindings/secrets | 全服务端 | 工程量 |
| 7 | `apps/web` 是 Vite SPA | `apps/web` | 走 Workers Static Assets 或单独部署 |

## 范围

**做**：Worker 入口 + CF 沙盒直连接线 + 一次真 agent 会话（卡点 #3 的接线形状在此先行验证）+ 对外 BYO 网关端点（转正时并入）。

**刻意不做**：卡点 #1 #2 #5 #6 #7（最贵的部分），以及 #4（语义落差，属产品决策）。范围与非目标的完整表述见[产品视角](./feature.md)。

## 关键实现决策：复用现成两端，不写新适配器

`examples/src/11-sandbox-cloudflare.ts:141-148` 已验证「客户端↔网关同进程直连」的打法（当时对面是 fake sandbox）。本项目把 fake 换成真的 `getSandbox(env.Sandbox, id)`：

```
createSandboxGateway({ getSandbox: id => getSandbox(env.Sandbox, id) })   ← 网关（./worker 入口）
cloudflareWorkspace({ fetch: req => gateway.fetch(req) })                 ← 客户端（. 入口）
```

**否决了「新写一个 CF 直连适配器」**：那要把网关里 `CfSandboxLike` → `NimboFS/NimboExec` 的翻译逻辑重抄一遍，徒增一份没有测试覆盖的代码；而进程内直连复用的是两端都已有契约测试的实现。代价是文件操作仍走一遍 JSON+base64 编解码——对「能不能跑通」这个命题无影响。真上生产时可再抽直连适配器省掉这层。

## 发现的缺陷：网关向 DO stub 传 AbortSignal（`@nimbo/sandbox-cloudflare`）

**这是 spike 阶段的第一个真实产出**，且不是 spike 特有的问题——它命中的是所有真机路径。

首次在真实 CF 沙盒上跑 `/sandbox-check` 的结果：文件往返 ✅ 成功，`exec` ❌ 报

```
sandbox exec failed: AbortSignal serialization is not enabled.
```

**根因**：网关 `worker.ts:413` 把 HTTP 请求的 `request.signal` 传入 `handleExec`，`:348` 又把它作为 `signal` 传给 `sandbox.exec()`；而这里的 `sandbox` 是 `getSandbox()` 返回的 Durable Object stub。CF 官方文档明确：

> "AbortSignal objects do not persist across Durable Object RPC boundaries."
> "the controller must be constructed within the Durable Object itself."

文件方法不受影响，因为它们只传字符串。

**影响面**：这套接线与当时 `examples/cloudflare-gateway-ref/`（已并入本项目）所描述的真机部署**完全一致**——所以该缺陷同样命中已文档化的真机网关路径。并入之后两个角色共用同一条 `getSandbox` 接线，`stripAbortSignal` 对二者一并生效，**对外网关端点因此是通的**。

**为什么一直没被发现**（两个盲区叠加）：

1. 网关契约测试 `protocol.test.ts` 用的是 **fake sandbox**——普通对象、无 RPC 边界，传 `AbortSignal` 天然没问题。测试还在 `:271` 明确断言「abort 经网关传播到 `sandbox.exec` 的 signal」，把一条**在真实拓扑下不可能成立**的契约固化了下来。
2. `examples/src/11-sandbox-cloudflare.ts` 的真机段按其自身注释「从未真正跑过，只是编译通过」。

> 教训：当替身与真实运行时存在**能力差异**时，「有契约测试覆盖」并不等于覆盖了真实路径。

**本项目侧处置**：用本地包装器 `stripAbortSignal()` 剥掉 `exec` 的 `signal`，**不改产品代码**——把「验证命题」与「修包」解耦。代价是客户端 abort 不再能中断沙盒内正在跑的命令（会跑到 `timeout` 为止）；客户端侧取消语义不受影响，`cloudflareWorkspace` 自己的 `raceAbort` 仍保证及时返回 130、绝不永久挂起。

**待定：包该怎么修**（需拍板，因为会推翻 `protocol.test.ts:271` 的既有断言）：

| 方案 | 取舍 |
|---|---|
| A. 彻底不转发 signal | 最简单，契合唯一真实拓扑；失去非 DO 宿主下的取消能力 |
| B. 加 `forwardAbortSignal` 选项，默认关 | 保留两种能力；为一个真实拓扑下恒为 false 的开关增加 API 表面 |

两者都属 patch（当前行为在真沙盒上 100% 不可用，改动不破坏任何**能工作**的用例）。

## 前置条件（非代码）

| 项 | 状态（2026-07-20） |
|---|---|
| Workers Paid 计划（CF 沙盒无免费层） | 待确认 |
| Docker 守护进程（`wrangler dev` 跑容器必需） | ✗ 未运行 |
| `wrangler login` | ✗ 未登录 |
| Node v24.11.1 | ✓ |

## 阶段状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| S0 | 现状盘点：确认 chat 未接 CF、定位七个卡点 | ✅ 完成 |
| S1 | 骨架：wrangler 配置 + Dockerfile + Worker 入口 + 三个路由 | ✅ 完成（typecheck 通过） |
| S2 | 本地跑通 `/sandbox-check`（零凭证探针） | ✅ 完成（见下方实测结果） |
| S3 | 本地跑通 `/agent`（真 agent 会话） | ✅ 完成（见下方实测结果） |
| S4 | 结论：是否投入完整移植，以及卡点 #4 怎么处理 | ⏸ 待拍板 |
| S5 | 转正为示例项目 + 并入 BYO 网关端点（`ALL /gateway/*`）| ✅ 完成（typecheck / 全库测试绿；真机网关待用户部署后回填） |

## S2 实测结果（2026-07-20，`wrangler dev` + OrbStack 本地容器）

`GET /sandbox-check` 三项全过，耗时 696ms：

| 检查 | 结果 |
|---|---|
| `exec` | `exitCode: 0`，`uname` 返回真实 Linux 容器；`pwd` = `/workspace`（沙盒默认工作目录，虚拟根 `/` 即锚在此） |
| 文件往返 | `matches: true` —— `writeFile`/`readFile` 经网关翻译打通 |
| 同源工作区 | `matchesFileTools: true` —— bash `cat` 读到了文件工具刚写的内容 |

**证实**：Worker 内经 DO binding 直连驱动真实 CF [沙盒](../../terms.md)成立；进程内直连（复用现成网关两端、短路 TCP）的打法成立；exec 与文件工具落在同一个盘上。

**尚未证实**：`onOutput` 的**流式**输出。上面的 `stdout` 取自终块 exit 事件（`result.stdout`），不是流式回调；exec 整体没失败说明回调跨 DO RPC 没有直接报错，但「输出是否边跑边流回来」需 S3 的 agent 会话才能观察到。

## S3 实测结果（2026-07-20）—— 命题成立

`POST /agent`，prompt 要求模型两种工具各用一遍（`write-file` 写 + `bash cat` 读回验证）：

```json
{"ok":true,"durationMs":6777,
 "finalResponse":"内容一致！文件 /hello.txt 已成功写入…并通过 cat hello.txt（相对路径）验证，输出与写入的内容完全一致。"}
```

**独立核验**（另起一次请求，经调试路由直查沙盒，不采信模型自述；该路由当时叫 `GET /exec`，转正时为与网关协议的 `/exec` 端点区分而改挂 `GET /debug/exec`）：

```
-rw-r--r-- 1 root root 31 Jul 20 13:38 hello.txt
---CONTENT---
你好，世界！Hello, World!
```

文件真实存在、内容与模型所述逐字一致。

### 由此证实

1. **命题成立**：Hono + nimbo 跑在 CF Worker 里，经 `getSandbox(env.Sandbox, id)` 直连驱动真实 CF [沙盒](../../terms.md)，完整 agent 会话跑通。
2. **`ai` SDK 的模型调用在 workerd 上可用**（DeepSeek 直连）。
3. **nimbo 的 agent loop 在 workerd 上可用**，工具调用落到真沙盒。
4. **[sandbox 技术方案 §7](../../host/sandbox/tech.md) 关于 CPU 时限的论断在真实 agent loop 下站得住**：6.8s 墙钟里绝大部分是等模型/等沙盒的 I/O，未触及任何限制。
5. **沙盒实例跨请求留存**：`hello.txt` 由 `/agent` 请求写入、由后续另一次调试路由请求读到——同一 `sandboxId` 命中同一 DO/容器。这是后续做「[沙盒](../../terms.md)与 [conversation（会话）](../../terms.md) 1:1 绑定」的基础。

### 仍未证实

- **`onOutput` 的流式输出**。两次 exec 的 `stdout` 都取自终块 exit 事件；回调跨 DO RPC 没有报错，但「输出是否边跑边流回来」需要一条长跑命令 + 观察分块时序才能确认。chat 的流式体验依赖它，**完整移植前应补测**。

### 风险版图的变化

spike 阶段的意义在于**风险转移**：CF 侧的「能不能行」这类未知数已全部落定，剩下的卡点 #1 #2 #5 #6 #7 都是**有确定解法的常规移植工作**（换 D1 驱动、改导入方式、改 env 读法），不再是可行性问题。唯一仍需**产品决策**而非工程实现的，是卡点 #4 的语义落差。

## 变更记录

- **2026-07-20（晚）转正为示例项目 + 并入 BYO 网关（✅）**：用户定案——这个 spike 不作为一次性探针丢弃，而是转正为**一个巨大的示例**，并把 `examples/cloudflare-gateway-ref/`（11 号真机段的 BYO 网关参考料，3 个文件、无 package.json、不装依赖不进 CI）**整个并入**。理由：两者本就共用同一套 `getSandbox` 接线，`wrangler.jsonc`/`Dockerfile` 近乎逐字重复，而参考料那侧还带着一个从未被发现的真机缺陷（AbortSignal 跨 DO RPC）——合并后 `stripAbortSignal` 对两条路径一并生效，真机网关路径**因此才第一次是通的**。具体改动：`apps/chat-worker-spike/` → `apps/cloudflare-worker-server/`（包名 `@nimbo-chat/worker-spike` → `@nimbo-chat/cloudflare-worker-server`，wrangler name → `nimbo-cloudflare-worker-server`）；新增 `ALL /gateway/*` 路由（剥掉 `/gateway` 前缀后转交 `createSandboxGateway`，鉴权走 secret `NIMBO_GATEWAY_TOKEN`，未配置返回 503 而非退化为无鉴权）；原调试路由 `/exec` 改挂 `/debug/exec`（避免与网关协议的 `/exec` 端点混淆）；删除 `examples/cloudflare-gateway-ref/`，其全部引用（examples README/11 号脚本/tsconfig 注释、`packages/sandbox-cloudflare/README`、docs features·tech·plans）改指本项目。**接入方式随之改变**：以前是「拷 3 个文件进你自己的 wrangler 项目」，现在是「直接部署这个现成项目」，但仍需自备 CF 账号 + Workers Paid 计划；客户端 `NIMBO_CF_GATEWAY_URL` **必须带 `/gateway` 前缀**（客户端把端点常量直接拼在 url 后，网关按 pathname 精确匹配）。同期完成一次无关重命名：`apps/server` → `apps/node-server`（包名 `@nimbo-chat/server` → `@nimbo-chat/node-server`），与本项目形成 node/worker 两个服务端形态的对称命名。文档按仓库规范补齐三份：[产品视角](./feature.md) / [技术方案](./tech.md) / 本文（由 `chat-on-workers-spike.md` 改名重写）。**验证**：`@nimbo-chat/cloudflare-worker-server` 与 `@nimbo-chat/node-server` typecheck 均 exit 0；node-server 243 用例、`@nimbo/sandbox-cloudflare` 48 用例、examples typecheck 全绿。真机网关端点待用户部署后回填。
- **2026-07-20**：立项。起因是「本地跑 chat + CF worker 当后端沙盒」的诉求，盘点后发现该组合不存在——chat 只支持 `vercel`/`e2b`，且 [沙盒 provider 产品文档](../../host/sandbox-provider/feature.md)明确把 Cloudflare 列为非目标。澄清后诉求实为「把 chat 装进 Worker 再用 CF 沙盒」，遂立本 spike 去风险。经确认交付深度为最小打通 spike，卡点 #4 的语义落差 spike 阶段不处理。
