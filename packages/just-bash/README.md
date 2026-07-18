# @nimbo/just-bash

`NimboExec` 的全语法档实现：适配 [vercel-labs/just-bash](https://github.com/vercel-labs/just-bash)（Apache-2.0，纯 TS，专为 AI agent 场景设计），跑在任意 `NimboFS` 之上——"模式 A 同源工作区"的另一种实证，语法面从 `@nimbo/mini-bash` 的六个只读命令升级到完整 `if`/`elif`/`for`/`while`/`until`/`case`/函数/`local`/变量与参数扩展/glob/管道/`&&`/`||`/重定向。定位：Claude 系模型高频产出的控制流脚本，mini-bash 的六命令撑不住时换这个档（一行代码：`exec: justBash(fs)` 换掉 `exec: miniBash(fs)`）。

> **本包不随 `@nimbo/sdk` 一起装**（[docs/tech/core-sdk.md §4.5b](../../docs/tech/core-sdk.md) "包关系"）：`just-bash` 自身依赖树含 sql.js / quickjs-emscripten 等 wasm 大件，强制打包进门面违背 sdk 轻量默认。需要全语法档的宿主显式 `pnpm add @nimbo/just-bash`；`@nimbo/mini-bash` 仍是零依赖极简档，随 `@nimbo/sdk` 一起装，定位是安全默认与测试/演示载体。真实命令执行的第三个选项是 `@nimbo/core` 的 `localExec`，或宿主自己的沙盒实现（见 [docs/tech/core-sdk.md §4.5a](../../docs/tech/core-sdk.md)）。

## 安装

```sh
pnpm add @nimbo/just-bash
```

（`@nimbo/core`、`just-bash` 作为本包的 `dependencies` 一并装入，不需要单独 `pnpm add just-bash`。）

## 最小用例

```ts
import { justBash } from "@nimbo/just-bash";
import { fromMemory } from "@nimbo/virtual-fs";   // 任何 NimboFS 实现都行

const fs = fromMemory({});
const exec = justBash(fs);

const result = await exec.exec({
  command: 'for n in 1 2 3; do echo "line-$n"; done',
  cwd: "/",
  signal: new AbortController().signal,
});
console.log(result);   // { exitCode: 0, stdout: "line-1\nline-2\nline-3\n", stderr: "", durationMs: ... }
```

接进 session（同源工作区，`bash` 工具随 `exec` 注入自动出现；`fs`/`createSession`/`defineAgent` 仍从 `@nimbo/sdk` 拿，只有 `justBash` 本身来自本包）：

```ts
import { createSession, defineAgent, NimboFS } from "@nimbo/sdk";
import { justBash } from "@nimbo/just-bash";

const fs = NimboFS.fromMemory({});
const session = createSession(defineAgent({ model: "anthropic/claude-sonnet-5" }), {
  fs,
  exec: justBash(fs),   // 同一个 fs：write_file 写的文件，bash 立即可见，反之亦然
});
```

完整可跑示例见 [examples/08-just-bash.ts](../../examples/08-just-bash.ts)。

## API 面

本包公共 API 收紧到一个函数 + 它需要的选项/限额类型：

| 导出 | 说明 |
|---|---|
| `justBash(fs: NimboFS, opts?: JustBashOptions): NimboExec` | 返回跑在 `fs` 上的全语法档解释器。`defaultApproval: "never"`（重定向写面落在同一个注入的 `NimboFS`，与文件工具同沙盒）；`describe()` 声明全语法能力、无 symlink、无网络、输出非流式；`cwd` 在同一个 `justBash(fs)` 实例上跨 `exec()` 调用持久（同 `@nimbo/mini-bash` 语义） |
| `JustBashOptions` | `{ limits?: ExecutionLimits }`——与默认收紧值逐字段合并，未指定的字段沿用默认值 |
| `ExecutionLimits` | just-bash 的执行限额类型（`maxCommandCount`/`maxLoopIterations`/`maxOutputSize` 等，见下表） |

`createFsAdapter`/`IFileSystem` 等适配细节不导出（同 `@nimbo/mini-bash` 的 `parse()`/`COMMANDS` 先例）。

## 执行限额（默认值）

出厂默认（`just-bash` 自己的默认值是为通用 CLI 场景设的，对"一次 agent 工具调用里跑的一段脚本"明显过宽，这里整体收紧一个数量级左右；全部字段都能被 `opts.limits` 逐个覆盖）：

| 字段 | 默认值 | 字段 | 默认值 |
|---|---|---|---|
| `maxCommandCount` | 2000 | `maxLoopIterations` | 2000 |
| `maxOutputSize` | 1MB（`1024 * 1024`） | `maxCallDepth` | 20 |
| `maxAwkIterations` | 2000 | `maxSedIterations` | 2000 |
| `maxJqIterations` | 2000 | `maxSqliteTimeoutMs` | 3000 |
| `maxGlobOperations` | 5000 | `maxStringLength` | 2MB（`2 * 1024 * 1024`） |
| `maxArrayElements` | 10,000 | `maxHeredocSize` | 1MB（`1024 * 1024`） |
| `maxSubstitutionDepth` | 20 | `maxBraceExpansionResults` | 2000 |
| `maxFileDescriptors` | 256 | `maxSourceDepth` | 20 |

```ts
justBash(fs, { limits: { maxCommandCount: 500 } });   // 只覆盖这一个字段，其余仍是上表默认值
```

## 支持的语法

完整控制流：`if`/`elif`/`else`、`for`（list 形式与 C 式 `for ((i=0;i<n;i++))`）、`while`/`until`、`case`、函数（含 `local`）、变量/参数扩展、glob 展开、管道、`&&`/`||`、重定向（`>`/`>>`/`<`/`2>&1`）。命令集是 just-bash 内置的完整命令族（`cat`/`grep`/`sed`/`awk`/`find`/`sort`/`jq` 等数十个，详见 [just-bash 上游文档](https://github.com/vercel-labs/just-bash)），而非 mini-bash 那样的手写六命令子集。

## 已知限制（docs/tech/core-sdk.md §4.5b，如实照抄，不发明）

- **无 symlink**：`symlink`/`link`/`readlink` 始终抛不支持；`stat`/`lstat` 从不报告符号链接（与 v1 全线"无符号链接"立场一致）。
- **无网络**：curl/wget 不注册（未接入 fetch/network 配置）。
- **输出非流式**：just-bash 无增量回调，`onOutput` 每次 `exec()` 至多触发一次（脚本整体跑完后一次性回报 stdout/stderr），不是逐命令/逐行增量推送。
- **`**` 递归 glob 在同一次 `exec()` 内看不到该次脚本前面命令新写的文件**：`IFileSystem.getAllPaths()` 是同步签名而 `NimboFS.glob` 是异步的，适配器折中为"每次顶层 `exec()` 开始时刷新一次同步缓存"——脚本运行期间新写入的文件要下一次 `exec()` 调用才对 `**` 展开可见；单层 glob（如 `*.txt`）走 `readdir` 不受影响，同一脚本内实时可见。
- **`cp`/`mv` 递归目录时空子目录不参与**：目录场景经 `glob` 枚举子树文件逐个搬运，继承"`NimboFS.glob` 只报文件"的既有限制（§4.4），不额外物化空目录。
- `chmod`/`utimes` 是 no-op 成功（脚本常见惯用法，硬失败徒增纠错轮次），不是真实生效的权限/时间戳变更。
- `cwd` 的跨调用持久化由适配器自己维护（闭包变量 + 读回 `env.PWD`），不是 just-bash 引擎自带的免费特性——`Bash.exec()` 每次调用本身是无状态的。

## 退出码与取消契约（同 `@nimbo/mini-bash`，docs/tech/core-sdk.md §4.5a"实现契约"）

`exec()` 的全部失败路径以 resolve 的 `ExecResult`（非零 `exitCode` + stderr）返回，从不 reject：超时 124、abort 130；just-bash 自身抛出的非正常异常兜底为 `exitCode: 1`。中止/超时不采信 just-bash 自己返回的退出码（实测不稳定）——适配器用独立的 `raceAbort` 竞速，信号一响就立即以合成结果返回，不等底层调用真正落定。
