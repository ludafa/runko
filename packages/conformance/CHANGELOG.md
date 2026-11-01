# @runko/conformance

## 0.2.0

### Minor Changes

- fdc58ad: 四档持久化（Kysely 三方言 + MongoDB）现在支持[交权](https://github.com/ludafa/runko/blob/main/docs/terms.md)要用的三样东西：

  - **交接预留**：`leaseArbitration`/`mongoArbitration` 的 `Grant` 多了 `releaseTo(node, { ttlMs })`——放手的同时把这份对话预留给指定节点，预留期内只有它抢得到，过期退化成没人持有。`acquire`/`inspect` 都认这条预留。
  - **待接手 + 定时回捞**：`Arbitration` 多了 `markAwaitingTakeover` / `clearAwaitingTakeover` / `listSweepCandidates`——给挑不到接手节点的对话打标记，定时回捞据此找出「没人持有、也没有有效预留，但打了待接手标记」的对话（只认标记，不看待发队列）。`inspect` 在对话只有有效预留、还没人接上时报 `reserved: true`。
  - **节点登记表**：新增 `nodeRegistry`（Kysely）/ `mongoNodeRegistry`（Mongo），三个薄壳也各自导出 `sqliteNodeRegistry` / `postgresNodeRegistry` / `mysqlNodeRegistry`——登记节点地址、发布序号、状态、心跳，指定交接据此挑一个版本更新、负载更轻的存活节点接手。
  - **工具收尾**：`Persistence.tails` 现在四档都实现了——交权那一刻还在跑的工具，结果写进这张记录，接手节点据此结清那次悬空调用。

  Kysely 三方言新增 `agent_handover` / `agent_nodes` / `agent_tool_tails` 三张表（`migrate()` 已包含，`schema.sql` 同步更新）；MongoDB 新增 `agent_nodes` / `agent_tool_tails` 两个集合，交接预留直接放在 `agent_leases` 文档上（不用跨集合事务）。三个薄壳包（`persist-sqlite` / `persist-postgres` / `persist-mysql`）跟着把节点登记表的工厂函数转发出来。

  `@runko/conformance` 新增三组用例：`handoverCases`（交接预留 / 待接手 / 定时回捞）、`nodeRegistryCases`（节点登记表）、`toolTailCases`（工具收尾），随包导出配套的 setup 类型。

- 6d89983: 进程崩溃后**按同一个名字重启**，上一次留下的租约立刻算陈旧——不用再干等一个接管阈值（缺省 60 秒）。

  陈旧判据多了一支：**这条租约挂在我自己的 `holder` 名下，而它最后一次心跳早于我这个进程启动的时刻**。一个刚起来的进程不可能已经在跑任何一轮，所以这种租约一定是上一辈子留下的。`listStale`、`clearStale`、`acquire` 三处用同一条判据。

  **影响**：崩溃后马上重启的宿主，那些没跑完的会话在启动扫描时就被补上「已停止」标记，重启完即可用；此前要等接管阈值过去，这段时间里会话既发不了消息、也看不出已经停了。

  **前提是每个进程的 `holder` 唯一**（k8s 里同一个 pod 重启后名字不变，正合适）。两个活着的进程配成同一个名字时，后起来的那个会把先来的那一轮抢过去——先来的手里的租期标识已经作废、写不进账本，所以坏的是那一轮，不是数据。

  `@runko/conformance` 因此多了一组用例 `arbitrationRestartCases`（5 条，配套的 setup 类型是 `RestartConformanceSetup`）。**自己实现了归属仲裁的宿主**：接上这一组会要求你也支持同名重启即刻回收；看得见「上次崩溃残留」的实现才需要跑它，内存版那类不用接。

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

- 0b912e9: 持久化一致性套件多了 5 条挂起与恢复的要求，并进 `persistenceCases` 一起跑（共 40 条）：

  - 悬空调用原样往返：「待审批」的工具部件与带 `suspended` 的收尾 metadata 读回来一字不差；
  - **同一个消息 id 以新 seq 再追加，两行都要在**——恢复轮就是这样改写上一轮最后那条消息的，按 id 去重或覆盖的实现会让恢复读错；
  - 只读账本末尾一条时，读到的是改写后的那一行；
  - **两个副本同时结清裁决表同一行，恰好一个成功**，读回的是成功那一个的答案；
  - 提问的答案原文读回（多行、中文、引号都不走样）。

  自己实现持久化的宿主升级后请重跑一遍套件。

- 2072231: 多副本下，持有者崩溃、随后被别的副本接管时，崩溃的那一轮现在会在账本里补上「已停止」。

  以前给崩溃那一轮补「已停止」的只有进程启动时的 `recover()`。多副本下常常是别的副本先接手：接手时租约行被覆盖，此后谁重启都扫不到它，那一轮在账本里永远只剩一条用户消息。

  - `@runko/agent`：`AcquireResult` 的成功分支新增可选字段 `takeover?: { holder?: string }`，表示这次抢占顶掉了一个过期的持有者。轮编排据此在新一轮开跑前，先替上一轮补一条「已停止」标记（理由：`The node running this turn stopped responding; another node took over.`），并广播给已经连着的订阅者。新增导出类型 `Takeover`。不报这个字段的自定义仲裁实现照常可用。
  - `@runko/agent`：修掉一处竞态——从抢到归属到开始驱动这一轮之间，如果归属已经丢了（比如库卡住、心跳触发自我围栏），这一轮以前会照常装配、跑模型，而每次写账本都被拒；现在会直接按中断收尾。
  - `@runko/persist-kysely`：租约版仲裁（以及透传它的 `sqliteArbitration` / `postgresArbitration` / `mysqlArbitration`）在顶掉过期持有者时报 `takeover`。
  - `@runko/conformance`：新增一组可选导出 `arbitrationTakeoverReportCases`（报 `takeover` 的实现才接）；「正常抢占不报 `takeover`」「`clearStale` 之后再抢不报」两条并入原有的组，不报这个字段的实现天然能过。

  仍有一条路径补不上标记：持有者被冻住超过自我围栏的余量、期间没有任何副本来接管，它醒来后自己停手并释放了租约。这种情况下那一轮依旧只剩用户消息。

### Patch Changes

- 73bdf67: `@runko/agent` 从 peer 依赖改成普通依赖（套件只用到它的类型）。你自己装的 agent 与套件依赖的版本一致时，包管理器会合并成一份；**升级 agent 时请把本包一起升级**——版本不一致时，安装阶段不会再给出 peer 不匹配的提示，类型检查也不一定能发现（接口新增的方法大多是可选的）。
- Updated dependencies [ee83d06]
- Updated dependencies [4a936b9]
- Updated dependencies [1489739]
- Updated dependencies [4a936b9]
- Updated dependencies [0b912e9]
- Updated dependencies [0b912e9]
- Updated dependencies [0b912e9]
- Updated dependencies [2072231]
  - @runko/agent@0.2.0

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
  - @runko/agent@0.1.2

## 0.1.1

### Patch Changes

- c29a6eb: 补上 `repository` 字段，指向 https://github.com/ludafa/runko。

  npm 包页面此前没有任何指向源码的链接（0.1.0 首发时漏了这个字段）。现在每个包都带上仓库地址与自己在
  monorepo 里的子目录（`directory`），npm 上的「Repository」入口会直接落到该包的源码目录，而不是仓库根。

- Updated dependencies [c29a6eb]
  - @runko/agent@0.1.1

## 0.1.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [51d94e6]
- Updated dependencies [3029ae3]
- Updated dependencies [3029ae3]
- Updated dependencies [3029ae3]
- Updated dependencies [48b461b]
- Updated dependencies [3029ae3]
- Updated dependencies [1282005]
- Updated dependencies [85e5099]
- Updated dependencies [fca6c03]
  - @runko/agent@0.1.0
