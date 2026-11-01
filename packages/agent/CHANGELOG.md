# @runko/agent

## 0.2.0

### Minor Changes

- ee83d06: **多副本 + 广播式流分发时，`subscribe` 不再在「这一轮跑在别的副本上」时就地收线。**

  `StreamFanout` 多了一个可选的 `crossInstance` 标志，说明这份实现会不会把别的进程发的帧也送过来（`@runko/stream-redis` 自报 `true`，内置的进程内实现是缺省的 `false`）。框架据它决定要不要继续等：

  - 进程内那一档不变：等也等不到，就地收线，宿主该转发转发、该重连重连。
  - 广播那一档留着等：内容马上从别的副本过来，收尾时那一帧 `activity: false` 同样会到，收线时机与本地一致。

  跟远端这条路自带两道兜底，因为「收尾那一帧一定会到」并不成立：

  - **回放期间收到的收尾广播不会白丢**。帧本身照旧被清掉（紧接着的权威快照会覆盖它），但它带的信息留着——否则正好落在「远端已广播、尚未释放归属」那段窗口里时，订阅方会去等一帧永远不会再来的帧，流就挂死了。
  - **跟远端时定期复查一次归属**。持有者被 `kill -9` 且没人接管时，没有任何进程会广播收尾帧；归属一没就自己补一帧 `activity: false` 收线。

  没有这个标志时，配了 Redis 的多副本部署会静默退化——连到非持有者副本只收到两帧快照流就关了，正在跑的那一轮一个字也看不到。

- 4a936b9: **节点下线改成「交权」：正在跑的对话几百毫秒内交给别的节点接着跑，不再中断。**

  破坏性变化：

  - `shutdown()` 不再中止正在干活的轮：模型输出段的那半步扔掉、由接手节点重新生成；正在跑的工具留在本节点上跑完，结果写进库里由接手节点结清；等人的照旧挂起。它会等本节点上的工具跑完才返回。
  - `ShutdownResult` 换成 `{ handedOver, suspended, aborted, target, transferred, delegated, tails, settled, pending }`。
  - `TurnStatus` 多了 `"handed-over"`，`Frame` 多了 `{ kind: "reconnect" }`（请重连帧：只发给本进程的订阅者，接入层收到就让客户端立刻重连）。对它们做穷尽 `switch` 的宿主要补分支。

  新增：

  - `handover` 配置：本节点地址、发布序号、节点登记表（`NodeRegistry`，内置 `memoryNodeRegistry()`）、出站「请接手」回调、交接预留有效期。下线时先挑一个版本不比自己旧的节点，把对话预留给它，再请它接手；挑不到就给对话打待接手标记。
  - `runtime.start()`：开始服务后调一次——登记节点、开心跳与定时回捞，并马上扫一遍待接手的对话。`runtime.takeOver(ids)`：被别的节点请接手时调。
  - 定时回捞（`sweep.interval`，缺省 10 秒）：找没人持有、没有有效预留、但有活没干完的对话推一把，兜住「排队的消息没人推」「下线期间答了卡片没人恢复」「接手节点挂了」。
  - `toolTimeout`（缺省 `"2m"`）：单次工具执行的上限，平时与交权时一样生效。
  - 工具在别的节点上收尾时用户按停止：记一个停止标记，那个节点查到就杀掉工具，结清之后不再调模型。
  - 节点下线期间来的消息**不再拒绝**：排进队列、交给接手的节点。
  - 用户已经按了停止的一轮不会被交出去；交权之后还没人接着跑时按停止，补一条「已停止」。
  - 新宿主钩子 `onHandOff`（交权放手之前、会等它）：宿主在这里存下接手节点要用的东西，比如进程内沙盒的快照。
  - `OwnershipInfo.reserved`：报出「这是一份交接预留、没人真持有」，被预留的节点据此认出「正要交给我」。
  - 单进程（进程内仲裁）挑不到接手节点时，关闭照旧中止：交出去的对话重启后没人找得到。
  - 接口新增的方法全部可选：`Grant.releaseTo`、`Arbitration.markAwaitingTakeover` / `clearAwaitingTakeover` / `listSweepCandidates`、`Persistence.tails`。没实现的宿主照常能用，只是交权退化成「普通放手」。内置实现（`memoryPersistence`、`inProcessArbitration`）已带上。

- 1489739: 多副本部署下，接入层现在拿得到「这份对话归谁」这个事实。

  - `enqueue` 因 `held_by_other` 被拒时，结果多一个 `holder` 字段。以前这个地址只出现在
    给人看的 `message` 文案里，接入层要转发只能去字符串里抠。其余四种拒绝原因不带这个字段。
  - `subscribe` 发出的轮状态快照改用权威答案：本进程的登记表没有这份对话时，去问归属仲裁。
    以前它只看本进程，于是一份正跑在别的副本上的对话会被报成「没有轮在跑」，接入层既不知道
    该转发、也没法告诉用户这一轮在别处。单进程下行为一字不变，也不会多打一次库。
    **归属报的是本进程自己上一次的 `holder` 时不算「有轮在跑」**——那是收尾窗口（先删登记表、
    再释放归属），不是「跑在别的副本上」；不排除它的话，最后一帧会说「还在跑」然后流立刻断掉。

- 0b912e9: 挂起有了自己的配置项：`suspend.memoryWindow`、`suspend.onPresence`，以及 `runtime.reportPresence(conversationId)`。

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

- 0b912e9: 人回来答了挂起的审批或提问，**在任意一个副本上**开一轮恢复，把那次调用接上。这是挂起与恢复（路线图 K3）的第四步，主链路就此打通。

  **`submitDecision` / `submitAnswer` 多了一条路**：等人项还在本进程内存里（内存窗口内），照旧直接交给正在等的那一轮；不在了（已经挂起，或者在别的副本上等着），就把答案写进裁决表那一行，然后开一轮恢复。恢复轮**用账本里原封不动的参数执行**，模型看到配好对的调用与结果。

  **裁决表当收件箱**：人答的那一刻不一定能马上开恢复轮（比如同一条消息里另一个调用的恢复轮正在跑）。答案先落库，占着会话的那一轮收尾时会读到它——交汇点在数据库里，所以跨副本也不会漏，挂起之后的答复**不需要转发**给谁。

  **恢复轮**：不追加用户消息；交给 `prepareTurn` 的 `input` 是空文本、`userId` 是答复人，另带 `resume: { callId }`；恢复轮装配期间点停止，那次调用按**拒绝**结清；装配失败时账本一个字不动，等下一次有人发消息时重试；**恢复没做成（它要结清的调用还悬着）就不自动重试**，避免命令被一遍遍执行。

  **账本里同一个 `message.id` 可能出现两次**：恢复轮原地改写挂起那一轮的最后一条消息，以新 seq 追加。读的时候按 id 折叠（位置取首次出现、内容取最新），`@runko/agent` 自己读账本时已经这么做了；**宿主自己读 `readLedger` / `subscribe` 回放时也要按 id 覆盖**——新导出的 `foldById` 就是干这个的。

  **崩溃与接管**：

  - 裁决表里的**孤儿行**（在内存里等人时进程崩了，这一行再也不会有人结清）在启动扫描与接管时结成 `timeout`。正在挂起、等人回来的行不动——两类靠账本区分。
  - **账本末尾有悬空调用时，不再补「已停止」标记**。补了会把悬空调用埋进历史中间，这个会话此后每次调模型都会被拒。
  - 恢复轮执行到一半崩溃：重启后自动重试。**那条命令可能会被执行第二次**——崩溃不是干净边界，宁可至少执行一次，也不让人批准过的操作静默丢失。

  **登记先于结清**：人在回路桥登记待定裁决不再是「发出去就不管」。结清之前、以及一轮放手之前，都会先等登记落库——否则连接池下结清可能跑在登记前面，留下一条永远待定的行。

  **只接受「账本末尾还悬着」的调用**：答复落到挂起路径时，那次调用必须真的悬在账本末尾，否则返回 `false`（接入层转 404）。这挡住两种错答：崩溃留下的孤儿行（答了也没有东西可恢复），以及这一轮正被停止、拒绝还没写进去的那一瞬（审计表会与实际发生的相反）。已经答过、但恢复没做成的调用，再答一次照样是 `false`，但会**顺手再推一把**。

  **`submitAnswer` 多了可选的第四个参数 `{ decidedBy }`**：挂起之后答的，恢复那一轮以答复人的身份跑（推送、钩子靠 `userId` 找人）。

  **撤回时替被顶掉的持有者收尾**：起轮或开恢复轮时发现会话在等人而撤回，如果这次抢归属顶掉了一个过期持有者，会先替它收拾孤儿行——否则那几行一直悬着。收拾孤儿行失败只记日志，不挡住后面补「已停止」标记。

  **⚠️ 不兼容：自己实现持久化的宿主要补一个方法**：`DecisionStore` 新增**必需**的 `get(conversationId, toolCallId)`，读回一行（结没结清都返回；没有就是 `undefined`）。`@runko/persist-*` 与内置的内存实现都已补上，一致性套件有对应用例。

  `DrivenSession` 新增**可选**的 `settleAndRun`（自定义 session 工厂不必跟着改；缺了它的 session 遇到恢复轮会以明确的错误收尾）。补上了 `SuspendReason` 类型的导出。

- 0b912e9: 等人等过窗口不再当成「拒绝」，而是**挂起**：这一轮落盘退出、放掉归属，那次调用原样留在账本里等人。人回来之后怎么接上，见同批的「恢复」那条。

  **⚠️ 行为不兼容**：以前窗口到点，审批按拒绝结掉、`ask-user` 返回一句「用户没回应」，这一轮**接着往下跑**；现在这一轮以 `suspended` **收尾**，要等人答了才继续。依赖「超时后自动往下走」的宿主要留意。窗口的配置与缺省值见同批的「配置项」那条。

  **窗口到点**：

  - 审批：这一轮以 `suspended` 收尾，**裁决表那一行保持未结清**——人回来答的就是它。
  - `ask-user`：调 `ctx.suspend()` 挂起。
  - **整轮挂起**：一个等人项到点，这一轮所有还挂着的等人项一起挂起；同一轮里再来的等人请求立刻挂起，不再各开一个新窗口。
  - 收尾 metadata 带 `suspended: { callIds, reason }`，`onTurnSettled` 收到 `status: "suspended"`。
  - **登记裁决表失败时不挂起**：没有那一行，挂起之后就永远没人能答。这时退回老结局——审批按拒绝（理由说明原因）、提问按「没人回应」——这一轮照常往下走。
  - **窗口里接下的插话不会丢**：挂起时还没注入的插话转进待发队列，人答完之后作为普通消息发出。

  **挂起之后不开普通轮**（账本末尾有悬空调用时，再追加用户消息会被模型服务商拒掉）：挂起那一轮收尾时不自动出队；这期间 `enqueue` 来的消息只入队、不起轮（队列关着时报 `busy`，文案说明是在等人）；判断在**抢到归属之后**做，多副本下也成立。

  **交权**（`shutdown()`）：关闭那一刻**正在等人**的轮改为挂起（`reason: "handover"`），不再中止。其余的轮照旧中止。`ShutdownResult` 多一个 `suspended` 计数。

  **用户点停止不变**：等人项照旧结成拒绝并写进裁决表。

  `AskUserOutcome` 多一个 `{ outcome: "suspended", reason }`；新导出类型 `SuspendReason`。`ASK_USER_TIMEOUT_MESSAGE` 保留，用于「这一轮已被停止」与「登记失败、不能挂起」。

- 2072231: 多副本下，持有者崩溃、随后被别的副本接管时，崩溃的那一轮现在会在账本里补上「已停止」。

  以前给崩溃那一轮补「已停止」的只有进程启动时的 `recover()`。多副本下常常是别的副本先接手：接手时租约行被覆盖，此后谁重启都扫不到它，那一轮在账本里永远只剩一条用户消息。

  - `@runko/agent`：`AcquireResult` 的成功分支新增可选字段 `takeover?: { holder?: string }`，表示这次抢占顶掉了一个过期的持有者。轮编排据此在新一轮开跑前，先替上一轮补一条「已停止」标记（理由：`The node running this turn stopped responding; another node took over.`），并广播给已经连着的订阅者。新增导出类型 `Takeover`。不报这个字段的自定义仲裁实现照常可用。
  - `@runko/agent`：修掉一处竞态——从抢到归属到开始驱动这一轮之间，如果归属已经丢了（比如库卡住、心跳触发自我围栏），这一轮以前会照常装配、跑模型，而每次写账本都被拒；现在会直接按中断收尾。
  - `@runko/persist-kysely`：租约版仲裁（以及透传它的 `sqliteArbitration` / `postgresArbitration` / `mysqlArbitration`）在顶掉过期持有者时报 `takeover`。
  - `@runko/conformance`：新增一组可选导出 `arbitrationTakeoverReportCases`（报 `takeover` 的实现才接）；「正常抢占不报 `takeover`」「`clearStale` 之后再抢不报」两条并入原有的组，不报这个字段的实现天然能过。

  仍有一条路径补不上标记：持有者被冻住超过自我围栏的余量、期间没有任何副本来接管，它醒来后自己停手并释放了租约。这种情况下那一轮依旧只剩用户消息。

### Patch Changes

- 4a936b9: **一轮显示「完成」时一定已经存好了；排队的下一轮紧接着跑，不再断流。**

  - `@runko/core`：`RunkoError.code` 新增 `internal_error`（系统异常）。core 自己不产出，留给编排层报 core 之外的故障；它的 `message` 是一句不含细节的通用话。对 `code` 做穷举（比如 `Record<RunkoError["code"], …>`）的代码要补上这一项。
  - `@runko/agent`：一轮的收尾帧（`message-metadata`）现在排在这一轮的成品消息帧**之后**——订阅者收到「完成了」时，回复已经写进账本。成品消息没能全部写进账本（库出错、写入被拒、归属丢了）时，不再发「完成了」，改发 `status: "failed"` + `internal_error`，并尽量补一条失败标记；具体原因只进日志。
  - `@runko/agent`：一轮收尾时[待发队列](https://github.com/ludafa/runko/blob/main/docs/terms.md)里还有消息，持有者**不放手归属**，直接出队起下一轮；两轮之间不再广播 `activity:false`，`subscribe()` 的同一条订阅一路收到整个队列跑完。队列排空、最后一轮跑完才广播 `activity:false` 并放手。

- Updated dependencies [e00ae29]
- Updated dependencies [4a936b9]
- Updated dependencies [a933c31]
- Updated dependencies [a933c31]
  - @runko/core@0.2.0
  - @runko/virtual-fs@0.1.3

## 0.1.2

### Patch Changes

- 63d90e5: 修复 **0.1.1 无法用 npm 安装**的问题。

  0.1.1 的发布产物里，`zod` / `kysely` / `just-bash` 等依赖的版本范围写的是 pnpm 的
  `catalog:` 协议原文。npm 不认识这个协议，安装时直接报错：

  ```
  npm error code EUNSUPPORTEDPROTOCOL
  npm error Unsupported URL Type "catalog:": catalog:
  ```

  原因是发布流程改用 `npm publish`（为了 OIDC 与 provenance）后，只把 `workspace:`
  换成了真实版本，漏了 `catalog:`。0.1.2 起两个协议都会解析，并在发布前断言不留任何
  pnpm 私有协议；发布后还会用 npm 真装一次做兜底验证。

  **0.1.1 请勿使用**，直接升到 0.1.2。0.1.0 不受影响（它是用 `pnpm publish` 发的）。

- Updated dependencies [63d90e5]
  - @runko/core@0.1.2
  - @runko/virtual-fs@0.1.2

## 0.1.1

### Patch Changes

- c29a6eb: 补上 `repository` 字段，指向 https://github.com/ludafa/runko。

  npm 包页面此前没有任何指向源码的链接（0.1.0 首发时漏了这个字段）。现在每个包都带上仓库地址与自己在
  monorepo 里的子目录（`directory`），npm 上的「Repository」入口会直接落到该包的源码目录，而不是仓库根。

- Updated dependencies [c29a6eb]
  - @runko/core@0.1.1
  - @runko/virtual-fs@0.1.1

## 0.1.0

### Minor Changes

- 51d94e6: **修一个会把会话写死的 bug**：收尾标记曾经写成 `parts: []`。

  ai 的 `validateUIMessages()` 拒绝空 parts（`Message must contain at least one part`），而**每一轮起轮都要拿整个账本过一次校验**——账本里只要有一条这样的行，这个会话此后**永远起不了新轮**，每次都栽在 resume 上。

  产出空 parts 的有两处，都已改成 `[{ type: "step-start" }]`（core 自己在「首步之前就失败」时用的同一个占位）：`recover()` 补的孤儿轮收尾，以及停止 / 失败路径写的收尾标记。

  **存量数据会自愈**：`buildResumeState` 现在会滤掉 parts 为空的行，所以早期版本写坏的账本不用清库也能继续用。

  > 单测抓不到它——测试用的假 session 不跑 `validateUIMessages`。是真机验证「`kill -9` 后崩溃恢复」时暴露的：恢复本身成功了，但那个会话之后再也起不了轮。

  > 级别是 **minor 而不是 patch**：它同时改变了账本里落盘的消息形状（收尾标记从空 parts 变成一个 `step-start`），宿主若靠 `parts.length === 0` 认收尾标记会失配。

- 3029ae3: 修掉轮编排收尾路径上的一批问题，其中一条会**锁死会话并拖垮进程**：

  - **收尾五步现在逐步兜底，`runToCompletion` 也接了 `.catch`。** 此前是裸跑：广播「没有轮在跑了」那一步一旦抛错（流分发实现遇到基础设施故障时是允许抛的），后面的删登记 / 释放归属 / 出队全被跳过——这个会话被**永久锁死**，此后所有消息只排队、再也起不了轮；同时产生一个没人接的 promise rejection，在 Node 默认的 `--unhandled-rejections=throw` 下直接把进程带走。
  - **`subscribe` 不再丢掉收尾窗口里的那条成品消息。** 回放期间攒下的缓冲原来被整个清空，而 `finalize` 广播的 `message` 帧既不在回放里、也不在草稿里——用户在一轮收尾窗口里刷新页面重连，助手的回复会整条消失。现在只丢 chunk 与快照帧，`message` 帧就地补发。
  - **`finalize` 不会再跑两遍。** 它自己抛错时，catch 分支会重新取号写同一批消息——账本里同一条回复出现两行。
  - **装配失败时，用户那句话和「失败」标记都落账本了。** 此前只发一帧直播 chunk（chunk 不落库），而 `enqueue` 早就回了 `mode:'started'`——刷新页面后那句话凭空消失。「已停止 / 失败」标记同理，现在重连和回放都看得到。
  - **`subscribe` 接受一个传进来时就已经 abort 的 signal。** 此前 `follow:'forever'` 会永远不收线、订阅者一直留在流分发的监听表里，每断一次漏一个。
  - **`abort()` 在清完队列后重新确认登记表**，不再对一个已经收尾的轮谎报「已停止」。
  - **`settleAllPending` 直接对着传进来的那一轮结清**，不再按 conversationId 回查——两者不是同一个对象时会去拒掉另一轮的挂起项。

  **破坏性**：删掉了导出的 `ABORT_BEFORE_START_MESSAGE`。框架从不发这个文案（走的是 `abortReason ?? ABORT_REASON_USER`），宿主照它做匹配永远匹配不上。

- 3029ae3: `queue.steer` 多了一档：**回调**。

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

- 3029ae3: 新包 `@runko/agent`——轮编排运行时。

  `@runko/core` 给的是「跑一轮」，这个包给的是「**一轮接一轮地跑下去**」：

  - **一轮的一生**：起轮占位 → 装配 → 驱动 → 收尾，全套失败路径都有交代（装配抛错、生成器抛错、跑到一半失去独占权）。
  - **待发队列与插话**：`enqueue` 一个函数管三种情况（空闲起新轮 / 忙就排队 / 插进当前这一轮），收尾时自动出队；「查完队列没活儿了到真正释放归属之间用户又发了一条」那个竞态由框架内部兜一次，构建者不需要知道它存在。
  - **人在回路**：审批与 `ask-user` 两条通道 + 内置 `ask-user` 工具，人的答复经 `submitDecision`/`submitAnswer` 送回正在 `await` 的 loop；裁决落库留底。
  - **停止 / 交权 / 崩溃恢复**：`abort()` 停一轮并清队列，`shutdown()` 停掉全部并等收尾，`recover()` 启动扫描给孤儿轮补「已停止」。
  - **四样宿主能力可替换**（沙盒 · 持久化 · 流分发 · 归属仲裁机制），**都带内置的平凡实现**，所以零配置就能跑。

  进行中的 chunk 一律不落库（内存草稿，重连时整份重发靠幂等吸收），账本从此只写成品消息。

  挂起与恢复、租约版归属仲裁不在这一批，接口已按它们定形。

- 48b461b: **新包 `@runko/conformance`：宿主能力的契约一致性套件。** 写了一个 `Persistence` 或
  `Arbitration` 实现，装上它就能验合不合契约——接口注释里那些写死了却从没验过的承诺
  （同一个 seq 重复写入不得写出两行、`settle` 对已结清的返回 `false` 而不是抛、取号一律
  不抛错……）全部变成可执行断言。runko 自己的五个官方持久化实现跑的就是这一份。

  **它不依赖任何测试框架。** 套件只导出**用例数据**（`{ name, run }`），`describe` / `it`
  由消费方来接，所以 vitest / jest / node:test / Workers 上都能跑：

  ```ts
  import { persistenceCases } from "@runko/conformance";

  describe("我自己的实现", () => {
    for (const testCase of persistenceCases) {
      it(testCase.name, async () => {
        await testCase.run({ persistence: myPersistence() });
      });
    }
  });
  ```

  内容：**持久化 31 条**（账本 / 裁决表 / 待发队列 / 跨 Store），**归属仲裁 18 条**，按能力
  分三组导出——`arbitrationCases`（所有实现都要过）、`arbitrationMultiNodeCases`（能表达
  两个节点的）、`arbitrationTakeoverCases`（能表达超时接管的）。分组不是可选字段，是三个
  独立数组：一个本该支持接管的实现漏传 `expire`，不会静默跳过还显示绿。

  **这套东西曾经是 `@runko/agent` 的子路径导出 `@runko/agent/conformance`，现已移除。**
  它需要一套断言，而断言不该把测试框架拖进一个**运行时**包的依赖里——`@runko/agent` 因此
  不再有 `vitest` 这个可选 peer。改用新包即可，用例内容一条没少。

- 3029ae3: 裁决记录的 `scope` 从 `'once' | 'broader'` 改成 **`'once' | 'conversation'`**。

  影响 `DecisionRecord.scope` 与 `SubmittedDecision.scope` 两处。

  原来记的是含糊的「比这一次更宽」，理由是「框架不知道有『会话』这个粒度」——**这条理由不成立**：
  框架的 API 全是 `enqueue(conversationId, …)` / `subscribe(conversationId)` / `conversation-drained`，
  它当然知道。既然知道，就该记准确的范围名。

  **框架只记，不执行**：它不会在后续轮里查裁决表替宿主自动放行。记账粒度（按整条调用的入参指纹？
  按命令段拆？按用户分账？）是宿主的产品决策，框架不该替它定。

  传 `'broader'` 的宿主改传 `'conversation'`；已落库的旧值需要自己刷一遍（`scope` 只是审计字段，
  没有代码读它回来做放行判断）。

- 1282005: **新增租约版[归属仲裁机制](https://github.com/ludafa/runko/blob/main/docs/logic/arbitration/features/arbitration-impl.md)**——多进程 / 多节点共享一个数据库时，保证同一份对话同时刻只有一个执行在跑。

  `@runko/persist-kysely` 导出 `leaseArbitration(db, { flavor, holder })`：

  ```ts
  createAgentRuntime({
    persistence: kyselyPersistence(db, { flavor: "postgres" }),
    arbitration: leaseArbitration(db, {
      flavor: traitsOf("postgres"),
      holder: process.env.POD_NAME,
    }),
  });
  ```

  **它保证不了独占，只能安全地失败**——这不是实现偷懒，是分布式系统绕不过去的一条：你没法知道远处那个节点是死了还是只是联系不上。所以租约版下**一轮跑到一半可能被告知「你已经不是主人了」**然后停下，这是正常路径。两个机制分工：租期标识管「不写坏」（只拒绝、不放行），心跳管「卡住的能被接管」。

  默认 **心跳 5 秒 / 判死 60 秒**（12 拍）/ 交权宽限 15 秒，三个都可配；**阈值必须 ≥ 3× 心跳，配错构造时就抛**——阈值太短会把一次普通的调度延迟变成两个同时持有者，那是静默的数据损坏。

  [`@runko/conformance`](https://www.npmjs.com/package/@runko/conformance) 同批新增仲裁用例，按能力分三组：内存版跑「通用」一组，能表达多节点的实现另跑「多节点」与「超时接管」两组。其中**「被误判的老持有者取号一律被拒」是整个租约版唯一真正要证明的东西**，已在 SQLite / pglite / 真 Postgres / 真 MySQL 四档上跑过。

- fca6c03: 收尾状态多了第四种：`suspended`（挂起）。

  - `@runko/core`：`RunkoMessageMetadata.status` 与它的 zod schema 从三值扩到四值。
  - `@runko/agent`：`TurnStatus` 跟着扩（它原样透传 core 的收尾 metadata）。

  **挂起是主动且可恢复的**——一轮停在「正在等人」这个干净边界上收尾、释放归属，人回来之后由
  **新的一轮**接着跑。它跟 `interrupted`（宿主主动中断）不是一回事，宿主别把它当失败处理：别重试、
  别标红，界面上也不该显示成「已中断」。

  **目前还没有产出方**：core 的 `finalizeTurn` 至今只写出前三态，真正产出 `suspended` 要等挂起与
  恢复那一批。现在先进联合类型，是为了让宿主与界面提前把渲染分支占好，避免那天前后端不同步。

  对 `switch` 做穷尽性收窄（`assertNever`）的调用方需要补一个分支——这是本次唯一的破坏面。

### Patch Changes

- 85e5099: 修掉一批持久化实现的正确性问题，其中三条会**静默丢数据**：

  - **MySQL 上 ID 不再大小写不敏感。** 主键上的字符串列现在显式 `COLLATE utf8mb4_bin`。此前跟着 MySQL 8 的默认排序规则 `utf8mb4_0900_ai_ci` 走（大小写与重音都不敏感），`AbC` 和 `abc` 会被当成同一个 conversationId——跨会话读到别人的账本，主键上还会撞键、第二条 append 被静默丢掉。`tool_call_id` 尤其危险，各家模型的 call id 本来就是混合大小写。
  - **MySQL 的幂等插入不再用 `INSERT IGNORE`。** 它把所有可恢复错误一起降级成 warning（超长截断、约束失败整行跳过），调用方却拿到「写成功了」。改用 `ON DUPLICATE KEY UPDATE`，只吞重复键。
  - **并发 `enqueue` 不再重号、不再越过 `max`。** 队列的 `(conversationId, seq)` 上加了唯一约束/索引，撞号的那条换个号重来。此前是「先查最大值再插」，两个并发请求会算出同一个 seq，之后按 seq 排序平局——先到先发不再成立。
  - **`append` 撞号时会如实报 `{ ok: false, reason: 'rejected' }`。** 同一条消息重写仍是幂等；但**另一条**消息占了同一个号时，此前一律报成功，等于静默丢消息。

  **`@runko/persist-mongo` 的 `migrate()` 现在能就地升级同名索引。** 队列索引这次从非唯一改成了唯一，而 Mongo 会拒绝同名不同选项的 `createIndex`——不处理的话，从上一版升上来的人会直接崩在启动上（`IndexOptionsConflict`）。现在撞上冲突就删了重建；重建失败（存量数据违反唯一性）照常抛，那种情况需要人介入、不该静默。

  另外：`migrate()` 的承诺范围写进了 README 与 `schema.sql`（只做首建、不做演进、不能并发调），参考 DDL 随包发布（`schema.sql`），队列 `input` 列改为运行时校验而不是裸类型断言。

  一致性套件（`@runko/conformance`）新增 4 条：ID 大小写敏感（conversationId 与 toolCallId 各一条）、并发 enqueue、append 撞号报拒绝——五个实现都要满足。

- Updated dependencies [847222d]
- Updated dependencies [be08aac]
- Updated dependencies [fca6c03]
- Updated dependencies [b342e5b]
- Updated dependencies [3ffdf28]
- Updated dependencies [fca6c03]
- Updated dependencies
  - @runko/core@0.1.0
  - @runko/virtual-fs@0.1.0
