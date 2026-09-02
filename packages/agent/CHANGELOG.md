# @runko/agent

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
