# @nimbo/sandbox-vercel

把一个已创建好的 [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox)（真实 Amazon Linux 2023 Firecracker microVM）实例包成 `NimboFS & NimboExec`，一次注入 `createSession(agent, { workspace })`——"模式 A 同源工作区"落在真实云沙盒上的实现（对照 [docs/tech/core-sdk.md §4.5a](../../docs/tech/core-sdk.md) / [docs/tech/sandbox.md §8](../../docs/tech/sandbox.md)）。

## 安装

```sh
pnpm add @nimbo/sandbox-vercel @vercel/sandbox
```

`@vercel/sandbox` 需要单独装——本包运行时**不 import** `@vercel/sandbox`（见下方"结构化接口"，甚至连 `import type` 都不出现），但宿主要创建真实沙盒实例（`Sandbox.create()`）离不开它。本包不随 `@nimbo/sdk` 一起装，属于按需显式安装的可选集成。

## 快速上手

```ts
import { Sandbox } from "@vercel/sandbox";
import { vercelWorkspace } from "@nimbo/sandbox-vercel";
import { createSession, defineAgent } from "@nimbo/sdk";

const sandbox = await Sandbox.create({          // BYO：本包不创建/销毁沙盒
  token: process.env.VERCEL_TOKEN,
  teamId: process.env.VERCEL_TEAM_ID,
  projectId: process.env.VERCEL_PROJECT_ID,
  runtime: "node24",
});
try {
  const workspace = vercelWorkspace(sandbox);   // 默认 root: "/vercel/sandbox"
  const session = createSession(defineAgent({ model: "anthropic/claude-sonnet-5" }), { workspace });
  const result = await session.send("在 notes.txt 里写一句问候语，然后用 bash 验证内容。");
  console.log(result.finalResponse);
} finally {
  await sandbox.stop();
}
```

完整可跑示例（含零凭证的 fake 沙盒演示，证明"BYO 实例 + 结构化接口"不需要真实网络）见 [examples/10-sandbox-vercel.ts](../../examples/10-sandbox-vercel.ts)。

## 结构化接口 / BYO

```ts
function vercelWorkspace(sandbox: VercelSandboxLike, opts?: { root?: string }): NimboFS & NimboExec;
```

- `VercelSandboxLike` 是以 `@vercel/sandbox` 官方 d.ts 为蓝本手写的结构化最小子集（`fs.{readFile,writeFile,mkdir,readdir,stat,rm,rmdir}` + `runCommand`）——本包运行时零 `import "@vercel/sandbox"`，`vercelWorkspace()` 收的是这份结构接口而非具体类，真实 `Sandbox` 实例无需任何转换即可直接传入（`test/type-conformance.test-d.ts` 的编译期证明），任何实现了同一结构的对象（例如测试/演示用的进程内 fake）同样可以传入。
- **BYO 实例**是唯一入口：`vercelWorkspace()` 不创建、不销毁沙盒——创建（`Sandbox.create()`）、超时延长、`stop()` 完全由宿主自己管理。
- `opts.root`（默认 `/vercel/sandbox`，Vercel Sandbox 的默认工作目录）：虚拟绝对路径 `/` 锚定到的沙盒内真实目录；FS 七方法仍拒绝 `..` 越出这个 root（与 `MemoryFS`/`DirFS` 同一套边界语义），但 `bash` 本身不受此限制（见下）。

## 保活（keepalive）

**沙盒的租期是倒计时，在里面跑命令不会把它往后推。** 所以一轮 agent 只要跑得比租期长，就会在跑到一半时被平台停掉。传 `keepAlive` 即可让适配器自动续期：

```ts
const sandbox = await Sandbox.create({ timeout: 300_000, persistent: true });
const workspace = vercelWorkspace(sandbox, {
  keepAlive: { idleTimeoutMs: 300_000 },   // 与建盒 timeout 保持一致
});
```

- **不传 `keepAlive` = 完全不保活**，一次网络调用都不会发生。保活会花钱，不该在你没要求时悄悄发生。
- 续期是**补足**语义：先读 `sandbox.expiresAt` 拿真实剩余，只补差额。这一点对 Vercel 尤其要紧——`extendTimeout(duration)` 是**加时**（官方文档原话 "Extends timeout **by** 5 minutes, to a total of 15 minutes"），直接传目标值会让租期反复累加，高频对话后沙盒多活几十分钟白计费。
- 这一轮真的卡死时信号自然停止，沙盒会正常停机——它不会给一个已经死掉的任务无限续命。
- 其余可调项（`maxTurnMs` 单轮上限、`approvalBudgetMs` 审批预算、`onRenew` 观测回调）见 `@nimbo/core` 的 `KeepAliveOptions` 与 [docs/features/sandbox-keepalive.md](../../docs/features/sandbox-keepalive.md)。

⚠️ 查剩余用的是 **`sandbox.expiresAt`**（"When the currently running session will time out"），**不是 `sandbox.timeout`**——后者是建盒时配的默认时长，不是剩余量。

## 已知限制（docs/tech/sandbox.md §8.2 / docs/plans/core-sdk.md P10-2 实际改动，如实照抄不发明）

- **非递归删除目录走 `fs.rmdir()` 而非 `fs.rm()`**：实测推翻了调研文档"`fs.rm(path, {recursive})` 原生对齐"的假设——`@vercel/sandbox` 的 `fs.rm(path)`（非递归）对**任何**目录都抛 `ERR_FS_EISDIR`，不区分空/非空；真正带"空则成功、非空则 `ENOTEMPTY`"语义的是 `fs.rmdir()`。适配器按目标类型分流：文件走 `fs.rm()`，非递归删目录走 `fs.rmdir()`，`{recursive: true}` 统一走 `fs.rm(path, {recursive:true, force:true})`——代价是非递归删目录多一次 `stat` 判断类型。
- **bash 越出工作区根**：文件工具锚定在 `root` 之下并拒绝 `..` 越界，但 `bash -lc "<script>"` 是沙盒里的真实 shell（默认用户有免密 sudo），能读写/`cd` 到磁盘任何位置——绝对路径的 bash 命令（如 `cat /notes.txt`）落在沙盒真实文件系统根，而不是 `root`；同一份文件要在文件工具和 bash 之间互通，bash 侧要用相对路径。
- **`readdir` 不逐条 `stat`**：目录列表的 `size`/`mtime` 留空（`FileStat` 里两者本就是可选字段）——审计过消费方后确认没有工具依赖这两个字段，逐条 stat 在远程沙盒上是 N 次额外网络往返，需要精确值时单独调用 `stat(path)`。
- **每次 NimboFS 文件工具调用都是一次网络往返**——扫描类操作（大量 glob、grep-like 搜索）优先用一条 bash 命令，而不是逐个 `glob`/`read_file` 调用。
- **沙盒已停止/会话过期**：v1 = 报错指导（`exec()`/文件方法翻译成带操作建议的失败结果，Vercel Sandbox 会在配置的超时后自动终止），不做自动恢复——宿主需要创建新的 `Sandbox`（或 `Sandbox.get({ name, resume: true })`/`extendTimeout()`）并重新调用 `vercelWorkspace()`。
- 超时契约（124/130）由适配器自己的 `AbortController` 竞速权威判定，不采信 SDK 自报的退出码/计时；`@vercel/sandbox@2.5.0` 实测已带原生 `timeoutMs`（早于调研文档记录的版本），仅作为竞速提前放弃等待后、沙盒侧仍会真正杀掉残留进程的兜底。
