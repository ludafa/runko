# core-sdk（技术方案）

> 相关：[产品/使用手册](./feature.md) · [施工进展](./plan.md)
> 依赖：[builtin-tools](../builtin-tools/tech.md)（内置工具本体与规格）· [sandbox](../../host/sandbox/tech.md)（`NimboFS & NimboExec` 的云沙盒实现，含 §4.4 两个可选[原生搜索](../../terms.md)方法的适配器契约与逐家映射，拆单见 [host/native-search/plan](../../host/native-search/plan.md)）
> 被延续/演进：[single-ledger](../../agent/single-ledger/tech.md)（P13-5：[账本](../../terms.md)改为 [UIMessage](../../terms.md) 单账本、`session.stream()` 吐 ai [chunk](../../terms.md)、[审批结果](../../terms.md)三值化、内置工具名 kebab-case——本页 §4.2 事件模型、§4.5 审批链、§4.8 loop 细节均已按 P13-5 落地状态书写，机制全文见该功能文档）

> 状态：技术方案 v3（2026-07-10 模型层改为基于 Vercel AI SDK；v2 改 API 层次参考 eve.dev；v1 见 git 历史）。P13-5（single-ledger）之后的事件模型/审批语义变化已就地并入对应小节。

## 0. 调研结论（设计输入）

对参考对象的调研结论（2026-07 版本）：

- `@openai/codex-sdk@0.144.1`：spawn `codex exec --experimental-json`，stdin/stdout JSONL。`turn/item` 粒度的事件模型干净，**nimbo 的 item 级事件粒度沿用它**。无虚拟文件；会话落在 `~/.codex/sessions`。
- `@anthropic-ai/claude-agent-sdk@0.3.x`：spawn 平台原生 `claude` 二进制（240MB+）。skills（SKILL.md、渐进式披露）、`canUseTool` 审批回调值得借鉴。无虚拟 FS。
- `@anthropic-ai/sdk`：纯 HTTP client；`toolRunner` 是最接近自研 loop 的原语。
- **`eve`（eve.dev）**：TypeScript agent 框架，**nimbo 对外 API 的层次参考它**——
  - 定义层：`defineAgent({ model })` / `defineTool({ description, inputSchema, approval?, execute(input, ctx) })` / `defineSkill({ description, markdown, files })`，全部是纯声明值；工具名来自文件名，`defineTool` 本身不含 name 字段；
  - 目录约定层：`agent/` 目录即 agent——`instructions.md`（系统提示）、`agent.ts`（`defineAgent`）、`tools/*.ts`（自动发现，文件名即工具名）、`skills/`（flat `.md` 或 packaged `SKILL.md` 目录）；
  - 运行层：session 模型 + NDJSON 事件流 + continuation token 续轮；skills 经 `load-skill` 工具按需装载（"Loading a skill adds instructions, never a new execution surface"）；工具经 `ctx.getSkill(id)` 读 skill 附属文件；
  - 但 eve 是**带 HTTP server 与 durable workflow 的框架**（`eve dev`/`eve start`），不是可嵌入 SDK；文件操作也在真实沙盒里。
- **Vercel AI SDK（`ai@7.0.19`，2026-07 稳定版）**：**nimbo 的模型层基于它**——
  - `streamText` 手动 loop 是官方支持的一等模式（cookbook "Manual Agent Loop"）：tools 声明时**省略 `execute`** → `finishReason === "tool-calls"` 时 tool call 原样返回，调用方自己执行、自己以 `role: "tool"` 消息回填、再进下一步——这正是 nimbo 审批链/自有工具运行时需要的控制点；
  - 统一 `LanguageModel` 抽象：`@ai-sdk/anthropic`、`@ai-sdk/openai-compatible` 等 30+ provider 包，或 `"anthropic/claude-sonnet-5"` 字符串走 AI Gateway；eve 也直接依赖 `ai`（其 model 字符串即此格式）；
  - `ModelMessage` 是可 JSON 序列化的标准消息格式；`fullStream` 提供 `text-delta`/`reasoning-delta`/`tool-call`/`tool-input-delta` 等增量块；`ai/test` 提供 `MockLanguageModel` 与流模拟工具；
  - 依赖树干净：`ai` 只依赖自家 `@ai-sdk/provider(-utils)`/`gateway`，无二进制；zod 与 nimbo 共用；
  - 也有更高层的 `ToolLoopAgent`/`@ai-sdk/workflow`（含 `needsApproval` 审批），但那会把 loop 语义让渡给 AI SDK（见 §4.3 选型说明）。

**结论**：nimbo = eve 的 API 层次与人体工学 + codex-sdk 的 item 级事件粒度 + AI SDK 的模型层 + 自有的 VirtualFS 内核与 loop，以可嵌入库（而非 server 框架）的形态交付。

## 1. 设计原则

1. **零二进制依赖、极少 npm 依赖**：不 spawn 任何 CLI；模型层复用 Vercel AI SDK（`ai` 包，依赖树无二进制），协议细节（SSE、各家 tool-calling 差异）不自己维护。运行时依赖 2 个：`ai` + `zod`；provider 包（`@ai-sdk/anthropic` 等）由宿主按需安装。
2. **一切可注入**：模型（AI SDK `LanguageModel`）、文件系统（FS 接口）、工具（Tool 接口）、审批（策略/回调）。内置实现都只是接口的默认实现。
3. **定义与运行分离**（learned from eve）：agent 定义是纯数据（可复用、可测试、可静态分析），运行状态全部在 session 里。
4. **类型安全**：公共 API 无 `any`/`unknown` 泄漏；判别联合 + zod 边界校验；工具输入类型由 `inputSchema` 推导。
5. **服务端友好**：无全局状态、无隐式磁盘写入、session 可序列化、可并发多实例。

## 2. API 分层（本次设计的骨架）

```
L3 目录约定层（可选）   loadAgent("./agent")：eve 布局兼容（instructions.md/tools/skills），也可从 VirtualFS 加载
L2 运行层              createSession(agent, opts) → session.send()/stream()/toJSON()
L1 定义层              defineAgent / defineTool / defineSkill —— 纯声明值，无运行状态
L0 原语层              LanguageModel(AI SDK) / NimboFS / NimboExec / Tool / ApprovalPolicy —— 可注入接口与内置实现
```

- 上层永远只依赖下层的接口；宿主可以停在任何一层使用（只用 L0 的 NimboFS 做文件沙盒也是合法用法）。
- 与 eve 的对应关系：L1/L3 形态对齐 eve（迁移心智零成本）；L2 的差异在于 nimbo 是**进程内 session 对象**而非 HTTP 服务——eve 的 `POST /session` + NDJSON 流在 nimbo 里是 `session.stream()` 这个 AsyncGenerator。

包结构（pnpm monorepo，五包；依赖单向 sdk → {core, virtual-fs, mini-bash}，virtual-fs/mini-bash → core，just-bash → core 但不进 sdk）：

```
@nimbo/sdk          # 主包（门面）：re-export 全部，batteries-included，5 行上手只装它
@nimbo/core         # L0 接口 + L1 定义层 + L2 运行层 + AI SDK step runner + skills + load-skill/update-plan/bash 工具本体
@nimbo/virtual-fs   # MemoryFS/OverlayFS/DirFS/mime/diff/reference + 文件工具八件套
@nimbo/mini-bash    # NimboExec 实现：纯 TS 解释器（cat/grep/find/tail/head/echo/cd/pwd + 管道/;/&&/||/2>&1），跑在任意 NimboFS 上，只读、defaultApproval "allow"；cd 双层语义（脚本内链间生效 + 实例级跨调用持久化，req.cwd 显式时优先；管道内按 POSIX 子 shell 无效果）；文件重定向（>/>>/<）刻意不支持——写面走 write-file 工具（有 file_change 事件与 readState 登记，重定向写是旁路）
@nimbo/just-bash    # NimboExec 实现（v1.1，全语法档）：vercel-labs/just-bash 适配器——完整 if/for/while/case/函数/变量/重定向，NimboFS→IFileSystem 适配，defaultApproval "allow"，不进 sdk 依赖（见 §4.5b）
```

（core 单列是为破循环：文件工具需要 core 的 Tool 类型，主包默认体验又需要文件工具。模型层直接用 AI SDK 的 provider 包，无自建 provider 层。）

技术选型：TypeScript strict、**typescript@7（tsgo 原生编译器）** / Node ≥ 20（L3 的 tools 自动发现需 ≥ 22.18 原生 TS，见 §4.7）/ tsdown 产出 ESM+CJS+d.ts / **`ai@^7`（模型层，peerDep）** / zod v4 / vitest@4 + `ai/test` 的 MockLanguageModel / pnpm workspace + catalog。**权衡记录**：v1/v2 曾决策"原生 fetch + 自写 SSE 直连各家 API"，v3 推翻——自研 provider 层省下的依赖体积，抵不过持续跟进各家协议演进的维护成本；AI SDK 依赖树无二进制、`streamText` 手动 loop 官方支持、provider 生态即"接入各种 LLM"的完整答案。代价是绑定 AI SDK 的大版本节奏（v5→v6→v7 迭代快），缓解见 §6。

## 3. 架构与数据流

```
宿主 Node 应用
   │ L1: const agent = defineAgent({ model, instructions, tools, skills })
   │ L2: const session = createSession(agent, { fs, onApproval, onReview })
   ▼
┌────────────────────────── Session ───────────────────────────┐
│  状态: messages[](NimboUIMessage), fs, usage, approvals(会话级授权) │
│    send()/stream()                                            │
│         │ 组装: instructions + <available_skills> 元数据        │
│         ▼                                                     │
│    AgentLoop ──streamText(每步,tools无execute)──▶ AI SDK ──▶ LLM │
│         ▲                          │ fullStream 增量块          │
│         │ tool 消息回填             ▼                           │
│    ToolRuntime ◀─tool-call── chunk 生产器 ──NimboChunk──▶ 宿主   │
│      │ approval 链(per-tool → 分类器 onApproval → 人审 onReview)   │
│      ▼                                                        │
│    Tool.execute(input, ctx { fs, abortSignal, getSkill, ... }) │
│      ├─ 内置文件工具 ──▶ NimboFS (MemoryFS / OverlayFS / 自定义)  │
│      ├─ load-skill 工具 ──▶ SkillRegistry                      │
│      └─ 宿主注入工具（exec/沙盒/任意）                            │
└───────────────────────────────────────────────────────────────┘
```

一轮 `send()`/`stream()` 的数据流：组装消息（`convertToModelMessages(ledger)`）→ provider 流式返回 → 文本/推理增量翻译为 chunk → 收到 `tool_call` → 审批链 → 执行工具（读写 VirtualFS 或宿主逻辑）→ `tool_result` 回填账本 → 再调 provider → 直到无 tool_call 或触达上限 → 轮收尾（`message-metadata` chunk）。用时序图表达实际调用链（对齐 `session.ts` → `loop.ts` `runTurn`/`runOneStep`/`settleToolCall` → `runtime.ts` → `approval.ts`）：

```mermaid
sequenceDiagram
    autonumber
    actor Host as 宿主/调用方
    participant Session as Session (session.ts)
    participant Loop as runTurn (loop.ts)
    participant AISDK as streamText (AI SDK)
    participant LLM as LLM Provider
    participant Approve as 审批链 (approval.ts / onReview)
    participant Runtime as ToolRuntime (runtime.ts)
    participant Tool as Tool.execute / NimboFS

    Host->>Session: send(input) / stream(input)
    Session->>Session: await skillFilesMounted + messagesReady
    Session->>Session: turn += 1；把 input 组成 user NimboUIMessage 追加进账本
    Session->>Loop: runTurn({ model, messages, tools, onApproval, onReview, ... })

    loop 每个 step（≤ maxTurnsPerRun）
        Loop->>Loop: drainSteer + 上下文估算（超 maxContextTokens → context_overflow 收尾）
        Loop->>AISDK: runOneStep：convertToModelMessages(账本) → streamText(tools 无 execute)
        AISDK->>LLM: 流式请求
        LLM-->>AISDK: fullStream 增量块
        AISDK-->>Loop: text-delta / reasoning-delta / tool-call
        Loop-->>Host: 翻译为 text-*/reasoning-* chunk（实时）
        Loop->>Loop: tool-call → 落 input-available 部件，yield tool-input-available，进 pending[]

        loop 每个 pending tool_call（settleToolCall）
            Loop->>Approve: resolveToolCallApproval：inputSchema.safeParse + evaluateApproval(per-tool → onApproval)
            alt outcome = allow
                Loop->>Runtime: executeToolCall(input 已校验)
                Runtime->>Tool: Tool.execute(input, ctx{ fs, abortSignal, getSkill, update })
                Tool-->>Runtime: ToolReturn（读写 VirtualFS / 宿主逻辑）
                Runtime-->>Loop: completed/failed + 派生 file_change/plan_update
                Loop-->>Host: tool-output-available/-error (+ data-file-change/data-plan-update)
            else outcome = review
                Loop-->>Host: yield tool-approval-request（界面弹审批卡片）
                Loop->>Approve: await onReview(req)（阻塞等真人裁决）
                Approve-->>Loop: HumanDecision（allow / deny+理由）
                Loop-->>Host: tool-approval-response
                alt 人工 allow
                    Loop->>Runtime: executeToolCall
                    Runtime->>Tool: Tool.execute
                    Tool-->>Runtime: ToolReturn
                    Runtime-->>Loop: completed/failed
                    Loop-->>Host: tool-output-available/-error
                else 人工 deny / 无仲裁者
                    Loop-->>Host: tool-output-denied（拒绝理由回填模型）
                end
            else outcome = deny
                Loop-->>Host: tool-output-denied（拒绝理由回填模型）
            end
            Loop->>Loop: 结算态部件原地覆盖 input-available，tool_result 进账本
        end

        alt finishReason === "tool-calls" 且预算未耗尽
            Note over Loop: 带着 tool_result 进下一 step，再调 provider
        else 无 tool_call / 触达上限
            Note over Loop: 跳出循环，收尾
        end
    end

    Loop->>Loop: finalizeTurn：把 {turn, usage, status} 写进末条 assistant 消息 metadata
    Loop-->>Host: message-metadata chunk（轮收尾/失败哨兵）
    Loop-->>Session: return TurnResult{ finalResponse, usage }
    Session-->>Host: send() 聚合出 TurnResult（status=failed 时 throw NimboSessionError）
```

## 4. 关键模块与接口设计

### 4.1 L1 定义层

```ts
// ---- defineAgent：纯声明，无运行状态 ----
function defineAgent(def: AgentDefinition): AgentDefinition;   // 恒等函数，价值在类型推导与将来扩展位

interface AgentDefinition {
  model: LanguageModel;                        // AI SDK 模型实例或 "provider/model" gateway 字符串
  instructions?: string;                       // 系统提示正文（L3 会从 instructions.md 填入）
  tools?: Record<string, Tool>;                // key 即工具名（对应 eve 的"文件名即工具名"）
  builtinTools?: BuiltinToolName[] | false;    // 默认全部文件工具；false 关闭
  skills?: Skill[];
  maxTurnsPerRun?: number;                     // 默认 100（计数语义见 §4.8"max_turns 语义"）
  maxOutputTokens?: number;
  maxContextTokens?: number;                   // 上下文显式上限，opt-in（P4-2 回填，语义见 §4.8）
}

// ---- defineTool：对齐 eve 的字段命名，无 name 字段 ----
// In/Out 约束为 P1-2 施工修正（原文 In extends z.ZodType、Out = ToolReturn 均无约束）：
// 工具输入来自模型产生的 JSON tool-call 参数、返回值须落入 ToolReturn 才能进事件系统，
// 约束只是显式化这两个既有运行时事实；无约束时 defineTool 体内对类型擦除态 Tool 的
// 赋值过不了 tsc（泛型 Output 位不透明），而加 as 违反类型硬规范。精确推导不受影响。
function defineTool<In extends z.ZodType<JsonValue>, Out extends ToolReturn = ToolReturn>(def: {
  description: string;
  inputSchema: In;                             // zod v4；JSON Schema 直传列为 v2
  outputSchema?: z.ZodType<Out>;               // 可选，执行后校验
  approval?: ApprovalPolicy;                   // "allow"(默认放行) | "review" | "review-once" | "deny" | 回调（三值，见 §4.5）
  execute(input: z.infer<In>, ctx: ToolContext): Promise<Out> | Out;
}): Tool;

type ToolReturn = string | JsonValue;          // JSON 可序列化；对象会 JSON.stringify 给模型

// 审批三值化（P13-5，见 single-ledger §6）：策略/分类器产出 ApprovalOutcome，人工裁决产出 HumanDecision
type ApprovalOutcome = "allow" | "review" | "deny";   // 策略/分类器对单次调用的解析结果
type ApprovalPolicy =
  | "allow" | "review" | "review-once" | "deny"       // 固定策略（review-once：批准一次后本会话记住，见 §4.5）
  | ((input: JsonValue, ctx: ApprovalContext) => ApprovalOutcome | Promise<ApprovalOutcome>);  // 审批分类器回调
type HumanDecision =                                   // review 弹卡片后真人的裁决（纯两值，无改参）
  | { behavior: "allow" }
  | { behavior: "deny"; message?: string };            // message = 拒绝理由，回填模型

interface ToolContext {
  fs: NimboFS;
  abortSignal: AbortSignal;                    // eve 命名
  callId: string;
  session: { id: string; turn: number };
  getSkill(name: string): SkillHandle;         // eve 形态：handle.file(relPath).text()
  update(partial: string): void;               // 流式进度 → transient data-tool-progress 部件（只直播不落盘）
}

// ---- defineSkill：程序化 skill（eve 同款）+ SKILL.md 兼容加载 ----
function defineSkill(def: {
  name: string;                                // 程序化定义需显式 name（无文件名可推导）
  description: string;
  markdown: string;                            // SKILL.md 正文
  files?: Record<string, string | Uint8Array>; // 附属文件
}): Skill;

const Skill: {
  fromDirectory(path: string): Promise<Skill>;         // packaged：SKILL.md + 附属文件
  fromFS(fs: NimboFS, path: string): Promise<Skill>;   // 从 VirtualFS 加载
  fromMarkdown(name: string, md: string): Skill;       // flat skill（eve 的 skills/*.md 形态）
};
```

frontmatter 规则与 eve/Claude 一致：packaged skill 的 `SKILL.md` 要求 `description` frontmatter（缺失报错）；flat markdown 无 frontmatter 时取首个非空非代码行为 description。

**内置工具名（P13-5 起 kebab-case，见 single-ledger）**：`BuiltinToolName` 九名可裁剪联合 = `read-file`/`write-file`/`edit-file`/`delete-file`/`move-file`/`list-dir`/`glob`/`grep`/`update-plan`；`load-skill`（由 `agent.skills` 隐式控制）、`bash`（由 `NimboExec` 注入隐式控制）是条件内置，不在可裁剪列表里。`READ_ONLY_TOOLS = [read-file, list-dir, glob, grep]` 为只读审查预设。

**`Tool.readOnly`（2026-07-16）**：工具级纯读声明（无副作用：不写工作区、不产生 file-change/plan-update 派生数据）。loop 对同一 step 的一批 tool call 默认串行结算；**整批全部 `readOnly` 时并行结算**（`loop.ts` `runOneStep` 的 settle 分支 + `mergeSettleStreams` 合并出流）——模型同批调用本就是一组独立操作（parallel tool use 契约），全只读时没有写冲突可言；混入任何非只读调用则整批退回串行，兜住模型偶发的"同批隐含顺序依赖"坏批次。上述四个只读内置工具已声明该标记；自定义工具缺省视为有副作用。

### 4.2 L2 运行层

```ts
function createSession(agent: AgentDefinition, opts?: SessionOptions): Session;

interface SessionOptions {
  fs?: NimboFS;                                // 默认空 MemoryFS（由 @nimbo/sdk 装配；core 未注入时为抛错占位）
  exec?: NimboExec;                            // 注入即激活内置 bash 工具（见 4.5a）
  workspace?: NimboFS & NimboExec;             // 语法糖：同源工作区一次注入 fs + exec（与前两者互斥）
  onApproval?: ApprovalPolicy;                 // 会话级审批分类器（三值，取代旧 shouldAutoAllow）；见 4.5
  onReview?: (req: ApprovalReviewRequest) => Promise<HumanDecision>;   // 人审通道：策略/分类器产出 review 时调用（弹卡片等真人裁决）
  instructions?: { append: string };           // 在 agent 定义之上追加（多租户注入场景）
  resume?: SessionState;                       // 反序列化恢复（validateSessionMessages 校验账本 UIMessage）
  readState?: SessionReadState;                // P4-2 回填注入位（先有鸡后有蛋，见下）
  derivedData?: DerivedDataCollector;          // 同上
}

interface Session {
  readonly id: string;
  readonly fs: NimboFS;
  readonly readState: SessionReadState;          // 接缝：供外部构造的 createFileTools 共享同一 readState
  readonly derivedData: SessionDerivedDataRecorder; // 接缝：外部工具的 file_change/plan_update 上报通道
  send(input: Input, opts?: TurnOptions): Promise<TurnResult>;
  send<T>(input: Input, opts: TurnOptions & { outputSchema: z.ZodType<T> }): Promise<TurnResult & { structuredOutput: T }>;
  stream(input: Input, opts?: TurnOptions): AsyncGenerator<NimboChunk, TurnResult>;
  steer(input: Input): boolean;                  // 软 steer（STEER-1 施工回填），见下方说明
  toJSON(opts?: { includeFs?: boolean }): SessionState;
}

type Input = string | InputBlock[];            // InputBlock: text | image({ data, mediaType })
interface TurnOptions { signal?: AbortSignal; }  // P7-2 修正：不含裸 outputSchema 字段（原文有），
                                                 // outputSchema 只经 send<T> 重载的交叉类型出现——
                                                 // zod v4 下裸 z.ZodType 字段会让未用泛型的调用点推出 unknown 泄漏公共类型
interface TurnResult { finalResponse: string; usage: Usage; }   // P13-5 起去掉 items（账本即时间线，见下"事件模型"）
```

**SessionOptions 施工补充（P4-2 回填）**：`readState?: SessionReadState`、`derivedData?: DerivedDataCollector` 两个可选注入位，`Session` 相应暴露 `readonly readState` 与 `readonly derivedData`（后者为去掉 `drain` 的窄上报接口）。理由：`agent.tools` 在 `createSession` 时冻结，而依赖 session 存储的外部工具（如 `@nimbo/virtual-fs` 的 `createFileTools`，需要 readState 与 file_change 上报通道）必须在那之前构造——先有鸡后有蛋。修法是宿主可预先构造这两个 store（`createSessionReadState()`/`createDerivedDataCollector()`）、拼进工具后经此注入，session 使用同一实例；未注入时 session 自建，行为不变（纯新增、向后兼容）。`@nimbo/sdk`（P7）的默认装配即走这条通路。core 与 virtual-fs 之间仅靠结构类型兼容，无跨包类型引用。

**`Session.steer`（软 steer，STEER-1 施工回填 / STEER-1F 修复 / STEER-3A Finding 4）**：turn 进行中调用 `steer(input)` 把它排队，在下一个 step checkpoint（两次模型调用之间，不打断进行中的模型流式输出或工具执行）注入为一条 user 消息并返回 `true`；没有进行中的 turn 返回 `false`，调用方应改用 `send`/`stream`。队列是 turn 作用域，turn 结束（正常收尾或抛错）即清空残留。drain 覆盖的落幕路径：`finishReason` 非 tool-calls 的正常收尾、tool-calls 触达 `maxTurnsPerRun` 预算上限、以及预算 `<= 0` 的兜底分支——三处均在 yield 终止事件之前先 drain 一次（连同循环顶部的常规 checkpoint），保证已排队的 steer 不被静默吞掉：仍有步数预算时收尾让位给多跑一步，让模型看到；已无预算（`max_turns` 路径）时 drain 到的内容仍会进 `messages`（跨 turn 持久）与账本，只是这个 turn 本身仍以 `max_turns` 收场。**已知缺口**：模型调用/工具执行本身抛错触发的轮失败（`aborted`/`provider_error`）尚不在这几个 drain 点之内，那期间排队的 steer 目前仍会被静默丢弃——留作后续工单。**`turnActive` 的复位时机**：`stream()` 在轮收尾/失败的 `message-metadata` chunk 被 yield 给消费者*之前*就复位 `turnActive`（不是等生成器整体收尾的 `finally`）——消费者一旦观察到终止事件，同一 tick 里再调 `steer()` 会诚实返回 `false`，不会出现"返回 `true` 但内容其实已经进不去、被静默丢弃"的假阳性。

**事件模型（P13-5 起，见 [single-ledger](../../agent/single-ledger/tech.md)）**：`session.stream()` 产出 **NimboChunk** —— ai 官方的 UIMessage 流协议词汇表（`UIMessageChunk`）加上 nimbo 特有的 data 部件，不再有 nimbo 自有的 `SessionEvent`/`SessionItem` 联合（已退役）。账本落盘的是 **NimboUIMessage**（= `UIMessage<NimboMessageMetadata, NimboDataParts>`）；模型上下文每步经官方 `convertToModelMessages` 现场推导，不再单独存 `nimbo_state_json`：

```ts
// 直播/回放的流单位：ai 官方 chunk（text-delta / reasoning-delta / tool-input-* /
// tool-output-* / tool-approval-request / tool-approval-response / start-step / finish-step …）
// 加上下列 nimbo data 部件的 data-<name> chunk
type NimboChunk = UIMessageChunk<NimboMessageMetadata, NimboDataParts>;

// 账本条目的消息形态：官方 UIMessage 带 nimbo 元数据与 data 部件
type NimboUIMessage = UIMessage<NimboMessageMetadata, NimboDataParts>;

interface NimboMessageMetadata {                    // 挂在消息上，不参与转 ModelMessage
  turn?: number;
  usage?: Usage;                                    // 轮收尾用量（旧 turn.completed）
  status?: "completed" | "failed" | "interrupted";  // 轮状态哨兵（旧 turn.failed，附 error 文案）
  error?: NimboError;
  steered?: boolean;                                // steer 中途插话标记（界面样式区分）
}

type NimboDataParts = {                             // 仅供界面；官方转换器转 ModelMessage 时自动丢弃
  "file-change": { changes: { path: string; kind: "add" | "update" | "delete" }[] };
  "plan-update": { items: { text: string; completed: boolean }[] };   // 对应 codex 的 todo_list
  "error": { message: string };                                       // 轮内非致命错误
  "tool-progress": { toolCallId: string; text: string };              // transient：只直播不落盘
};
```

旧 `SessionItem` 各变体的去向：agent_message→`text` 部件、reasoning→`reasoning` 部件、user_message→role=user 的 UIMessage（steer 用 metadata 标 `steered`）、tool_call→`tool-<名字>` 部件（状态机 input-available→output-available/output-error/output-denied，审批经原生 `tool-approval-request`/`tool-approval-response` 状态与 `approval-requested`/`approval-responded`）、file_change→`data-file-change`、plan_update→`data-plan-update`、error→`data-error`；轮收尾 usage/status 归消息 metadata。`data-file-change` 部件由内置文件工具执行成功后派生，宿主可实时拿到变更流。`send()` 在 `stream()` 之上实现（消费 chunk 流、聚合出完工消息与 finalResponse/usage，`message-metadata` chunk 的 `error` 字段存在时 throw `NimboSessionError`）。

**"一个 nimbo step = 一条 assistant NimboUIMessage"（迁移裁量）**：每次 `runOneStep` 新建一条 assistant 消息 push 进账本，不是把多步折进一条消息用内部 `step-start` 分隔——`convertToModelMessages()` 对两种账本组织完全等价（每条顶层 UIMessage 处理完都 flush 一次 block）。

### 4.3 L0 · 模型层（Vercel AI SDK）

```ts
import type { LanguageModel } from "ai";   // = LanguageModel 实例 | "provider/model" gateway 字符串

interface AgentDefinition {
  model: LanguageModel;                    // defineAgent 直接收 AI SDK 的模型
  // ...
}
```

**集成方式：每个 assistant step 调一次 `streamText`，loop 归 nimbo**（官方 "Manual Agent Loop" 模式）：

1. nimbo `Tool` → AI SDK `tool({ description, inputSchema })`——**刻意省略 `execute`**。AI SDK 因此不执行任何工具：`finishReason === "tool-calls"` 时 tool call 原样返回；
2. 审批链、工具执行（含 `ctx.update()` 进度）、deny 回填全在 nimbo 的 ToolRuntime 完成，结果以 `role: "tool"` 的 `ModelMessage` 回填后进入下一步 `streamText`；
3. `fullStream` 的增量块由 loop 手工翻译为 UIMessage chunk（`runOneStep` 直接消费 `result.stream`，维护 `TextUIPart`/`ReasoningUIPart` 的 `state:'streaming'|'done'`）；`result.responseMessages` 追加进账本。

**措辞校准（P3 施工实测，ai@7.0.20）**：`result.fullStream` 在 ai@7 已是 deprecated 别名，非弃用名为 `result.stream`（同一流，`TextStreamPart` 类型不变）；`ai/test` 的 mock 类实名为 `MockLanguageModelV4`（本文其余处的 `MockLanguageModel` 均指它）。

**由此获得（不再自研）**：30+ provider 包与 `@ai-sdk/openai-compatible`（覆盖 DeepSeek/Qwen/Ollama/vLLM 等兼容端点）、`"anthropic/claude-sonnet-5"` gateway 字符串（与 eve 的 model 字符串同格式）、SSE 与各家 tool-calling 协议差异的消化、请求重试、`ModelMessage` 序列化格式、`ai/test` 的 `MockLanguageModel`（替代自研 MockProvider）。

**选型说明（为何不用 AI SDK 更高层的 loop）**：`ToolLoopAgent`/`@ai-sdk/workflow` 自带 loop 与 `needsApproval` 审批，但 loop 语义（步进控制、审批的 `review-once` 记忆与 deny 回填文案、readState 强制、`plan_update` 派生、context-overflow 策略、SessionState 序列化格式）是 nimbo 的产品面——让渡给 AI SDK 后这些都要绕道实现，且其 Agent 抽象跨大版本仍在演进。也不用更底层的 `LanguageModelV3.doStream` spec 接口——那会放弃 streamText 的重试与归一化，重新背上协议维护成本。手动 loop 模式恰好落在两者之间，是官方文档承诺的稳定用法。

### 4.4 L0 · NimboFS（虚拟文件系统）

```ts
interface NimboFS {
  readFile(path: string): Promise<Uint8Array>;   // reference 条目：默认抛 ReferenceNotResolvable，注入 resolver 后返回解析内容
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  rm(path: string, opts?: { recursive?: boolean }): Promise<void>;
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<DirEntry[]>;
  stat(path: string): Promise<FileStat>;
  glob(pattern: string): Promise<string[]>;
  // ---- 以下两个可选：原生搜索接缝（docs/terms.md「原生搜索」），详细查询/结果类型与
  // 适配器契约见 host/sandbox/tech §3/§4，工具侧双路径自适应见 core/builtin-tools/tech §3.7/§3.8 ----
  searchFiles?(query: FileSearchQuery): Promise<FileSearchResult>;
  searchContent?(query: ContentSearchQuery): Promise<ContentSearchResult>;
}

interface FileStat {
  type: "file" | "dir" | "reference";
  size?: number;
  mtime?: number;                          // readState 判据（§4.5a）
  mimeType?: string;                       // 实现提供；MemoryFS/OverlayFS 按扩展名推断兜底
  href?: string;                           // 仅 reference：外部资源地址（URL/构建产物/对象存储）
  annotations?: { description?: string; tags?: string[] };  // 宿主写给模型看的语义说明
}
```

**原生搜索接缝（可选，`searchFiles`/`searchContent`）**：不在七个必须方法之列——实现了 = 该底座能一次调用在内部完成整个搜索（典型如远端沙盒在沙盒里跑一条脚本，省掉逐文件网络往返），[内置 `grep`/`glob`](../builtin-tools/tech.md) 会优先调用；未实现该方法、或调用时抛 `SearchUnsupportedError`（`@nimbo/core` 导出），两个工具都静默回退现有 JS 逐文件扫描，行为不受影响。`MemoryFS`/`OverlayFS` 故意不实现——`OverlayFS` 罩着远端 base 时，base 的 native 搜索看不见 overlay 层的脏写，回退到走 `glob()`（会经过 overlay 合并视图）才是正确语义。适配器契约、查询/结果类型全量定义、逐家映射见 [host/sandbox/tech](../../host/sandbox/tech.md) §3/§4/§5.1；拆单见 [host/native-search/plan](../../host/native-search/plan.md)。

**元信息与引用条目的设计原则**：

- **被动流出，不加查询面**：mimeType/annotations 不新增工具，经既有工具自然到达模型——`list-dir` 行尾标注类型与 description、`read-file` 对二进制/reference 返回结构化指引（是什么类型、描述是什么、href 指向哪）而非裸错误。
- **reference 条目**（"扩展文件格式"）：路径 + mimeType + annotations + `href`，内容不在本地——MCP resources 语义折叠进 FS，复用 agent 既有导航（list-dir/glob）而不另建资源注册表。构建方式：`fromMemory({ "builds/app.apk": { ref: "https://ci.../123", mimeType, annotations } })`；可选注入 `resolveReference(entry)` 后 `read-file` 可直读解析内容（又一个可注入点，默认不解析）。
- **annotation 是提示不是绑定**：不做"文件类型 → handler"注册表——工具路由的另一半天然在工具描述里（宿主的 query_db 工具自己声明用于 .sqlite），一句自然语言描述对模型比映射表有效。
- v1 类型推断仅按扩展名；magic-bytes 嗅探、image/* 直读为 image block（依赖 provider 能力探测）列 v2。

- **`MemoryFS`** —— 纯内存路径树。`NimboFS.fromMemory(files: Record<string, string | Uint8Array>)`。
- **`OverlayFS`** —— 读穿透 + 写覆盖：`base`（只读层，通常是真实目录的 `DirFS` 只读视图）+ `overlay`（MemoryFS，承接所有写入与删除墓碑）。`NimboFS.fromDirectory(dir, { ignore })` 返回 OverlayFS——大项目零拷贝挂载，写永不落真实磁盘。
- 导出能力：`diff(): FileDiff[]`（`{ path, kind, before?, after?, patch }`）；`writeBack(targetDir?)`（唯一写真实磁盘的操作，只有宿主可达）；`snapshot()/restore()`（为 rewind 预留，`toJSON({ includeFs })`/`resume` 用它）。
- 路径规范：POSIX 风格虚拟绝对路径；`..` 越界在 FS 层直接拒绝（安全边界在 FS 不在工具）。
- **语义澄清（P2-1 施工时确定，随实现回填）**：
  - 工厂为独立导出函数 `fromMemory`/`fromDirectory`（非 `NimboFS.` 值命名空间——与 core 的 `NimboFS` 类型名冲突，跨包 interface+namespace 合并不成立）；门面呈现归 P7（`@nimbo/sdk` 落地了 `NimboFS.fromMemory`/`fromDirectory` 值命名空间）。
  - `glob()` 只匹配文件、不匹配目录（消费方——文件工具、diff、墓碑展开——要的都是文件清单）；结果按路径排序。
  - `MemoryFS.diff()` 恒以空 FS 为基线全报 `created`（MemoryFS 无持久 base，构造时快照的基线时机任意）；真三态（modified/deleted）语义在 `OverlayFS.diff()`。`FileDiff.kind` 取值 `created|modified|deleted`（宿主导出面），与 `data-file-change` 的 `add|update|delete`（§4.2 事件面）是两个刻意不同的表面。
  - **NimboFS 实现契约**：对不存在路径统一抛 `NotFoundError`（@nimbo/virtual-fs 导出）——OverlayFS 判断 base 层存在性依赖此约定；第三方 `NimboFS` 作 base 时需遵守或自行包一层归一化。
  - OverlayFS 递归删除只记目录墓碑，diff/writeBack 时经 `base.glob` 现场展开（rm 时展开会让墓碑集合随 base 内容失真）。
  - `DirFS` 的 `ignore` 为 glob 匹配路径本身或任一祖先目录（子树整体隐藏）；v1 非完整 gitignore 语义（如 `*.log` 仅匹配顶层，跨层用 `**/*.log`）。

### 4.5 工具运行时与审批链

- 内置工具共 11 个（其中 bash 条件激活），完整规格（schema、输出预算、read-before-write 强制、验收要点）见 **[builtin-tools](../builtin-tools/tech.md)**：`read-file`、`write-file`、`edit-file`、`delete-file`、`move-file`、`list-dir`、`glob`、`grep`、`load-skill`、`bash`、`update-plan`。要点：默认无 bash，故删除/移动必须是一等工具；session 维护 `readState` 强制先读后改；写类工具成功后由 ToolRuntime 派生 `data-file-change`/`data-plan-update` 部件。

**审批链两级 + 三值 + 阻塞前产出（`approval.ts` `evaluateApproval` / `runtime.ts` `resolveToolCallApproval` / `loop.ts` `settleToolCall`，P13-5-2c 重构）**：

- **求值顺序**：per-tool `approval` 策略先行——`"allow"` 直接放行、回调直接产出 `ApprovalOutcome`、`"review"`/`"review-once"` 触发升级 → 升级请求交给 session 级审批分类器 `onApproval`（同为 `ApprovalPolicy` 形态）裁决 → 两者都未配置默认放行。
- **拆两步以支持"先产出后阻塞"**：`resolveToolCallApproval`（第 1 步：`inputSchema.safeParse` 校验模型产生的可能畸形的 JSON → 审批链 → `allow`/`deny`/`review` 三值）与 `executeToolCall`（第 2 步：组装 `ToolContext` → `tool.execute()` → `outputSchema` 校验，只 `completed`/`failed`）分离；loop（async generator）在两步之间插入 "先 `yield tool-approval-request` chunk、再 `await onReview`" ——这个 yield 是一个真实挂起点，客户端在这一刻已能弹卡片，旧的原子 `executeToolCall` 做不到（挂起等人审期间直播流里没有待审批信号，人在回路实质失效）。
- **各分支**：`allow` → 直接执行 → `tool-output-available`/`-error`；`deny` → 不执行，直接 `tool-output-denied`（不经审批请求/响应 chunk）；`review` → yield 请求 chunk → `await onReview` 拿 `HumanDecision`，allow/deny 都 yield `tool-approval-response`，allow 才执行、deny 直接 `output-denied`。
- **无仲裁者即 deny**（附"配置 onReview 或调低该工具 approval"指导）：策略/分类器产出 `review`、而会话未注入 `onReview` 时归此分支——`review` 的把关意图不因宿主未接人审而被静默丢弃。**per-tool 未配置 → 直接 `allow`、不咨询会话**（`review` 的把关意图只在显式配置时才升级）。
- **能力收窄**：`ApprovalOutcome` 是裸字符串，策略/分类器回调返 `deny` 只得默认指导文案；自定义拒绝理由只能走 `review` + `HumanDecision.deny.message`。`review-once` 的[会话级授权](../../terms.md)按 toolName 键入、跨级共享一份（批准一次后本会话内该工具后续解析为 `allow`）；标记时机为"人工裁决 allow 之后"（`resolveToolCallApproval` 返回 `markOnceOnApprove: true`，由 loop 在人工 allow 后调 `onceMemory.markApproved`）。
- **派生数据接缝**：`file_change`/`plan_update` 的生产者是具体工具的 `execute()`，消费者是 loop。`Tool.execute()` 只有一个 `ToolReturn` 返回通道，`ToolContext` 字段被 spec 钉死——因此派生数据走**工具构造期注入的回调**（`createUpdatePlanTool({ onPlanUpdate })`、`createFileTools({ onFileChange })`），接到同一个 `DerivedDataCollector`；`runtime.ts` 在 `executeToolCall` 前后各 `drain()` 一次，把这次调用期间新增的记录归到这次结果。假设同一收集器不被并发工具调用共享（当前逐个顺序执行成立）。

#### 4.5a `NimboExec`：命令执行的接口倒置（与 NimboFS 同构）

命令执行**工具内置、环境注入**——与文件工具依赖 `NimboFS` 完全同构：

```ts
interface NimboExec {
  exec(req: { command: string; cwd?: string; timeoutMs?: number; signal: AbortSignal },
       opts?: { onOutput?: (chunk: { stream: "stdout" | "stderr"; data: string }) => void }
  ): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }>;
  describe?(): string;                  // 环境自描述（OS/网络/cwd 语义），拼进 bash 工具描述
  defaultApproval?: ApprovalPolicy;     // 实现自声明的审批默认值
}
```

- **激活**：`createSession(agent, { exec })` 注入才出现 bash 工具（同 load-skill 的条件内置机制）；不注入 = 无命令执行面，默认安全不变。
- **审批**：bash 的 approval 默认取实现的 `defaultApproval`——`localExec()` 出厂 `"review"`，沙盒实现通常声明 `"allow"`（隔离即边界）；注入点可覆盖。（未声明时 core 兜底 `"review"`——审批是安全机制，不对未知第三方实现做乐观假设。）
- **与 VirtualFS 的一致性**（"bash 能看到 agent 刚改的文件吗"）按三种模式解决，责任划分各不相同：
  - **模式 A · 同源工作区（推荐真沙盒）**：同一对象实现 `NimboFS & NimboExec`，`workspace` 选项一次注入。**一致性在此模式下是结构性的**——文件数据只有一份（在沙盒里），NimboFS 实现只是它的 API 视图，bash 是另一个访问口；不存在同步逻辑与竞态。[sandbox](../../host/sandbox/tech.md) 的 E2B/Vercel/Cloudflare 三家适配器即此形态。
  - **模式 B · `localExec({ materialize: true })`**：一致性由 **nimbo** 负责（执行前把 VirtualFS 物化到随机临时目录、执行后按 mtime 回收变更进 overlay）；明确标注是便利实现而非安全边界。
  - **模式 C · 完全解耦**：宿主注入独立 exec（如只读分析环境），自己保证语义——明知不一致而用之的逃生门。
- **模式 A 的三条衍生规则**（同源即意味着 bash 可旁路 nimbo 的文件工具）：
  1. bash 旁路造成的文件变更**不产生 `data-file-change` 部件**（nimbo 只从自己的文件工具派生事件；与 Claude Code/codex 行为一致）；
  2. readState 先读后改校验以 `stat().mtime`（或实现提供的 version）为判据——bash 改过的文件必须重读才能 `edit-file`；
  3. `diff()/writeBack()/snapshot()` 是 MemoryFS/OverlayFS 的附加能力而非 `NimboFS` 接口必需——内置文件工具不依赖它们，沙盒实现可选支持。
- **实现契约（P6-1 施工回填）**：`exec()` 的全部失败路径（解析错误/未知命令/超时/abort/命令级错误）应以 **resolve 的 `ExecResult`**（非零 `exitCode` + stderr）返回而非 reject——bash 工具把非零退出码当正常 tool 结果回填模型，reject 只应发生在实现自身完全不可用的场景。`@nimbo/mini-bash` 退出码取 POSIX/GNU 惯例：解析错误 2、未知命令 127、超时 124、abort 130；grep 无匹配 1 / 文件缺失 2（三态），其余命令文件缺失 1。mini-bash 的路径解析对 `..` 越界静默 clamp 到根（解释器语义，非安全边界——安全边界在 FS 层，§4.4）。
- **`localExec` 的 cwd 语义（P7-3 施工回填）**：**模式 C**（非 materialize）下是**真实主机路径**，直传 `spawn()`，缺省 `process.cwd()`；**模式 B**（`materialize: true`）下是**相对 fs 根的虚拟路径**，映射进物化临时目录，缺省即虚拟根 `/`。`materialize: true` 需要 `NimboFS` 引用，经构造参数 `localExec({ materialize: true, fs })` 注入（未传时构造期同步抛错）。
- 宿主也仍可无视这套机制，直接 `defineTool` 一个自己的命令工具——`NimboExec` 只是让最常见的需求零工具代码。

#### 4.5b `@nimbo/just-bash`：全语法档 bash（v1.1，基于 vercel-labs/just-bash）

mini-bash 的语法面（六命令 + 四操作符）撑不住 Claude 系模型高频产出的 `if/for/while/case` 脚本。升级方案不是扩写 mini-bash 解释器，而是新增可选包 **`@nimbo/just-bash`**：把 [just-bash](https://github.com/vercel-labs/just-bash)（Vercel Labs，Apache-2.0，纯 TS，专为 AI agent 场景设计）适配为 `NimboExec`——**分档并存**，mini-bash 保留为零依赖极简档。

```ts
import { justBash } from "@nimbo/just-bash";
createSession(agent, { fs, exec: justBash(fs, opts?) });   // 与 miniBash(fs) 一行换挡
```

**选型依据**（调研对照 `just-bash@3.1.0` 实际 d.ts）：完整控制流（if/elif/for 含 C 式/while/until/case/函数/local/变量与参数扩展/glob/重定向/管道/`&&`/`||`）；`defineCommand` 注册 JS 自定义命令；**`BashOptions.fs: IFileSystem` 可插拔**——接口形状与 NimboFS 高度同源；`executionLimits`（maxLoopIterations/maxCommandCount 等）防 agent 死循环；网络默认禁用；纯 TS（sql.js/quickjs 为 wasm 可选件，零原生二进制）。备选 bashkit（Rust+napi）与 bash-parser（九年未维护）均否决。

**适配器（NimboFS → IFileSystem）映射与降级策略**：

| IFileSystem 成员 | 适配 |
|---|---|
| readFile/readFileBuffer/writeFile/mkdir/readdir/rm/stat/exists | NimboFS 七方法直译（string 经 TextDecoder；FsStat.mtime = new Date(stat.mtime)） |
| appendFile / cp / mv | 组合原语（read+concat+write；read+write[+rm]） |
| resolvePath / realpath | 纯路径逻辑（复用 POSIX 规范化；无 symlink 故 realpath=normalize） |
| getAllPaths | `fs.glob("**")` + 从文件路径合成目录集合（NimboFS.glob 只报文件，§4.4） |
| chmod / utimes | **no-op 成功**（脚本常见惯用法，硬失败徒增纠错轮次） |
| symlink / link / readlink | **抛不支持**（与 v1 全线"无符号链接"立场一致）；lstat = stat，isSymbolicLink 恒 false |
| reference 条目 | stat 视为 file；readFile 让 `ReferenceNotResolvable` 自然浮出为命令错误文本 |

**NimboExec 表面**：`defaultApproval: "allow"`——重定向写面落在**同一个注入的 NimboFS**（与文件工具同沙盒，bash 旁路写的 readState mtime 防线即模式 A 三规则），网络默认关闭，无进程无真实磁盘；`describe()` 声明全语法能力、无 symlink、无网络、**输出非流式**（just-bash 无增量回调，onOutput 在结束时一次性回报）；`timeoutMs` 由适配器包一层 AbortController（超时 124 对齐既有契约；**取消保底**：just-bash 的协作式取消救不了永不 resolve 的 fs 调用，适配器沿 mini-bash 的 `raceAbort` 独立赛跑并自定退出码，P9-1 实测）；`req.cwd` → per-exec 覆盖，缺省沿实例 cwd——**cwd 持久语义由适配器闭包实现**（P9-1 实测修正原断言：just-bash 的 `Bash.exec()` 每次调用无状态，`cd` 只反映在该次 `result.env.PWD`；适配器以闭包 `instanceCwd` + 读回 `env.PWD` 复刻 mini-bash P6-4 同款语义）。执行限额默认收紧（maxCommandCount/maxLoopIterations 2000、maxOutputSize 1MB，较上游默认约收一个数量级）并暴露为 `justBash(fs, { limits })`。

**已知限制（P9-1 施工回填）**：`IFileSystem.getAllPaths()` 为**同步**签名而 `NimboFS.glob` 异步——适配器折中为"每次顶层 `exec()` 开始刷新一次同步缓存"：同一次 exec 内，脚本前面命令新写入的文件对后续 `**` 递归 glob 展开不可见（下次 exec 才可见）；单层 glob 走 readdir 不受影响。cp/mv 的目录递归经 `glob` 枚举，空子目录不参与复制（继承"glob 只报文件"，§4.4）。

**包关系**：`@nimbo/just-bash` 依赖 `@nimbo/core`（类型）+ `just-bash`（运行时）。**不进 `@nimbo/sdk` 依赖**——just-bash 依赖树含 wasm 大件（sql.js、quickjs-emscripten 等），强制打包违背门面轻量默认；需要全语法档的宿主显式 `pnpm add @nimbo/just-bash`。

### 4.6 Skills（SKILL.md 兼容 + 渐进式披露）

1. 组装 instructions 时注入 `<available_skills>` 段（每个 skill 一行 name+description）；
2. 内置 **`load-skill`** 工具（命名与 eve 一致）：调用返回该 skill 的 markdown 正文——"loading a skill adds instructions, never a new execution surface"；
3. packaged skill 的附属文件挂载到 VirtualFS 的 `/.skills/<name>/`（OverlayFS 只读层），agent 用普通文件工具读取；宿主工具用 `ctx.getSkill(name)` 的 handle 读取。
- 兼容性验收：Anthropic 官方 skills 与 eve 的 flat/packaged 两种形态均不改动即可加载。
- **语义澄清（P5-1 施工回填）**：
  - **挂载机制**：core 经 `NimboFS.writeFile` 接口把附属文件写入 `/.skills/<name>/`——"OverlayFS 只读层"语义归 P7 门面装配，core 不假设具体 FS 实现。挂载在 `createSession` 时同步发起、首次 `stream()/send()` 起始处 await 完成（工具执行前必已挂载，且 createSession 保持同步签名）。skills 均无 `files` 时完全不触碰 fs；fs 未注入且有 skill 带 `files` 时，首次 send/stream 以"注入 fs"指导性错误 reject。
  - **`ctx.getSkill` 数据源**是 skill 定义自带的 `files`（非 FS 挂载路径）——fs 未配置也能读；未知 skill/文件在 `.text()` await 时才 reject。
  - **flat 首行推导**按字面取首个非空、非代码围栏行（原样保留 `#` 等 markdown 语法，trim 后作为 description）；frontmatter 自实现，仅支持文件起始 `---` 块内的顶层 `key: value`（值可选引号），无嵌套/多行。
  - `load-skill` 由 skills 是否配置隐式控制（不经 `builtinTools` 裁剪）；宿主同名 `tools["load-skill"]` 可覆盖内置。

### 4.7 L3 · 目录约定层（可选，eve 布局兼容）

```ts
// @nimbo/core 的 ./load 子路径导出（sdk export * 自动透传）
function loadAgent(dir: string, opts?: { model?: LanguageModel }): Promise<AgentDefinition>;
function loadAgentFromFS(fs: NimboFS, dir: string, opts?): Promise<AgentDefinition>;  // nimbo 独有：定义本身也可以是虚拟的
```

约定（与 eve 对齐）：

| 路径 | 含义 | 说明 |
|---|---|---|
| `instructions.md` | instructions | 必需（或由 opts 提供） |
| `agent.ts` / `agent.json` | model 等运行配置 | `agent.ts` 默认导出 `defineAgent` 部分字段；动态 `import()` 加载 |
| `tools/*.ts` | 工具，文件名即工具名 | 默认导出 `defineTool(...)`；依赖 Node ≥ 22.18 原生 TS 或宿主构建产物 `.js` |
| `skills/*.md`、`skills/<name>/SKILL.md` | flat / packaged skill | — |

- `loadAgentFromFS` 不支持 `tools/*.ts`（虚拟 FS 里的代码不做动态求值——不引入任意代码执行面），只加载 instructions 与 skills；工具仍由宿主程序化传入。
- model 解析：`agent.ts` 里可写 `model: "anthropic/claude-sonnet-5"` 字符串——这正是 AI SDK 的 gateway 格式（也是 eve 的格式），原样透传；不想走 gateway 的宿主在 `loadAgent(dir, { model })` 里直接给 `LanguageModel` 实例覆盖。nimbo 不自建模型注册表。
- **语义澄清（P7-3 施工回填）**：`agent.ts`/`agent.json` 只读 **5 个标量运行配置字段**（model/builtinTools/maxTurnsPerRun/maxOutputTokens/maxContextTokens）——`tools`/`skills`/`instructions` 即使写在配置里也被忽略，**目录扫描是这三者的唯一事实来源**；`agent.json` 的 model 只能是字符串，`agent.ts` 可为实例。`loadAgentFromFS` 连 `agent.json` 都不读（运行配置永远来自 opts）。字段级 `as` 已改为类型守卫（`isZodSchemaLike`/`isToolLikeRecord`/`isLanguageModelInstance` 探针，P7-3R 返工，全仓迄今唯一 `as` 消除）。

### 4.8 Agent loop 细节

- 终止条件：`finishReason: "stop"`（无 tool call）、`maxTurnsPerRun` 触达（`max_turns`）、`signal` abort（`aborted`）、模型错误（单步重试交给 streamText 的 `maxRetries`，最终失败则 `provider_error`）——失败原因写进末条 assistant 消息 metadata 的 `status`（`failed`/`interrupted`）+ `error`。
- **abort 的生效点（[停止本轮](../../agent/turn-abort/tech.md)工单回填）**：`runTurn` 的 step 循环**开头**显式检查 `abortSignal.aborted`，命中即以 `interrupted`/`aborted` 优雅收尾——「绝不开始新的一步」是 nimbo 自己的确定性保证。一步*之内*的中止仍由 `abortSignal` 本身负责（模型流被掐断 / `ToolContext.abortSignal` 交给工具），两条路收尾形状一致。之所以需要这个显式检查：工具执行被中止时工具是**正常收尾**的（§4.5a「失败即 `ExecResult`」，不抛错），若只等 AI SDK 抛错，loop 会照常进入下一步、白打一次模型调用才停。
- 结构化输出：实际用 `generateText({ output: Output.object })`（`generateObject` 在 ai@7 已弃用）；"原生 vs 回退"收敛为单一机制——`Output.object` 的解析本身就是"JSON 解析 + zod 校验"，失败抛 `NoObjectGeneratedError` 触发修正重试（初次 + 重试 2 = 至多 3 次调用），无平行手写回退。抽取发生在 turn 成功收尾**之后**的独立一轮、不回写账本；耗尽预算 **throw `NimboStructuredOutputError`**（不新增失败 code——turn 本身成功，失败的只是附加的结构化折叠步骤）。
- 上下文管理 v1 显式上限：估算 token 超阈值即 `context_overflow`（用每步 usage 回填校准估算）；自动 compaction 列 v2（避免隐式行为，另见 [compaction](../../agent/compaction/tech.md)）。
- 会话恢复：`SessionState = { id, turn, messages: NimboUIMessage[], createdAt, fsSnapshot? }`——messages 是账本的 UIMessage 数组（本身即 JSON 可序列化），经 `validateSessionMessages`（ai 官方 `validateUIMessages`，天生异步）校验后恢复（P13-5：不再存 `ModelMessage[]`，模型上下文每步由官方 `convertToModelMessages` 现场推导，`nimbo_state_json` 取消）；FS 默认不内联，`toJSON({ includeFs: true })` 经 `fs.snapshot()` 可选内联（`resume` 时经结构探测调 `fs.restore()`）。
- **语义澄清（P4-2 施工回填）**：
  - 上下文上限字段定名 **`AgentDefinition.maxContextTokens?`**（opt-in，未配置完全跳过检查）；估算 = system+messages 的 JSON 字符数/4 起步，用每步 usage 回报的 `inputTokens` 校准乘法因子；检查点在**每次调用模型之前**（含第一步），超限不消耗模型调用。
  - **`max_turns` 语义**：`maxTurnsPerRun` 计数的"turn"是单次 `send()` 内的模型步数（step），非 session 的 turn 计数（两者是 spec 用词的两层复用）。预算内最后一步若以 tool-calls 收场，**先把该步工具正常执行完**（tool_call/file_change/plan_update 部件全部正常结算，不留悬空占位）再判 `max_turns`。
  - tool 结果回填用 `ToolResultOutput` 三变体映射状态：completed→`text`、failed→`error-text`、denied→`execution-denied`（语义精确传给模型）；字符串化规则 string 直传/对象 JSON.stringify，在回填层统一。
  - `InputBlock.image` 内部映射 UIMessage 的 `FileUIPart`（`url` 为 `data:` URL；`convertToModelMessages()` 再转回模型侧 `FilePart`）。
  - v1 已知取舍：`tool-input-delta` 阶段不驱动 `tool_call` 的部件事件（P3 丢弃了携带 toolName 的边界块，delta 阶段无合法 toolName 可填）——工具部件在终态 tool-call 就绪时发出；工具输入的真流式落地列为扩展点。`ctx.update()` 进度在工具执行结束后按序重放为 `data-tool-progress`（async generator 无法从回调内 yield），非严格实时交错。

## 5. 与现有生态的集成/复用点

- **API 形态对齐 eve**：`defineAgent/defineTool/defineSkill` 字段命名、目录布局、`load-skill`/`ctx.getSkill` 语义一致——eve 用户零心智迁移，eve 项目的 `agent/` 目录可被 `loadAgent` 直接消费（tools 除外，见 4.7）。
- item 级事件粒度对齐 codex-sdk，消费端迁移成本低（P13-5 后经 UIMessage 部件/chunk 承载）。
- SKILL.md 复用 Claude skills 生态资产。
- **模型层即 AI SDK 生态**：任何 `LanguageModel`（30+ provider 包、openai-compatible、gateway 字符串、社区 provider）开箱可用；宿主已有的 AI SDK 中间件（`wrapLanguageModel`、缓存、observability）对 nimbo 透明生效。
- zod ↔ JSON Schema 单向可转，为 v2 MCP 支持留桥。

## 6. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| AI SDK 大版本节奏快（v5→v6→v7 约一年三跳），breaking change 需跟进 | 中 | 锁定 `ai@^7`；只使用其最稳定的表面（`streamText` 手动 loop、`tool()`、`ModelMessage`——跨 v5–v7 基本未变）；升级作为独立 PR 走契约测试 |
| `ai` 成为 nimbo 的强依赖，宿主项目若锁定了不同大版本会有 peer 冲突 | 中 | `ai` 声明为 peerDependency（range `^7`）+ devDependency，跟随宿主版本 |
| L3 的 `tools/*.ts` 动态导入依赖 Node 版本/构建形态（TS 原生支持 ≥ 22.18） | 中 | 该层可选；文档写明版本矩阵；`.js` 产物永远可用 |
| exec 物化/回收语义边界情况（符号链接、大文件、并发） | 中 | 定位为参考实现；随机临时路径；v1 不支持符号链接 |
| 无 compaction 时长会话撞上下文墙 | 中 | v1 显式报错可预期；v2 做 compaction（[compaction](../../agent/compaction/tech.md)） |
| eve API 仍在演进，对齐目标漂移 | 低 | 对齐的是层次与命名习惯，不承诺 100% 兼容 eve 类型 |
| token 估算不精确 | 低 | 保守估算 + provider usage 回填校准 |
