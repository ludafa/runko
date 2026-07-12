# @nimbo/sdk

nimbo 的主包（门面）：batteries-included，re-export 全部三个子包（`@nimbo/core` / `@nimbo/virtual-fs` / `@nimbo/mini-bash`），5 行上手只装这一个。

> TODO：npm 裸名 `nimbo` 的发布决策待定——定了之后本 README 与所有示例的 `@nimbo/sdk` import 同步替换。

## 安装

```sh
pnpm add @nimbo/sdk ai        # ai@^7 是 peerDependency，跟随宿主版本
```

模型层即 Vercel AI SDK：`"provider/model"` Gateway 字符串开箱可用（零 provider 依赖）；要直连某家 provider 就再装对应包（如 `@ai-sdk/anthropic`）。

## 最小用例（产品文档 §4.1 的五行示例）

```ts
import { defineAgent, createSession, NimboFS } from "@nimbo/sdk";
// 或直连 provider：import { anthropic } from "@ai-sdk/anthropic"; model: anthropic("claude-sonnet-5")

const agent = defineAgent({ model: "anthropic/claude-sonnet-5" });
const session = createSession(agent, { fs: NimboFS.fromDirectory("./project") });
const result = await session.send("把 src/index.ts 里的 var 全部改成 const");
console.log(result.finalResponse, await session.fs.diff());
```

全程不写真实磁盘——写入落在 overlay 内存层，`session.fs.diff()` 拿变更，`session.fs.writeBack()` 才落盘（唯一写磁盘的操作，只有宿主可达）。

## 本包相对 @nimbo/core 的两处默认装配

其余 API 全部原样 re-export（清单见各子包 README）；本包自己只添两个符号：

### `createSession(agent, opts?)`（默认装配版）

与 core 的原始 `createSession` 同名同形状，差异只在默认值：

- **`fs` 缺省时自动注入空 `MemoryFS`**（core 版缺省是"调用即抛指导性错误"的占位 FS）；
- **文件工具八件套默认全开**（read_file / write_file / edit_file / delete_file / move_file / list_dir / glob / grep，`@nimbo/virtual-fs` 的 `createFileTools` 自动拼装，readState / file_change 事件通路全接好）；`agent.builtinTools` 数组白名单裁剪、`false` 全关；宿主 `tools` 同名覆盖内置。
- **`session.fs` 保留传入的具体类型**：`fs: NimboFS.fromDirectory(...)` 时 `session.fs` 就是 `OverlayFS`，`session.fs.diff()` 无需断言直接编译（三重载泛型）。

需要无装配原语的宿主直接 `import { createSession } from "@nimbo/core"`，路径未被遮蔽切断。

### `NimboFS`（类型 + 值命名空间）

- 类型：即 core 的 `NimboFS` 接口（七方法：readFile / writeFile / rm / mkdir / readdir / stat / glob）。
- 值：`NimboFS.fromMemory(files)` → `MemoryFS`；`NimboFS.fromDirectory(dir, opts?)` → `OverlayFS`（真实目录零拷贝挂载）。

## 常用能力速查（均经本包可达）

| 要做什么 | 用什么 | 定义在 |
|---|---|---|
| 声明 agent / 工具 / skill | `defineAgent` / `defineTool` / `defineSkill` | [@nimbo/core](../core/README.md) |
| 跑会话、流式事件、审批、序列化恢复 | `createSession` → `send()` / `stream()` / `toJSON()` + `SessionOptions.resume` | @nimbo/core（本包加默认装配） |
| 结构化输出 | `session.send<T>(input, { outputSchema })` | @nimbo/core |
| 虚拟文件系统 | `NimboFS.fromMemory` / `NimboFS.fromDirectory`、`diff()` / `writeBack()` / `snapshot()` | [@nimbo/virtual-fs](../virtual-fs/README.md) |
| 纯内存命令执行（bash 工具，零依赖极简档：六命令） | `createSession(agent, { fs, exec: miniBash(fs) })` | [@nimbo/mini-bash](../mini-bash/README.md) |
| 全语法档命令执行（bash 工具：`if`/`for`/`while`/`case`/函数） | `createSession(agent, { fs, exec: justBash(fs) })`——**需单独 `pnpm add @nimbo/just-bash`**，不随本包装入 | [@nimbo/just-bash](../just-bash/README.md) |
| 本机命令执行 | `localExec()`（出厂审批 `"always"`；`{ materialize: true, fs }` 物化模式） | @nimbo/core |
| eve 布局目录加载 | `loadAgent(dir)` / `loadAgentFromFS(fs, dir)`（`@nimbo/core/load` 子路径同样可达） | @nimbo/core |

**bash 分档**：`@nimbo/mini-bash` 随本包 re-export，开箱可用，定位安全默认/测试演示；`@nimbo/just-bash`（vercel-labs/just-bash 适配器）因依赖树含 wasm 大件（sql.js、quickjs-emscripten 等）**不进本包依赖**，强制打包违背门面轻量默认——需要全语法档的宿主显式安装该包后按上表用法注入（见 [docs/02-tech-spec.md §4.5b](../../docs/02-tech-spec.md)）。

可运行示例见 [examples/](../../examples/README.md)（含 [08-just-bash.ts](../../examples/08-just-bash.ts)）。
