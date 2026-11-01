# @runko/core

## 0.2.0

### Minor Changes

- e00ae29: **交权信号：节点要下线时，一轮可以停在干净的位置交给别的节点接着跑，而不是被中断。**

  - `TurnOptions.handover`（与 `signal` 分开的第二个信号）：模型正在输出 → 掐断、这半步整个扔掉；工具正在跑 → **工具不停**，这一轮带着悬空调用以新的收尾状态 `handed-over` 结束，还在跑的调用经 `TurnResult.handedOver.running` 交给调用方继续持有（每个带一个从不 reject 的 `outcome` promise）。
  - `Session.continueTurn()`：不追加任何消息，从账本当前的样子接着跑——接手的一方在模型输出段交权之后用它。
  - `Settlement` 新增 `{ kind: "error", errorText }`：结清一次「执行过但失败了」的调用（写成 `output-error`）。
  - `SessionOptions.toolTimeoutMs`：单次工具执行的上限。到点先 abort 工具，再等两秒，还不回来就给模型一个「超过最长执行时间，已终止」的结果。
  - `RunkoMessageMetadata.status` 多了 `"handed-over"`，并带 `handedOver: { callIds }`。
  - `Tool.waitsForPerson`：在 `execute` 里等人的工具（如 `ask-user`）不受工具最长执行时间约束，交权时也不被交出去（由宿主让它挂起）。
  - `settleAndRun` 的选项 `alsoSettle`：同一轮里一起结清另外几次「执行过了」的调用——交权时并行在跑的几个工具要全部有结果后一起结清。
  - 工具超时之后在宽限期里真跑完了的，保留它的真实结果，不改写成「已终止」。

- 4a936b9: **一轮显示「完成」时一定已经存好了；排队的下一轮紧接着跑，不再断流。**

  - `@runko/core`：`RunkoError.code` 新增 `internal_error`（系统异常）。core 自己不产出，留给编排层报 core 之外的故障；它的 `message` 是一句不含细节的通用话。对 `code` 做穷举（比如 `Record<RunkoError["code"], …>`）的代码要补上这一项。
  - `@runko/agent`：一轮的收尾帧（`message-metadata`）现在排在这一轮的成品消息帧**之后**——订阅者收到「完成了」时，回复已经写进账本。成品消息没能全部写进账本（库出错、写入被拒、归属丢了）时，不再发「完成了」，改发 `status: "failed"` + `internal_error`，并尽量补一条失败标记；具体原因只进日志。
  - `@runko/agent`：一轮收尾时[待发队列](https://github.com/ludafa/runko/blob/main/docs/terms.md)里还有消息，持有者**不放手归属**，直接出队起下一轮；两轮之间不再广播 `activity:false`，`subscribe()` 的同一条订阅一路收到整个队列跑完。队列排空、最后一轮跑完才广播 `activity:false` 并放手。

- a933c31: 一次工具调用现在可以说「我要挂起这一轮」，账本里那次调用原封不动地留着等人。

  这是挂起与恢复（路线图 K3）在 core 这一侧的出口；「什么时候挂起」由宿主决定（`@runko/agent` 的内存窗口），「人回来怎么恢复」见同批的 `settleAndRun`。

  **两个入口**：

  - 人审通道（`ApprovalReviewer`）多了第三种结局 `{ behavior: "suspend", reason? }`。收到它时 loop **什么都不写**——工具部件停在 `approval-requested`（带着完整入参），不发审批响应 chunk，不执行工具，不动 once 记忆，本轮就此收尾。
  - 工具执行上下文多了 `ctx.suspend(reason?)`。工具（典型是 `ask-user`）调它声明「这次调用停在一个干净边界上等外部输入」，部件停在 `input-available`。它抛出一个**不继承 `Error`** 的 `SuspendSignal`；同时在这次调用的上下文里打一个标记，**判据是标记而不是异常**——所以工具内部一句 `try { … } catch { return "先跳过" }` 吃掉信号也不影响：本轮照样挂起，那个垫场返回值连 `outputSchema` 都不过，一个字都不进账本。

  **收尾**：`RunkoMessageMetadata.status` 的第四个值 `"suspended"` 终于有产出方了（此前只有类型定义）。同时带上 `suspended: { callIds, reason? }`——哪几次调用还悬着、为什么挂起。`reason` 是宿主自己的词（`"timeout"` / `"handover"` 这类），core 只透传不解释。

  **一步里多个调用**：只要有任何一个要求挂起，本轮就挂起。

  - **全只读的并行批**：其余调用照常结算完，同时在等人的一并留着。`callIds` 按模型发出调用的顺序，不随完成顺序飘。
  - **串行批**（混有写操作）：它保的是「按模型书写的顺序执行」，所以一个调用挂起之后，**后面的一个都不执行**，各得一个「没有执行」的错误结果（模型恢复之后看得到、需要的话再发一次）。否则人几小时后批准时，被批准的那个反而最后才执行。
  - 挂起之前已经执行完的结果、产生的文件变更照常落账——已发生的事实不回滚。

  **挂起不注入插话**：收尾路径不 drain steer 队列（悬空调用后面接用户消息会 400）。还没注入的插话随这一轮收尾丢弃，由宿主转走（`@runko/agent` 转进待发队列）。

  **一步半路失败时，没轮到执行的调用不再留成悬空**：模型已经吐出 tool-call、流随后断掉（停止或模型服务出错），那次调用得到一个「没有执行」的错误结果。以前它会留成一个没有结果的调用，下一轮交给模型就 400。

  **⚠️ 不兼容（只影响底层用法）**：

  - `ToolCallResult` 从单一 interface 改成按 `status` 判别的联合，`"suspended"` 那一支没有 `output`。直接调用 `executeToolCall`、不收窄就读 `result.output` 的代码编译不过。
  - `ToolContext` 多了**必需**成员 `suspend`。自己构造 `ToolContext` 的代码（典型是测试替身）要补一个。
  - 用 `runTurn` / `Session` 的一律不受影响。

- a933c31: 新入口 `session.settleAndRun(callId, settlement)`：把挂起留下的那次悬空调用结清，然后接着跑。人几小时后回来点「允许」，走的就是它。

  这是挂起与恢复（路线图 K3）在 core 这一侧的恢复入口；「人回来时怎么找到那个会话、在哪个副本上恢复」见同批 `@runko/agent` 的那条。

  **三种结清方式**，要跟那条悬空部件的状态对得上：

  | 部件停在                                       | 给什么                                             | 发生什么                                                                                                                                                  |
  | ---------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `approval-requested`（人审通道答了 `suspend`） | `{ kind: "approval", behavior: "allow" }`          | **用账本里原封不动的入参执行**。不再走审批链（人已经批准了），但会重新过一遍 `inputSchema`——工具换了版本、不再接受旧参数时记一次 `output-error`，不硬执行 |
  | 同上                                           | `{ kind: "approval", behavior: "deny", message? }` | 不执行，理由回填给模型                                                                                                                                    |
  | `input-available`（工具调了 `ctx.suspend()`）  | `{ kind: "output", output }`                       | 给的值就是这次调用的输出，不重新执行工具。声明了 `outputSchema` 的会校验                                                                                  |
  | `approval-responded`（审批通过后执行时又挂起） | `{ kind: "output", output }`                       | 同上，并保留审批痕迹                                                                                                                                      |

  **恢复轮的第一步不调模型**：先执行（或拒绝、或填输出），模型看到结果才上场。所以恢复轮里的模型想换个参数也无从换起——执行的就是人批准的那一条。

  **结清之后同一条消息里还有悬空调用**（一步里多个调用同时挂起，或者刚结清的那个执行时又挂起了）：不调模型，直接以 `suspended` 收尾，`suspended.callIds` 是剩下的那些。

  **它原地改写那条消息**（id 不变）——那条恒为开轮时的最后一条。所以宿主落盘时要从它开始切：它以新 seq、同 id 追加，读账本时按 `message.id` 折叠（位置取首次、内容取最新）。

  **`stream()` 多了一道守卫**：最后一条消息里有悬空调用时，`stream()` 直接抛 `RunkoResumeError`（`code: "pending_calls"`），不再把请求发给模型。实测过：悬空调用只产出 `tool-call`、没有 `tool-result`，后面再接一条 user 消息，Anthropic 与 OpenAI 兼容两家都会 400——与其让它回一个看不懂的错，不如在本地说清楚。

  **`send()` 认得出挂起**：`TurnResult` 多了可选的 `suspended: { callIds, reason? }`，这一轮挂起时才有。带 `outputSchema` 时遇到挂起直接抛 `RunkoResumeError`（`pending_calls`）——挂起的一轮没有最终答复可结构化，拿悬空的历史去调模型只会 400。

  **恢复轮在调模型之前就收尾**（结清之后被停止、或者又挂起）时，收尾 metadata 并在上一轮那条消息上（悬空调用只能在最后一条），上一轮留下的 `suspended` 会被去掉或覆盖，不会出现「状态是已停止、却还带着 suspended」这种自相矛盾。

  **⚠️ `Session` 多了必需方法 `settleAndRun`**：自己实现 `Session` 接口的代码要补上（用 `createSession` 的不受影响）。

  **用错了就抛 `RunkoResumeError`，不算一轮**（轮号不动、不出 chunk）：`pending_calls` / `call_not_found` / `not_pending`（已经有结果了，比如重复恢复）/ `settlement_mismatch`（种类对不上）。

  **新导出**：`Settlement`、`RunkoResumeError`、`pendingCallIds(messages)`（宿主拿它判断「这个会话现在能不能开普通轮」）、`resolveResumeTarget`。

  **轮统计不骗人**：`toolDurationMs` 现在只数本轮开始之后才开始执行的区间。普通轮不受影响；恢复轮只算恢复时执行的那一段，等人的时间哪一轮都不算。

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

## 0.1.1

### Patch Changes

- c29a6eb: 补上 `repository` 字段，指向 https://github.com/ludafa/runko。

  npm 包页面此前没有任何指向源码的链接（0.1.0 首发时漏了这个字段）。现在每个包都带上仓库地址与自己在
  monorepo 里的子目录（`directory`），npm 上的「Repository」入口会直接落到该包的源码目录，而不是仓库根。

## 0.1.0

### Minor Changes

- b342e5b: `maxTurnsPerRun` 的默认值从 40 提到 100。没有显式设置这个字段的 agent，一次 `send()`/`stream()` 里最多能跑 100 个模型步（原来 40 步就会以 `max_turns` 收场）。显式设置过的调用方不受影响。

  ⚠️ **这会影响单轮的费用上限**：没设过这个字段的 agent，一次调用现在最多能烧 100 个模型步而不是 40 步。原来靠默认值兜住成本的，需要显式把它设回去（`defineAgent({ maxTurnsPerRun: 40 })`）。

- 3ffdf28: 沙盒保活：一轮跑多久，云沙盒就活多久

  云沙盒的存活时长是倒计时，**在里面跑命令不会把它往后推**。所以一轮 agent 只要跑得比沙盒超时长，就会在跑到一半时被平台暂停/停机。以前这件事得每个宿主自己去发现、自己写心跳。

  现在给云沙盒适配器传一个 `keepAlive` 就行：

  ```ts
  const sandbox = await Sandbox.create({ timeoutMs: 300_000 });
  const workspace = e2bWorkspace(sandbox, {
    keepAlive: { idleTimeoutMs: 300_000 },
  });
  // 这一轮跑一小时也不会被抽走
  await createSession(agent, { workspace }).send(
    "装依赖，跑测试，修好失败的用例",
  );
  ```

  **新增**

  - `@runko/core`：`RunkoActivityAware`（工作区的可选能力，接收「这一轮还在干活」的信号）、`RunkoKeepAliveCapable`（手动补足一次）、以及给适配器用的 `createKeepAlive` 保活引擎。会话在产出 chunk 时通知工作区，节流后推送；工作区没实现就完全不发生任何事——内存/本机工作区零影响。
  - `@runko/sandbox-e2b` / `@runko/sandbox-vercel`：`keepAlive` 选项。**不传就完全不保活**，行为与之前一致。

  **行为要点**

  - 续期是**补足**语义（补到至少目标值，够了就什么都不做），不是无脑加时。Vercel 的 `extendTimeout` 本身是累加的，这一点尤其要紧——反复调用不会再让租期无限叠加。
  - 长命令执行期间也覆盖：适配器在自己的 `exec()` 进行期间自打点，不依赖会话产出 chunk。
  - 卡死会自动放手：一轮真的不动了，信号自然停止，沙盒按自己的节奏休眠，不会给死掉的任务无限续命。
  - 可调：`maxTurnMs`（单轮上限，默认 30 分钟）、`approvalBudgetMs`（卡在人工审批时最多续多久，默认 5 分钟，配 0 表示完全不续）、`onRenew`（每次真实续期的观测回调）。

  Cloudflare 适配器不实现这套——它的 `sleepAfter` 是真正的空闲检测，有活动会自己续，本来就不需要外部保活。

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

- 847222d: `TurnOptions.signal` 的停止时机变确定：loop 现在在**每个 step 边界**显式检查 abort 信号，看到已中止就直接以 `status: 'interrupted'`（`RunkoError.code: 'aborted'`）收尾，绝不开始新的一步。

  此前只有「模型调用本身被信号掐断」这一条路径能停——工具执行被中止时工具是正常收尾的（「失败即 ExecResult」，不抛错），于是 loop 会照常进入下一步、白打一次模型调用，直到那次调用因信号已中止而抛错才停下。现在那次多余的模型调用不再发生。

- be08aac: 中止一轮时，宿主自己给的理由现在会出现在收尾信息里：`abortController.abort(new Error("..."))` 的那句话会成为 `message-metadata` 上 `error.message` 的内容（`code` 仍是 `aborted`）。

  这让宿主能区分不同的中止原因——比如「用户按了停止键」和「服务进程要关闭了」——并在界面上分别解释，而不必让 SDK 认识这些宿主侧的概念。

  `abort()` 不带参数时行为不变，仍是原来的默认文案（运行时自造的 `AbortError` 不算宿主的解释）。

- fca6c03: `createSession({ resume })` 现在接受**空账本**（`messages: []`）。

  此前会被 ai 的 `validateUIMessages()` 拒成 "Messages array must not be empty"，可 `sessionStateSchema` 本来就允许空数组——「resume 一个还没产出任何消息的会话」是完全合法的。宿主想让会话 id 从第一轮起就稳定（拿业务侧的会话 id 当 `session.id`，好让遥测的关联键跨轮不断）时，传的正是这种空 state。
