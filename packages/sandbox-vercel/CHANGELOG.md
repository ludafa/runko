# @runko/sandbox-vercel

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

### Patch Changes

- Updated dependencies [847222d]
- Updated dependencies [be08aac]
- Updated dependencies [fca6c03]
- Updated dependencies [b342e5b]
- Updated dependencies [3ffdf28]
- Updated dependencies [fca6c03]
- Updated dependencies
  - @runko/core@0.1.0
  - @runko/virtual-fs@0.1.0
