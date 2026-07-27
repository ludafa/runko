# @nimbo/sandbox-e2b

把一个已创建好的 [E2B](https://e2b.dev)（真实 Firecracker microVM）沙盒包成 `NimboFS & NimboExec`，一次注入 `createSession(agent, { workspace })`——"模式 A 同源工作区"落在真实云沙盒上的实现（对照 [docs/tech/core-sdk.md §4.5a](../../docs/tech/core-sdk.md) / [docs/tech/sandbox.md §8](../../docs/tech/sandbox.md)）。

## 安装

```sh
pnpm add @nimbo/sandbox-e2b e2b
```

`e2b` 需要单独装——本包运行时**不 import** `e2b`（见下方"结构化接口"），但宿主要创建真实沙盒实例（`Sandbox.create()`）离不开它。本包不随 `@nimbo/sdk` 一起装，属于按需显式安装的可选集成。

## 快速上手

```ts
import { Sandbox } from "e2b";
import { e2bWorkspace } from "@nimbo/sandbox-e2b";
import { createSession, defineAgent } from "@nimbo/sdk";

const sandbox = await Sandbox.create();          // BYO：本包不创建/销毁沙盒
try {
  const workspace = e2bWorkspace(sandbox);        // 默认 root: "/home/user"
  const session = createSession(defineAgent({ model: "anthropic/claude-sonnet-5" }), { workspace });
  const result = await session.send("在 notes.txt 里写一句问候语，然后用 bash 验证内容。");
  console.log(result.finalResponse);
} finally {
  await sandbox.kill();
}
```

完整可跑示例（含零凭证的 fake 沙盒演示，证明"BYO 实例 + 结构化接口"不需要真实网络）见 [examples/09-sandbox-e2b.ts](../../examples/09-sandbox-e2b.ts)。

## 结构化接口 / BYO

```ts
function e2bWorkspace(
  sandbox: E2bSandboxLike,
  opts?: { root?: string; keepAlive?: KeepAliveOptions },
): E2bWorkspace;
```

- `E2bSandboxLike` 是以 e2b 官方 d.ts 为蓝本手写的结构化最小子集（`files.read/write/list/remove/makeDir/getInfo` + `commands.run`）——本包运行时零 `import "e2b"`，`e2bWorkspace()` 收的是这份结构接口而非具体类，真实 e2b `Sandbox` 实例无需任何转换即可直接传入（`test/type-conformance.ts` 的编译期证明），任何实现了同一结构的对象（例如测试/演示用的进程内 fake）同样可以传入。
- **BYO 实例**是唯一入口：`e2bWorkspace()` 不创建、不销毁沙盒——创建（`Sandbox.create()`）、暂停/恢复、`kill()` 完全由宿主自己管理。唯一的例外是[保活](../../docs/terms.md)，见下。
- `opts.root`（默认 `/home/user`，e2b 官方模板的登录用户主目录）：虚拟绝对路径 `/` 锚定到的沙盒内真实目录。

## 保活（keepalive）

**沙盒的存活时长是倒计时，在里面跑命令不会把它往后推。** 所以一轮 agent 只要跑得比沙盒超时长，就会在跑到一半时被平台暂停掉。传 `keepAlive` 即可让适配器自动续期：

```ts
const sandbox = await Sandbox.create({ timeoutMs: 300_000 });
const workspace = e2bWorkspace(sandbox, {
  keepAlive: { idleTimeoutMs: 300_000 },   // 与建盒 timeoutMs 保持一致
});
```

- **不传 `keepAlive` = 完全不保活**，一次网络调用都不会发生，行为与没有这个功能时一致。保活会花钱，不该在你没要求时悄悄发生。
- 续期是**补足**语义（补到至少 `idleTimeoutMs`，够了就什么都不做），不是无脑加时。
- 这一轮真的卡死时信号自然停止，沙盒会正常休眠——它不会给一个已经死掉的任务无限续命。
- 其余可调项（`maxTurnMs` 单轮上限、`approvalBudgetMs` 审批预算、`onRenew` 观测回调）见 `@nimbo/core` 的 `KeepAliveOptions` 与 [docs/features/sandbox-keepalive.md](../../docs/features/sandbox-keepalive.md)。

⚠️ 两个要注意的：

- **`idleTimeoutMs` 要和建盒时的 `timeoutMs` 一致。** 不一致很难查——比如建盒 5 分钟、这里按 10 分钟补足，就永远补不上去。
- **E2B 有硬上限**：Pro 账户 24 小时、Hobby 账户 1 小时（`Sandbox.setTimeout` 的官方文档）。超了会报错。保活不是长生药。

## 已知限制（docs/tech/sandbox.md §8.2 / docs/plans/core-sdk.md P10-1 实际改动，如实照抄不发明）

- **取消 = 放弃等待，不是真的杀掉远程进程**：`exec()` 的 abort/超时只保证及时返回（退出码 124/130），命令本身可能在沙盒里继续跑到自然结束——真正杀掉远程进程需要 e2b 的 `background: true` + `CommandHandle.kill()`，是另一条调用路径，不在本适配器 v1 范围内。
- **bash 越出工作区根**：文件工具（`read_file`/`write_file`/...）锚定在 `root` 之下，但 `bash` 是沙盒里的真实 shell，能读写/`cd` 到磁盘任何位置——绝对路径的 bash 命令（如 `cat /notes.txt`）落在沙盒真实文件系统根，而不是 `root`；同一份文件要在文件工具和 bash 之间互通，bash 侧要用相对路径（沙盒默认 cwd 与 `root` 一致时，`cat notes.txt` 即可命中文件工具写的同一个文件）。
- **每次 NimboFS 文件工具调用都是一次网络往返**（几十到几百毫秒）——扫描类操作（大量 glob、grep-like 搜索）优先用一条 bash 命令，而不是逐个 `glob`/`read_file` 调用。
- **非递归删除非空目录**：e2b 的 `remove()` 本身恒递归，适配器自己先 `list` 一层子项判断目录是否为空再决定要不要拒绝（`DirectoryNotEmptyError`），比原生多一次调用。
- **沙盒已停止/过期**：v1 = 报错指导（`exec()`/文件方法翻译成带操作建议的失败结果），不做自动恢复——宿主需要自己延长沙盒超时或重新创建实例并重新调用 `e2bWorkspace()`。
