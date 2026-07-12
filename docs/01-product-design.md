# nimbo 产品功能设计文档

> 状态：草案 v1（2026-07-10）
> 相关文档：[技术实现文档](./02-tech-spec.md) · [施工计划](./03-construction-plan.md)

## 1. 一句话定义

nimbo 是一个**可嵌入 Node.js 应用的轻量 agent SDK**：开发者用几行代码就能在自己的服务里跑起一个具备文件操作、命令执行、skills 能力的 agent loop，而无需依赖任何外部 CLI 二进制。

## 2. 要解决的问题

现有方案的空缺：

| 现有方案 | 问题 |
|---|---|
| `@openai/codex-sdk` | 只是 codex CLI 的进程封装（spawn `codex exec` + JSONL）。依赖平台二进制、绑定 OpenAI、**没有虚拟文件抽象**——agent 只能操作真实磁盘；会话状态落在 `~/.codex/sessions`，难以在服务端多租户场景使用。 |
| `@anthropic-ai/claude-agent-sdk` | 同样封装 Claude Code CLI，重、绑定 Anthropic 生态。 |
| `@anthropic-ai/sdk` / `openai` | 纯 API client，只给你 messages/tool-use 原语，agent loop、工具、文件、skills 全要自己搭。 |
| `eve`（eve.dev） | API 设计优秀（nimbo 的 API 层次即参考它），但它是带 HTTP server 与 durable workflow 的**框架**（`eve dev`/`eve start`、按 session 走 HTTP+NDJSON），不是可嵌入进程内的库；文件操作在真实沙盒，无虚拟 FS。 |

**核心痛点**：想在一个普通 Node 服务里嵌入"能改文件、能执行任务"的 agent，今天要么被绑死在某家 CLI 上（重、难沙盒、难多租户），要么从零手写 loop（重复劳动、输入输出粗糙）。

## 3. 目标用户与使用场景

**目标用户**：在 Node.js/TypeScript 应用中集成 agent 能力的后端/全栈开发者。

典型场景：

1. **SaaS 内嵌代码助手**：用户上传/粘贴一个项目片段，服务端让 agent 在**虚拟文件系统**中修改，diff 返回给用户——全程不碰服务器真实磁盘，天然多租户安全。
2. **自动化流水线节点**：CI/后台任务中调用 agent 完成一个明确任务（生成配置、迁移代码、写报告），以结构化输出接回流水线。
3. **带领域能力的 agent 产品**：通过 SKILL.md 形式给 agent 注入领域知识（公司规范、内部 API 用法），复用 Claude skills 生态的现成资产。
4. **自定义执行环境**：宿主已有自己的沙盒/容器/远程执行器，只需把"命令执行"作为工具注入 nimbo，loop 与工具彻底解耦。

## 4. 用户可见行为与交互（对外 API 的产品视角）

### 4.1 最小上手（5 行可运行）

```ts
import { defineAgent, createSession } from "nimbo";
import { anthropic } from "@ai-sdk/anthropic";   // 模型层即 Vercel AI SDK，30+ provider 任选

const agent = defineAgent({ model: anthropic("claude-sonnet-5") });
const session = createSession(agent, { fs: NimboFS.fromDirectory("./project") });
const result = await session.send("把 src/index.ts 里的 var 全部改成 const");
console.log(result.finalResponse, session.fs.diff());
```

### 4.2 核心概念（用户心智模型，API 层次参考 eve.dev）

- **AgentDefinition**（`defineAgent`）：agent 是一个纯声明值——model、instructions、tools、skills。可复用、可测试、无运行状态；也可用 `loadAgent("./agent")` 从 eve 兼容的目录布局（`instructions.md` + `tools/` + `skills/`）加载。
- **Session**（`createSession`）：一次多轮任务会话，持有全部运行状态。`send()` 跑一轮，重复 `send()` 延续上下文；可序列化/恢复（服务端友好）。
- **TurnResult**：一轮的结果——items 流水（消息、推理、工具调用、文件变更）+ finalResponse + usage。
- **VirtualFS**：会话的工作区。可从内存对象、真实目录（零拷贝 overlay 挂载）、或自定义实现构建；agent 的所有文件读写默认落在这里；结束后可导出 diff / 写回磁盘。
- **Tools**（`defineTool`）：工具层，全部可注入可替换。内置文件工具（基于 VirtualFS）与可选命令执行工具；宿主可注册自定义工具，支持 per-tool 审批策略 + session 级审批回调。
- **Skills**（`defineSkill` / SKILL.md）：Claude SKILL.md 与 eve flat/packaged 两种形态兼容的能力包，从真实目录或 VirtualFS 加载，经 `load_skill` 工具按需装载（渐进式披露）。

### 4.3 输入

- 纯字符串，或结构化 blocks（text / image）。
- 每轮可带 `outputSchema`（JSON Schema / zod），要求结构化输出。
- `signal: AbortSignal` 取消。

### 4.4 输出

两种消费方式（session/turn 生命周期命名参考 eve，item 粒度对齐 codex-sdk）：

- **`send()`**：Promise，返回完整 `TurnResult`。
- **`stream()`**：AsyncGenerator 事件流——`session.started / turn.started / item.started / item.updated / item.completed / turn.completed / turn.failed`；item 类型包括 `agent_message`、`reasoning`、`tool_call`、`file_change`、`error`。

### 4.5 虚拟文件（关键差异化功能）

- `NimboFS.fromMemory({ "src/index.ts": "..." })` —— 纯内存工作区。
- `NimboFS.fromDirectory("./project")` —— 真实目录零拷贝 overlay 挂载（读穿透磁盘、写落内存层），跑完 `fs.diff()` / `fs.writeBack()`。
- **文件元信息与引用条目** —— 条目可带 mimeType 与宿主标注（"这是首页设计稿，用 figma_export 处理"）；还支持 reference 条目（URL/CI 构建产物等外部资源作为文件出现在 FS 里），agent 用 list_dir/read_file 自然感知"这是个啥、该用什么工具"，注入 resolver 后可直读。
- agent 视角是普通文件系统；宿主视角是一个可检查、可导出、可丢弃的对象。
- 文件变更以 `file_change` item 实时流出。

### 4.6 Skills

- `skills: [Skill.fromDirectory("./skills/pdf")]` 或从 VirtualFS 加载。
- 加载时只注入 name/description（渐进式披露），agent 需要时才读取 SKILL.md 全文与附属文件——与 Claude 的 skills 行为一致。

### 4.7 工具注入与审批

- `tools: { name: defineTool({ description, inputSchema(zod), approval?, execute }) }`：record key 即工具名（对应 eve 的"文件名即工具名"），目录约定层则从 `tools/*.ts` 文件名推导。
- **命令执行 = 内置 bash 工具 + 可注入的执行环境（`NimboExec`）**，与"内置文件工具 + 可注入 NimboFS"完全同构：注入了 exec 实现才出现 bash 工具，默认无命令执行面。nimbo 提供本地子进程参考实现（`localExec`，默认要求审批），宿主注入 Docker/远程/自研沙盒实现即可换掉执行环境——nimbo 不关心沙盒长什么样；同一对象实现 `NimboFS & NimboExec` 时文件与命令天然同环境（`workspace` 一次注入）。
- 审批分两层：per-tool `approval` 策略（`"always"`/`"once"`/`"never"`/回调，eve 同款）+ session 级 `onApproval` 兜底回调（允许/拒绝/改参）。

## 5. 范围与非目标

### 范围（v1）

- 自研 agent loop（tool-use 循环、上下文管理、流式事件）。
- 模型层基于 Vercel AI SDK：任何 `LanguageModel` 可用（`@ai-sdk/anthropic`、`@ai-sdk/openai-compatible` 覆盖 DeepSeek/Qwen/Ollama 等、gateway 字符串）。
- VirtualFS（内存 / 目录 overlay 挂载 / 自定义实现）+ 内置文件工具。
- SKILL.md 兼容的 skills 加载与渐进式披露（含 `defineSkill` 程序化定义）。
- 工具注入、两层审批；内置 bash 工具 + `NimboExec` 执行环境接口（`localExec` 参考实现）。
- 目录约定层 `loadAgent`（eve 布局兼容：instructions.md / tools / skills）。
- 会话序列化/恢复。
- 结构化输出（outputSchema）。

### 非目标（v1 明确不做）

- 不做 OS 级/容器级沙盒实现（只定义工具接口，沙盒由宿主注入）。
- 不做 CLI 交互界面（这是 SDK，不是 codex/claude code 的替代品）。
- 不做 MCP client/server（预留接口位，v2 考虑）。
- 不做浏览器端支持（Node ≥ 20 only）。
- 不内置计费/限流/多租户管理（宿主职责）。
- 不追求 sub-agent、hooks 等高级编排（v2 考虑）。

## 6. 成功标准

- 5 行代码跑通第一个例子；README 示例全部可复制运行。
- 一个"上传代码片段 → agent 修改 → 返回 diff"的端到端 demo 不写任何临时文件。
- 现成的 Claude skill 目录不改动即可被 nimbo 加载并生效。
- 换掉命令执行工具的实现（本地→自定义）不需要改任何 loop 相关代码。
