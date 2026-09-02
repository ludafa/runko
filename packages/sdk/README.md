# @runko/sdk

runko 的主包（门面）：batteries-included，re-export 全部三个子包（`@runko/core` / `@runko/virtual-fs` / `@runko/mini-bash`），5 行上手只装这一个。

> TODO：npm 裸名 `runko` 的发布决策待定——定了之后本 README 与所有示例的 `@runko/sdk` import 同步替换。

## 安装

```sh
pnpm add @runko/sdk ai        # ai@^7 是 peerDependency，跟随宿主版本
```

模型层即 Vercel AI SDK：`"provider/model"` Gateway 字符串开箱可用（零 provider 依赖）；要直连某家 provider 就再装对应包（如 `@ai-sdk/anthropic`）。

## 最小用例（产品文档 §4.1 的五行示例）

```ts
import { defineAgent, createSession, RunkoFS } from "@runko/sdk";
// 或直连 provider：import { anthropic } from "@ai-sdk/anthropic"; model: anthropic("claude-sonnet-5")

const agent = defineAgent({ model: "anthropic/claude-sonnet-5" });
const session = createSession(agent, { fs: RunkoFS.fromDirectory("./project") });
const result = await session.send("把 src/index.ts 里的 var 全部改成 const");
console.log(result.finalResponse, await session.fs.diff());
```

全程不写真实磁盘——写入落在 overlay 内存层，`session.fs.diff()` 拿变更，`session.fs.writeBack()` 才落盘（唯一写磁盘的操作，只有宿主可达）。

## 本包相对 @runko/core 的两处默认装配

其余 API 全部原样 re-export（清单见各子包 README）；本包自己只添两个符号：

### `createSession(agent, opts?)`（默认装配版）

与 core 的原始 `createSession` 同名同形状，差异只在默认值：

- **`fs` 缺省时自动注入空 `MemoryFS`**（core 版缺省是"调用即抛指导性错误"的占位 FS）；
- **文件工具八件套默认全开**（read_file / write_file / edit_file / delete_file / move_file / list_dir / glob / grep，`@runko/virtual-fs` 的 `createFileTools` 自动拼装，readState / file_change 事件通路全接好）；`agent.builtinTools` 数组白名单裁剪、`false` 全关；宿主 `tools` 同名覆盖内置。
- **`session.fs` 保留传入的具体类型**：`fs: RunkoFS.fromDirectory(...)` 时 `session.fs` 就是 `OverlayFS`，`session.fs.diff()` 无需断言直接编译（三重载泛型）。

需要无装配原语的宿主直接 `import { createSession } from "@runko/core"`，路径未被遮蔽切断。

### `RunkoFS`（类型 + 值命名空间）

- 类型：即 core 的 `RunkoFS` 接口（七方法：readFile / writeFile / rm / mkdir / readdir / stat / glob）。
- 值：`RunkoFS.fromMemory(files)` → `MemoryFS`；`RunkoFS.fromDirectory(dir, opts?)` → `OverlayFS`（真实目录零拷贝挂载）。

## 常用能力速查（均经本包可达）

| 要做什么 | 用什么 | 定义在 |
|---|---|---|
| 声明 agent / 工具 / skill | `defineAgent` / `defineTool` / `defineSkill` | [@runko/core](../core/README.md) |
| 跑会话、流式事件、审批、序列化恢复 | `createSession` → `send()` / `stream()` / `toJSON()` + `SessionOptions.resume` | @runko/core（本包加默认装配） |
| 结构化输出 | `session.send<T>(input, { outputSchema })` | @runko/core |
| 虚拟文件系统 | `RunkoFS.fromMemory` / `RunkoFS.fromDirectory`、`diff()` / `writeBack()` / `snapshot()` | [@runko/virtual-fs](../virtual-fs/README.md) |
| 纯内存命令执行（bash 工具，零依赖极简档：六命令） | `createSession(agent, { fs, exec: miniBash(fs) })` | [@runko/mini-bash](../mini-bash/README.md) |
| 全语法档命令执行（bash 工具：`if`/`for`/`while`/`case`/函数） | `createSession(agent, { fs, exec: justBash(fs) })`——**需单独 `pnpm add @runko/just-bash`**，不随本包装入 | [@runko/just-bash](../just-bash/README.md) |
| 本机命令执行 | `localExec()`（出厂审批 `"always"`；`{ materialize: true, fs }` 物化模式） | @runko/core |
| eve 布局目录加载 | `loadAgent(dir)` / `loadAgentFromFS(fs, dir)`（`@runko/core/load` 子路径同样可达） | @runko/core |

**bash 分档**：`@runko/mini-bash` 随本包 re-export，开箱可用，定位安全默认/测试演示；`@runko/just-bash`（vercel-labs/just-bash 适配器）因依赖树含 wasm 大件（sql.js、quickjs-emscripten 等）**不进本包依赖**，强制打包违背门面轻量默认——需要全语法档的宿主显式安装该包后按上表用法注入（见 [core-sdk · 技术方案 §4.5b](../../docs/logic/engine/tech/core-sdk.md)）。

可运行示例见 [examples/](../../examples/README.md)（含 [08-just-bash.ts](../../examples/src/08-just-bash.ts)）。
