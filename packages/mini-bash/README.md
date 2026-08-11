# @nimbo/mini-bash

`NimboExec` 的纯 TypeScript 解释器实现：不 fork 子进程、不碰真实磁盘与网络，六个只读命令直接跑在任意 `NimboFS` 上——"模式 A 同源工作区"（bash 与文件工具共享同一份虚拟文件系统，一致性是结构性的，无需同步）的纯内存实证。

> 一般用户装 [`@nimbo/sdk`](../sdk/README.md) 即可（re-export 本包）。定位是安全默认与测试/演示载体；要真实命令执行用 `@nimbo/core` 的 `localExec`，或注入宿主自己的沙盒实现（见 [docs/core/core-sdk/tech.md §4.5a](../../docs/core/core-sdk/tech.md)）。
>
> **分档说明**：本包是**零依赖极简档**——六个只读命令 + 四个控制操作符，随 `@nimbo/sdk` 一起装，无需额外安装。Claude 系模型高频产出的 `if`/`for`/`while`/`case` 控制流脚本超出这个语法面时，换 **`@nimbo/just-bash`**（[README](../just-bash/README.md)）——全语法档，基于 vercel-labs/just-bash，因依赖树含 wasm 大件而不随 `@nimbo/sdk` 一起装，需显式 `pnpm add @nimbo/just-bash`。两者都是 `NimboExec` 接口的实现，一行代码互换（`exec: miniBash(fs)` ↔ `exec: justBash(fs)`），loop/session 代码零改动（见 [docs/core/core-sdk/tech.md §4.5b](../../docs/core/core-sdk/tech.md)）。

## 安装

```sh
pnpm add @nimbo/mini-bash
```

## 最小用例

```ts
import { miniBash } from "@nimbo/mini-bash";
import { fromMemory } from "@nimbo/virtual-fs";   // 任何 NimboFS 实现都行

const fs = fromMemory({ "notes/todo.txt": "buy milk\nwrite docs\nship it\n" });
const exec = miniBash(fs);

const result = await exec.exec({
  command: "grep -n docs /notes/todo.txt | head -n 1",
  signal: new AbortController().signal,
});
console.log(result);   // { exitCode: 0, stdout: "2:write docs\n", stderr: "", durationMs: ... }
```

接进 session（同源工作区，`bash` 工具随 `exec` 注入自动出现）：

```ts
import { createSession, defineAgent, miniBash, NimboFS } from "@nimbo/sdk";

const fs = NimboFS.fromMemory({});
const session = createSession(defineAgent({ model: "anthropic/claude-sonnet-5" }), {
  fs,
  exec: miniBash(fs),   // 同一个 fs：write_file 写的文件，cat 立即可见
});
```

## API 面

本包公共 API 只有一个函数：

| 导出 | 说明 |
|---|---|
| `miniBash(fs: NimboFS): NimboExec` | 返回跑在 `fs` 上的解释器。`defaultApproval: "never"`（全只读、零副作用，无需审批）；`describe()` 返回命令清单与语义说明（自动拼进 `bash` 工具描述） |

## 命令语言

### 支持的命令（POSIX 常用子集）

| 命令 | 旗标 | 说明 |
|---|---|---|
| `cat [file...]` | — | 多文件按参数顺序拼接；无参数消费 stdin |
| `grep [-i] [-n] [-c] [-l] [-E] PATTERN [file...]` | `-i` 忽略大小写、`-n` 行号、`-c` 计数、`-l` 只列文件 | JavaScript RegExp 语法（非 POSIX/PCRE；`-E` 为兼容旗标不改变行为）；无匹配 exit 1、文件缺失 exit 2 |
| `find [path] [-name GLOB] [-type f\|d]` | — | 从 path（默认 `.`）递归；`-name` 只匹配单段 basename |
| `tail [-n N] [file...]` / `head [-n N] [file...]` | 默认 N=10 | 无参数消费 stdin |
| `echo [-n] [text...]` | `-n` 抑制结尾换行 | 唯一"生成"命令，无副作用 |

### 控制操作符（优先级对齐 POSIX）

| 操作符 | 语义 |
|---|---|
| `\|` | 单层管道，最紧：左侧 stdout → 右侧 stdin；退出码取最后一个命令 |
| `&&` / `\|\|` | 同级、左结合短路：前一管道 exit 0 才跑 / 非 0 才跑（被跳过的管道不改变链状态，`a && b \|\| c` 对齐真实 shell） |
| `;` | 最松：切成多条独立链，链间总是全部依次执行 |
| `2>&1` | 该命令的 stderr 并入 stdout（命令末尾参数位；管道下游能读到） |

### 明确不支持（解析阶段报错，不静默降级）

- **文件重定向 `>` / `>>` / `2>file`**——刻意拒绝：写面必须走 `write_file` 工具（有 `file_change` 事件与 readState 登记，重定向写是旁路）；被拒文案直接指引 `write_file`。
- **`<`**——`cat <file>` 已覆盖，被拒文案指引 cat。
- 变量展开（`$var` / `${var}`）、子 shell / 命令替换（`$(...)` / `` `...` ``）、后台执行（`&`）。
- 通配符**不展开**（`*` / `?` 按字面字符传给命令，不报错）。

### 退出码契约（docs/core/core-sdk/tech.md §4.5a"实现契约"）

全部失败路径以 resolve 的 `ExecResult` 返回（非零 `exitCode` + stderr），从不 reject：解析错误 2、未知命令 127、超时 124、abort 130；grep 三态（匹配 0 / 无匹配 1 / 文件缺失 2）。路径 `..` 越界静默 clamp 到根（解释器语义；安全边界在 FS 层）。
