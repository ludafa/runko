# @nimbo/core

nimbo 的核心包：L0 可注入接口（`NimboFS` / `NimboExec` / `Tool` / `ApprovalPolicy`）、L1 定义层（`defineAgent` / `defineTool` / `defineSkill`）、L2 运行层（`createSession` / loop / 事件 / 审批链）、AI SDK step runner、skills、L3 目录约定层，以及 `load_skill` / `update_plan` / `bash` 三个内置工具本体。

> 一般用户装 [`@nimbo/sdk`](../sdk/README.md)（batteries-included 门面）即可；直接用本包适合"要无默认装配的原语"的宿主——本包刻意不依赖 `@nimbo/virtual-fs`（避免循环），`fs` 缺省时是抛指导性错误的占位实现，文件工具八件套也不自动拼装。

## 安装

```sh
pnpm add @nimbo/core ai        # ai@^7 是 peerDependency
```

## 最小用例

```ts
import { defineAgent, defineTool, createSession } from "@nimbo/core";
import { z } from "zod";

const agent = defineAgent({
  model: "anthropic/claude-sonnet-5",        // AI SDK LanguageModel：实例或 gateway 字符串
  instructions: "你是天气助理。",
  tools: {
    // record key 即工具名（对应 eve 的"文件名即工具名"）
    get_weather: defineTool({
      description: "查询某城市当前天气。",
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => `${city}: 晴，26°C`,   // input 类型由 inputSchema 推导
    }),
  },
});

const session = createSession(agent);
const result = await session.send("上海今天天气怎么样？");
console.log(result.finalResponse);
```

## API 面清单

以下按 API 分层列出（语义细节见 [core-sdk · 技术方案](../../docs/logic/engine/tech/core-sdk.md) 对应小节）。

### L1 · 定义层（§4.1）

| 导出 | 说明 |
|---|---|
| `defineAgent(def): AgentDefinition` | 纯声明恒等函数。字段：`model`（必填）、`instructions?`、`tools?`、`builtinTools?`（数组白名单或 `false`）、`skills?`、`maxTurnsPerRun?`（默认 100，计 send() 内模型步数）、`maxOutputTokens?`、`maxContextTokens?`（opt-in 上下文上限，超限 `turn.failed`/`context_overflow`） |
| `defineTool({ description, inputSchema, outputSchema?, approval?, execute }): Tool` | zod v4 `inputSchema` 推导 `execute` 的 input 类型（`In extends z.ZodType<JsonValue>`——工具输入来自模型 JSON）；返回类型擦除态 `Tool` |
| `defineSkill({ name, description, markdown, files? }): Skill` | 程序化 skill（eve 同款） |
| `Skill.fromDirectory(path)` / `Skill.fromFS(fs, path)` / `Skill.fromMarkdown(name, md)` | packaged（要求 `description` frontmatter，缺失报错）与 flat（无 frontmatter 时取首个非空非代码行为 description）两种形态；Claude 官方 skill 目录与 eve 布局不改动即可加载 |
| `BuiltinToolName`、`READ_ONLY_TOOLS` | 内置工具名联合（九个可裁剪名；`load_skill`/`bash` 是条件内置不在其列）；只读预设（read_file/list_dir/glob/grep） |

### L2 · 运行层（§4.2 / §4.8）

| 导出 | 说明 |
|---|---|
| `createSession(agent, opts?): Session` | `SessionOptions`：`fs?`、`exec?`（注入即激活 `bash` 工具）、`workspace?`（`NimboFS & NimboExec` 同源一次注入，与前两者互斥、同传同步抛错）、`onApproval?`、`instructions?: { append }`、`resume?: SessionState`、`readState?`/`derivedData?`（外部工具装配接缝） |
| `Session.send(input, opts?)` | Promise 完整 `TurnResult`（`items` / `finalResponse` / `usage`）；`turn.failed` 时抛 `NimboSessionError`（带 `code`） |
| `Session.send<T>(input, { outputSchema })` | 结构化输出重载：正常 turn 收尾后独立一轮折叠成 zod 校验的 `T`（`structuredOutput` 字段叠加），校验失败重试 ≤2 次，耗尽抛 `NimboStructuredOutputError` |
| `Session.stream(input, opts?)` | AsyncGenerator 事件流：`session.started` / `turn.started` / `item.started` / `item.updated` / `item.completed` / `turn.completed` / `turn.failed`；item 类型 `agent_message` / `reasoning` / `tool_call` / `file_change` / `plan_update` / `error` |
| `Session.toJSON({ includeFs? })` | 可序列化 `SessionState`（messages 即 AI SDK `ModelMessage`）；`includeFs: true` 内联 fs 快照（需 fs 支持 `snapshot()`）；经 `SessionOptions.resume` 恢复 |
| `Input` / `InputBlock` | 纯字符串或 text / image blocks |
| `NimboSessionError`、`NimboError` | `code`: `"max_turns" \| "context_overflow" \| "provider_error" \| "aborted"` |
| `createSessionReadState()` / `createDerivedDataCollector()` | 预构造 store 供外部文件工具装配（`@nimbo/sdk` 默认装配即走此通路） |

### L0 · 原语接口（§4.4 / §4.5a）

| 导出 | 说明 |
|---|---|
| `NimboFS`（类型） | 七方法虚拟文件系统接口：`readFile` / `writeFile` / `rm` / `mkdir` / `readdir` / `stat` / `glob`；实现见 `@nimbo/virtual-fs`。`FileStat` 含 `mimeType?` / `href?`（reference 条目）/ `annotations?` |
| `NimboExec`（类型） | 命令执行接口：`exec(req, opts?)`（失败也以 resolve 的 `ExecResult` 返回，非零 `exitCode`）+ 可选 `describe()`（环境自描述，拼进 bash 工具描述）+ 可选 `defaultApproval`（未声明兜底 `"always"`） |
| `Tool` / `ToolContext` | 类型擦除态工具；`ctx`: `fs` / `abortSignal` / `callId` / `session` / `getSkill(name)` / `update(partial)` |
| `ApprovalPolicy` / `ApprovalDecision` | `"never" \| "always" \| "once" \|` 回调；两层审批链 per-tool → session `onApproval`；`"always"`/`"once"` 升级后无人裁决即 deny（带指导），`allow` 可携 `updatedInput` 改参 |
| `JsonValue` / `jsonValueSchema` / `ToolReturn` | JSON 值类型与运行时校验 |
| `SessionState` / `sessionStateSchema` / `modelMessageSchema` | 序列化状态与 zod 校验 |

### 内置工具本体与参考实现

| 导出 | 说明 |
|---|---|
| `createUpdatePlanTool` / `createPlanStore` | `update_plan` 工具（整表替换，产生 `plan_update` item） |
| `createLoadSkillTool` | `load_skill` 工具（skills 配置时隐式注入；返回 skill markdown + 附属文件清单） |
| `createBashTool` | `bash` 工具（exec 注入时隐式出现；stdout/stderr 各 64KB 截断、`onOutput` → `item.updated` 流式回报） |
| `localExec(opts?)` | `NimboExec` 本机参考实现（`node:child_process`）：出厂 `defaultApproval: "always"`；`{ materialize: true, fs }` 为模式 B（执行前物化 VirtualFS 到临时目录、执行后按 mtime 回收），不传 materialize 为模式 C（直跑真实磁盘，完全解耦） |
| `buildAvailableSkillsBlock` / `mountSkillFiles` / `createGetSkill` / `skillMountPath` | skills 注入机制（`<available_skills>` 段、`/.skills/<name>/` 挂载） |

### L3 · 目录约定层（§4.7，`@nimbo/core/load` 子路径或主入口）

| 导出 | 说明 |
|---|---|
| `loadAgent(dir, opts?)` | eve 布局：`instructions.md`（必需或 `opts.instructions`）+ `agent.ts`/`agent.json`（只读 model 等 5 个标量运行配置字段）+ `tools/*.ts`（文件名即工具名，动态 import，需 Node ≥ 22.18 原生 TS 或 `.js` 产物）+ `skills/`（flat + packaged）；目录扫描是 tools/skills/instructions 的唯一事实来源 |
| `loadAgentFromFS(fs, dir, opts?)` | 从 VirtualFS 加载，只读 instructions 与 skills（虚拟 FS 内的代码不做动态求值，无任意代码执行面）；工具由宿主程序化传入 |

### 进阶接缝（自建 loop / 运行时定制才需要）

`runStep` / `convertTools`（AI SDK step runner，§4.3）、`runTurn`（单 turn loop）、`evaluateApproval` / `createOnceApprovalMemory`（审批链）、`executeToolCall`（工具运行时）、`generateStructuredOutput`。一般宿主不直接触碰。
