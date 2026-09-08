# @runko/core

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
