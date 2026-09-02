# nimbo（中文）

> 英文版（根目录）见 [../README.md](../README.md)。

**可嵌入 Node.js 应用的轻量 agent SDK**：几行代码在自己的服务里跑起一个具备文件操作、命令执行、skills 能力的 agent loop——不 spawn 任何外部 CLI 二进制，运行时依赖只有 `ai`（Vercel AI SDK，peer）+ `zod`。

## 为什么需要它

现有方案的空缺（详见 [core-sdk 产品设计](./logic/engine/features/core-sdk.md)）：

- **CLI 封装类**（`@openai/codex-sdk`、`@anthropic-ai/claude-agent-sdk`）：本质是 spawn 平台二进制的进程包装——重、绑定单一厂商、**没有虚拟文件抽象**（agent 只能操作真实磁盘）、会话状态落在用户目录，服务端多租户场景难用。
- **纯 API client**（`@anthropic-ai/sdk`、`openai`）：只给 messages/tool-use 原语，loop、工具、文件、skills 全要自己搭。
- **eve**（API 设计优秀，nimbo 的 API 层次即参考它）：但它是带 HTTP server 与 durable workflow 的**框架**，不是可嵌入进程内的库；文件操作在真实沙盒。

**核心痛点**：想在普通 Node 服务里嵌入"能改文件、能执行任务"的 agent，要么被绑死在某家 CLI 上，要么从零手写 loop。

**nimbo 的答案** = eve 的 API 人体工学 + codex-sdk 的 item 级事件粒度 + AI SDK 的模型层（30+ provider 任选）+ 自有的 VirtualFS 内核与 loop，以可嵌入库的形态交付。关键差异化：**虚拟文件系统**——agent 的所有文件读写默认落在内存/overlay 层，全程不碰真实磁盘，天然多租户安全；结束后 `diff()` 导出、`writeBack()` 才落盘。

典型场景：SaaS 内嵌代码助手（改代码返回 diff，零临时文件）、CI/后台流水线节点（结构化输出接回流水线）、带领域能力的 agent 产品（SKILL.md 生态复用）、自定义执行环境（宿主沙盒经 `NimboExec` 接口注入，loop 零改动）。

## 5 行上手

```ts
import { defineAgent, createSession, NimboFS } from "@nimbo/sdk";
// 或直连 provider：import { anthropic } from "@ai-sdk/anthropic"; model: anthropic("claude-sonnet-5")

const agent = defineAgent({ model: "anthropic/claude-sonnet-5" }); // AI SDK Gateway 字符串或任意 LanguageModel 实例
const session = createSession(agent, {
  fs: NimboFS.fromDirectory("./project"),
});
const result = await session.send("把 src/index.ts 里的 var 全部改成 const");
console.log(result.finalResponse, await session.fs.diff());
```

`./project` 被零拷贝 overlay 挂载：读穿透磁盘、写落内存层——上面这段跑完，真实目录一个字节都没变，变更全在 `diff()` 里；要落盘调 `session.fs.writeBack()`。

```sh
pnpm add @nimbo/sdk ai
```

> TODO：npm 裸名 `nimbo` 的发布决策待定（[plans/core-sdk](./logic/engine/plans/core-sdk.md) P7-1 遗留）——目前一律 `@nimbo/sdk`，定了之后全部 README/examples 的 import 同步替换。

## 配置 agent：模型 / instructions / tools / skills

四样都挂在 `defineAgent` 上——定义是纯数据、无运行状态，同一份定义可以反复开 session。

**模型**。nimbo 的模型层完全构建在 Vercel AI SDK（`ai` 包）之上，不自建 provider 层、不自建模型注册表——「接入某个模型」就是拿到一个 AI SDK 的 `LanguageModel` 值，三条路：

```ts
// ① Gateway 字符串：零 provider 包，环境里配 AI_GATEWAY_API_KEY 即可
const agent = defineAgent({ model: "anthropic/claude-sonnet-5" });

// ② 官方 provider 包（30+，宿主按需安装，如 pnpm add @ai-sdk/anthropic）
import { anthropic } from "@ai-sdk/anthropic";
const agent = defineAgent({ model: anthropic("claude-sonnet-5") });

// ③ OpenAI 兼容端点：DeepSeek / Qwen / Ollama / vLLM 等自建或第三方服务
import { createDeepSeek } from "@ai-sdk/deepseek";
const deepseek = createDeepSeek({ baseURL, apiKey });
const agent = defineAgent({ model: deepseek("deepseek-chat") });
```

`ai` 是 peerDependency（`^7`）——宿主自装 `ai` 和所选 provider 包，版本跟宿主走。其余一切（loop、工具、审批、沙盒）对模型层透明：换模型只改这一个值（examples 的 `NIMBO_MODEL` 环境变量一行换模型即此机制）；宿主已有的 AI SDK 中间件（`wrapLanguageModel`、缓存、observability）包装后照常传入。

**instructions**。系统提示正文写在 `defineAgent({ instructions })`；多租户场景在 `createSession(agent, { instructions: { append } })` 追加租户专属内容，不动定义。

**tools** 分三层：

- **内置工具**（`builtinTools` 裁剪，缺省全开）：
  - 文件七件套（`read_file` / `write_file` / `edit_file` / `delete_file` / `move_file` / `list_dir` / `glob` / `grep`）
  - `update_plan`；
- **隐式激活的内置工具**：`bash` 随 exec 注入出现、`load_skill` 随 skills 配置出现——两者不经 `builtinTools` 控制；
- **宿主自定义工具**：`defineTool({ description, inputSchema, approval?, execute(input, ctx) })`——`ctx.fs` 就是 session 的文件面，自定义工具零额外接线即可操作注入的文件系统/工作区。

**skills**（SKILL.md，兼容 Claude/eve 生态）有四种来源：

```ts
defineSkill({ name, description, markdown, files? })      // 程序化定义
Skill.fromMarkdown(name, md)                              // flat markdown
Skill.fromDirectory("./skills/frontend-design")           // 本地 packaged 目录（SKILL.md + 附属文件）
await Skill.fromFS(fs, "/.agents/skills/frontend-design") // 从任意 NimboFS 装载——包括沙盒工作区
```

运行机制是渐进式披露：instructions 里只注入名字和描述清单，模型需要时调 `load_skill` 拿正文——只加指令，不加新的执行面。

## 架构：两块，七个模块

整套设计压成一句话：**凡是可替换的东西，语义在 [agent 逻辑层](./terms.md)、实现在[宿主层](./terms.md)。**

<svg viewBox="0 0 980 500" width="100%" role="img" aria-label="nimbo 架构分层图：构建者的接入代码调用 agent 逻辑层的归属仲裁、轮编排、执行引擎三个模块，三者按条件向下依赖宿主层的归属仲裁机制、持久化、流分发、沙盒四样可替换能力" style="max-width:980px;margin:0 auto;display:block;font-family:var(--vp-font-family-base)">
  <defs>
    <pattern id="a-grid" width="40" height="40" patternUnits="userSpaceOnUse">
      <path d="M 40 0 L 0 0 0 40" fill="none" stroke="var(--vp-c-divider)" stroke-width="0.5" opacity="0.55"/>
    </pattern>
    <marker id="a-head" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto">
      <path d="M0,0 L9,3.5 L0,7 z" fill="var(--vp-c-text-3)"/>
    </marker>
  </defs>

  <rect x="8" y="8" width="964" height="484" rx="12" fill="var(--vp-c-bg-alt)" stroke="var(--vp-c-divider)"/>
  <rect x="9" y="9" width="962" height="482" rx="11" fill="url(#a-grid)"/>

  <!-- 依赖线先画，后画的方块会盖住它们 -->
  <path d="M185,84 L185,144" fill="none" stroke="var(--vp-c-text-3)" stroke-width="1.5" marker-end="url(#a-head)"/>
  <path d="M310,187 L358,187" fill="none" stroke="var(--vp-c-text-3)" stroke-width="1.5" marker-end="url(#a-head)"/>
  <path d="M614,187 L662,187" fill="none" stroke="var(--vp-c-text-3)" stroke-width="1.5" marker-end="url(#a-head)"/>

  <g stroke="var(--vp-c-text-3)" stroke-width="1.3" stroke-dasharray="5,4" fill="none" marker-end="url(#a-head)" opacity="0.85">
    <path d="M185,224 L158,340"/>
    <path d="M450,224 L380,340"/>
    <path d="M500,224 L600,340"/>
    <path d="M540,224 L770,340"/>
    <path d="M800,224 L855,340"/>
  </g>

  <!-- agent 逻辑层 -->
  <rect x="36" y="100" width="908" height="152" rx="12" fill="none" stroke="var(--vp-c-divider)" stroke-width="1.5"/>
  <text x="52" y="122" fill="var(--vp-c-text-1)" font-size="18" font-weight="700">agent 逻辑层</text>
  <text x="52" y="139" fill="var(--vp-c-text-3)" font-size="14">不可替换</text>

  <rect x="60" y="150" width="250" height="74" rx="6" fill="var(--vp-c-bg)"/>
  <rect x="60" y="150" width="250" height="74" rx="6" fill="rgba(251,113,133,0.13)" stroke="#fb7185" stroke-width="1.5"/>
  <text x="185" y="177" fill="var(--vp-c-text-1)" font-size="19" font-weight="700" text-anchor="middle">归属仲裁</text>
  <text x="185" y="196" fill="var(--vp-c-text-2)" font-size="14" text-anchor="middle">授予 · 回收 · 执法</text>
  <text x="185" y="213" fill="#fb7185" font-size="13" text-anchor="middle">保证：独占</text>

  <rect x="364" y="150" width="250" height="74" rx="6" fill="var(--vp-c-bg)"/>
  <rect x="364" y="150" width="250" height="74" rx="6" fill="rgba(52,211,153,0.13)" stroke="#34d399" stroke-width="1.5"/>
  <text x="489" y="177" fill="var(--vp-c-text-1)" font-size="19" font-weight="700" text-anchor="middle">轮编排</text>
  <text x="489" y="196" fill="var(--vp-c-text-2)" font-size="14" text-anchor="middle">起 · 中断 · 挂起 · 恢复 · 收尾</text>
  <text x="489" y="213" fill="#34d399" font-size="13" text-anchor="middle">保证：连续</text>

  <rect x="668" y="150" width="250" height="74" rx="6" fill="var(--vp-c-bg)"/>
  <rect x="668" y="150" width="250" height="74" rx="6" fill="rgba(34,211,238,0.13)" stroke="#22d3ee" stroke-width="1.5"/>
  <text x="793" y="177" fill="var(--vp-c-text-1)" font-size="19" font-weight="700" text-anchor="middle">执行引擎</text>
  <text x="793" y="196" fill="var(--vp-c-text-2)" font-size="14" text-anchor="middle">调模型 → 跑工具 → 喂回去</text>
  <text x="793" y="213" fill="#22d3ee" font-size="13" text-anchor="middle">保证：推进</text>

  <!-- 接入代码（框架之上，构建者写） -->
  <rect x="60" y="26" width="250" height="58" rx="6" fill="var(--vp-c-bg)"/>
  <rect x="60" y="26" width="250" height="58" rx="6" fill="rgba(148,163,184,0.14)" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="6,4"/>
  <text x="185" y="50" fill="var(--vp-c-text-1)" font-size="18" font-weight="700" text-anchor="middle">构建者的接入代码</text>
  <text x="185" y="69" fill="var(--vp-c-text-2)" font-size="14" text-anchor="middle">路由 · SSE · 前端 · 审批端点</text>
  <rect x="192" y="104" width="34" height="16" rx="3" fill="var(--vp-c-bg-alt)"/>
  <text x="209" y="116" fill="var(--vp-c-text-2)" font-size="14" text-anchor="middle">调用</text>

  <!-- 宿主层 -->
  <rect x="36" y="296" width="908" height="146" rx="12" fill="none" stroke="var(--vp-c-divider)" stroke-width="1.5" stroke-dasharray="8,5"/>
  <text x="52" y="318" fill="var(--vp-c-text-1)" font-size="18" font-weight="700">宿主层</text>
  <text x="52" y="335" fill="var(--vp-c-text-3)" font-size="14">可替换</text>

  <rect x="60" y="340" width="197" height="74" rx="6" fill="var(--vp-c-bg)"/>
  <rect x="60" y="340" width="197" height="74" rx="6" fill="rgba(251,113,133,0.13)" stroke="#fb7185" stroke-width="1.5"/>
  <text x="158" y="371" fill="var(--vp-c-text-1)" font-size="18" font-weight="700" text-anchor="middle">归属仲裁机制</text>
  <text x="158" y="391" fill="var(--vp-c-text-2)" font-size="13" text-anchor="middle">内存 · 租约 · 平台自带</text>

  <rect x="281" y="340" width="197" height="74" rx="6" fill="var(--vp-c-bg)"/>
  <rect x="281" y="340" width="197" height="74" rx="6" fill="rgba(167,139,250,0.13)" stroke="#a78bfa" stroke-width="1.5"/>
  <text x="379" y="371" fill="var(--vp-c-text-1)" font-size="18" font-weight="700" text-anchor="middle">持久化</text>
  <text x="379" y="391" fill="var(--vp-c-text-2)" font-size="13" text-anchor="middle">SQLite · Postgres · DO</text>

  <rect x="502" y="340" width="197" height="74" rx="6" fill="var(--vp-c-bg)"/>
  <rect x="502" y="340" width="197" height="74" rx="6" fill="rgba(251,146,60,0.13)" stroke="#fb923c" stroke-width="1.5"/>
  <text x="600" y="371" fill="var(--vp-c-text-1)" font-size="18" font-weight="700" text-anchor="middle">流分发</text>
  <text x="600" y="391" fill="var(--vp-c-text-2)" font-size="13" text-anchor="middle">EventEmitter · Redis</text>

  <rect x="723" y="340" width="197" height="74" rx="6" fill="var(--vp-c-bg)"/>
  <rect x="723" y="340" width="197" height="74" rx="6" fill="rgba(251,191,36,0.13)" stroke="#fbbf24" stroke-width="1.5"/>
  <text x="821" y="371" fill="var(--vp-c-text-1)" font-size="18" font-weight="700" text-anchor="middle">沙盒</text>
  <text x="821" y="391" fill="var(--vp-c-text-2)" font-size="13" text-anchor="middle">本机 · E2B · 云沙盒</text>

  <!-- 条件标注（带底色，盖住穿过的虚线） -->
  <g font-size="14" text-anchor="middle">
    <rect x="85" y="266" width="134" height="21" rx="4" fill="var(--vp-c-bg-alt)"/>
    <text x="152" y="281" fill="var(--vp-c-text-2)">多进程 / 多节点时</text>
    <rect x="353" y="256" width="110" height="21" rx="4" fill="var(--vp-c-bg-alt)"/>
    <text x="408" y="271" fill="var(--vp-c-text-2)">要跨重启留住时</text>
    <rect x="530" y="298" width="68" height="21" rx="4" fill="var(--vp-c-bg-alt)"/>
    <text x="564" y="313" fill="var(--vp-c-text-2)">跨实例时</text>
    <rect x="588" y="244" width="82" height="21" rx="4" fill="var(--vp-c-bg-alt)"/>
    <text x="629" y="259" fill="var(--vp-c-text-2)">管生命周期</text>
    <rect x="790" y="282" width="68" height="21" rx="4" fill="var(--vp-c-bg-alt)"/>
    <text x="824" y="297" fill="var(--vp-c-text-2)">要动手时</text>
  </g>

  <!-- 图例 -->
  <g font-size="14" fill="var(--vp-c-text-3)">
    <path d="M60,464 L96,464" stroke="var(--vp-c-text-3)" stroke-width="1.5" marker-end="url(#a-head)"/>
    <text x="106" y="468">固定依赖</text>
    <path d="M180,464 L216,464" stroke="var(--vp-c-text-3)" stroke-width="1.3" stroke-dasharray="5,4" marker-end="url(#a-head)"/>
    <text x="226" y="468">有条件的依赖 —— 条件不满足时用内置的平凡实现，一个外部件都不用装</text>
  </g>
</svg>

**虚线是有条件的依赖**——宿主层四样**都有内置的平凡实现**，所以零配置就能跑；**换部署形态，就是换掉其中一两个**。完整推导见 [agent 内核包](./architecture/features/agent-kernel.md) · [技术方案](./architecture/tech/agent-kernel.md)（设计讨论见 [issue #2](https://github.com/ludafa/nimbo/issues/2)）。

## 包结构（pnpm monorepo，依赖单向）

**已发布 8 个**，另有 **7 个已定案待建**（`@nimbo/agent` 及其配套）。下图是已发布的部分：

<svg viewBox="0 0 980 560" width="100%" role="img" aria-label="nimbo 已发布 8 个包的依赖图：@nimbo/sdk 打包 core、virtual-fs、mini-bash；just-bash 与三个云沙盒适配器需单独安装；全部依赖指向 @nimbo/core" style="max-width:980px;margin:0 auto;display:block;font-family:var(--vp-font-family-base)">
  <defs>
    <pattern id="p-grid" width="40" height="40" patternUnits="userSpaceOnUse">
      <path d="M 40 0 L 0 0 0 40" fill="none" stroke="var(--vp-c-divider)" stroke-width="0.5" opacity="0.55"/>
    </pattern>
    <marker id="p-head" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto">
      <path d="M0,0 L9,3.5 L0,7 z" fill="var(--vp-c-text-3)"/>
    </marker>
  </defs>

  <rect x="8" y="8" width="964" height="544" rx="12" fill="var(--vp-c-bg-alt)" stroke="var(--vp-c-divider)"/>
  <rect x="9" y="9" width="962" height="542" rx="11" fill="url(#p-grid)"/>

  <!-- 依赖箭头先画，方块后画盖住 -->
  <g stroke="var(--vp-c-text-3)" stroke-width="1.4" fill="none" marker-end="url(#p-head)">
    <path d="M430,140 L372,158"/>
    <path d="M550,140 L602,158"/>
    <path d="M490,140 L490,266"/>
    <path d="M368,216 L418,266"/>
    <path d="M606,216 L562,266"/>
    <path d="M158,436 L398,346"/>
    <path d="M379,436 L448,346"/>
    <path d="M600,436 L532,346"/>
    <path d="M821,436 L582,346"/>
  </g>

  <!-- 随 sdk 一起装 -->
  <rect x="250" y="24" width="480" height="208" rx="12" fill="none" stroke="#34d399" stroke-width="1.5" opacity="0.55"/>
  <text x="270" y="48" fill="var(--vp-c-text-1)" font-size="18" font-weight="700">随 @nimbo/sdk 一起装</text>
  <text x="270" y="65" fill="var(--vp-c-text-3)" font-size="14">5 行上手只装它一个</text>

  <rect x="346" y="78" width="288" height="62" rx="6" fill="var(--vp-c-bg)"/>
  <rect x="346" y="78" width="288" height="62" rx="6" fill="rgba(52,211,153,0.15)" stroke="#34d399" stroke-width="1.8"/>
  <text x="490" y="104" fill="var(--vp-c-text-1)" font-size="19" font-weight="700" text-anchor="middle" font-family="var(--vp-font-family-mono)">@nimbo/sdk</text>
  <text x="490" y="124" fill="var(--vp-c-text-2)" font-size="14" text-anchor="middle">门面 · batteries-included</text>

  <rect x="270" y="164" width="196" height="52" rx="6" fill="var(--vp-c-bg)"/>
  <rect x="270" y="164" width="196" height="52" rx="6" fill="rgba(52,211,153,0.12)" stroke="#34d399" stroke-width="1.5"/>
  <text x="368" y="187" fill="var(--vp-c-text-1)" font-size="16" font-weight="600" text-anchor="middle" font-family="var(--vp-font-family-mono)">virtual-fs</text>
  <text x="368" y="204" fill="var(--vp-c-text-2)" font-size="13" text-anchor="middle">Memory · Overlay · Dir</text>

  <rect x="508" y="164" width="196" height="52" rx="6" fill="var(--vp-c-bg)"/>
  <rect x="508" y="164" width="196" height="52" rx="6" fill="rgba(52,211,153,0.12)" stroke="#34d399" stroke-width="1.5"/>
  <text x="606" y="187" fill="var(--vp-c-text-1)" font-size="16" font-weight="600" text-anchor="middle" font-family="var(--vp-font-family-mono)">mini-bash</text>
  <text x="606" y="204" fill="var(--vp-c-text-2)" font-size="13" text-anchor="middle">零依赖极简档</text>

  <!-- core：依赖的根 -->
  <rect x="370" y="266" width="240" height="68" rx="8" fill="var(--vp-c-bg)"/>
  <rect x="370" y="266" width="240" height="68" rx="8" fill="rgba(34,211,238,0.16)" stroke="#22d3ee" stroke-width="2.2"/>
  <text x="490" y="294" fill="var(--vp-c-text-1)" font-size="21" font-weight="700" text-anchor="middle" font-family="var(--vp-font-family-mono)">@nimbo/core</text>
  <text x="490" y="314" fill="var(--vp-c-text-2)" font-size="14" text-anchor="middle">执行引擎 · 内置工具 · skills</text>
  <rect x="624" y="288" width="72" height="20" rx="10" fill="rgba(34,211,238,0.16)" stroke="#22d3ee" stroke-width="1"/>
  <text x="660" y="302" fill="#22d3ee" font-size="14" text-anchor="middle" font-weight="700">依赖的根</text>

  <!-- 单独安装 -->
  <rect x="36" y="386" width="908" height="146" rx="12" fill="none" stroke="#fbbf24" stroke-width="1.5" stroke-dasharray="8,5" opacity="0.65"/>

  <rect x="60" y="436" width="197" height="68" rx="6" fill="var(--vp-c-bg)"/>
  <rect x="60" y="436" width="197" height="68" rx="6" fill="rgba(251,191,36,0.13)" stroke="#fbbf24" stroke-width="1.5"/>
  <text x="158" y="464" fill="var(--vp-c-text-1)" font-size="16" font-weight="600" text-anchor="middle" font-family="var(--vp-font-family-mono)">just-bash</text>
  <text x="158" y="483" fill="var(--vp-c-text-2)" font-size="13" text-anchor="middle">全语法档 bash</text>

  <rect x="281" y="436" width="197" height="68" rx="6" fill="var(--vp-c-bg)"/>
  <rect x="281" y="436" width="197" height="68" rx="6" fill="rgba(251,191,36,0.13)" stroke="#fbbf24" stroke-width="1.5"/>
  <text x="379" y="464" fill="var(--vp-c-text-1)" font-size="16" font-weight="600" text-anchor="middle" font-family="var(--vp-font-family-mono)">sandbox-e2b</text>
  <text x="379" y="483" fill="var(--vp-c-text-2)" font-size="13" text-anchor="middle">E2B 云沙盒</text>

  <rect x="502" y="436" width="197" height="68" rx="6" fill="var(--vp-c-bg)"/>
  <rect x="502" y="436" width="197" height="68" rx="6" fill="rgba(251,191,36,0.13)" stroke="#fbbf24" stroke-width="1.5"/>
  <text x="600" y="464" fill="var(--vp-c-text-1)" font-size="16" font-weight="600" text-anchor="middle" font-family="var(--vp-font-family-mono)">sandbox-vercel</text>
  <text x="600" y="483" fill="var(--vp-c-text-2)" font-size="13" text-anchor="middle">Vercel Sandbox</text>

  <rect x="723" y="436" width="197" height="68" rx="6" fill="var(--vp-c-bg)"/>
  <rect x="723" y="436" width="197" height="68" rx="6" fill="rgba(251,191,36,0.13)" stroke="#fbbf24" stroke-width="1.5"/>
  <text x="821" y="464" fill="var(--vp-c-text-1)" font-size="16" font-weight="600" text-anchor="middle" font-family="var(--vp-font-family-mono)">sandbox-cloudflare</text>
  <text x="821" y="483" fill="var(--vp-c-text-2)" font-size="13" text-anchor="middle">网关形态</text>

  <text x="490" y="522" fill="var(--vp-c-text-3)" font-size="14" text-anchor="middle">下排均为 @nimbo/* 包 —— 只依赖 core，不随 sdk 装入，需要时显式 <tspan font-family="var(--vp-font-family-mono)">pnpm add</tspan></text>
</svg>

箭头表示「依赖」。`@nimbo/sdk` 打包 `core` + `virtual-fs` + `mini-bash`；`just-bash`
与三个沙盒适配器只依赖 `core`、需单独安装。每个包的细节见下方表格。

### 按模块看：哪个包管哪一块

| 层 / 模块 | 包 | 状态 |
| --- | --- | --- |
| 逻辑层 · **执行引擎** | `@nimbo/core` | ✅ 已有 |
| 逻辑层 · **轮编排 + 归属仲裁** | `@nimbo/agent`（四种宿主能力的**接口** + 语义实现 + **全套内置实现**） | ✅ 已有（[挂起与恢复](./logic/orchestration/plans/agent-runtime.md)未做） |
| 宿主层 · **沙盒**（文件） | `@nimbo/virtual-fs` | ✅ 已有 |
| 宿主层 · **沙盒**（命令） | `@nimbo/mini-bash` · `@nimbo/just-bash` | ✅ 已有 |
| 宿主层 · **沙盒**（远端） | `@nimbo/sandbox-e2b` · `-vercel` · `-cloudflare` | ✅ 已有 |
| 宿主层 · **持久化 + 归属仲裁机制** | `@nimbo/persist-kysely`（核心，方言是参数）· `-sqlite` · `-postgres` · `-mysql`（三个薄壳）· `-mongo` | ✅ 已有 |
| 契约自证 | `@nimbo/conformance`（一致性套件，验一个实现合不合契约） | ✅ 已有 |
| 宿主层 · **流分发** | `@nimbo/stream-redis`（Redis Streams） | 🚧 待建 |
| Cloudflare DO **全套** | `@nimbo/durable-object`（持久化 + 平凡仲裁 + 实例内流分发） | 🚧 待建 |
| 门面 | `@nimbo/sdk` | ✅ 已有 |
| 开箱应用 | `@nimbo/cli`（**不是框架包，是拿框架搭的成品**） | 🚧 待建 |

**打包原则：接口按模块分；实现按「一次装什么」打包。** 持久化和租约版仲裁总是一起用（共享连接与 CRUD + CAS 原语）→ 同包；流分发跟存储无关 → 独立成包；DO 上三样全是平台自带 → 独立且一次给全。

**`@nimbo/sdk` 和 `@nimbo/agent` 是不同抽象层次的两个入口，并存不冲突**：只要一个 agent loop（会话怎么管我自己来）装 `sdk`；要完整的会话生命周期（起轮、挂起、恢复、归属）装 `agent` + 按场景挑实现包。

| 包                          | 一句话                                                                                                                                                | README                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `@nimbo/sdk`                | 主包门面，5 行上手只装它                                                                                                                              | [packages/sdk](../packages/sdk/README.md)                               |
| `@nimbo/core`               | L0 接口 / L1 定义层 / L2 运行层 / L3 目录约定层 / 内置工具本体                                                                                        | [packages/core](../packages/core/README.md)                             |
| `@nimbo/agent`              | 轮编排运行时：一轮接一轮地跑下去（起 / 停 / 收尾、待发队列与插话、人在回路、崩溃恢复），外加四种宿主能力的接口与内置实现                              | [packages/agent](../packages/agent/README.md)                           |
| `@nimbo/virtual-fs`         | MemoryFS / OverlayFS / DirFS、diff / writeBack、文件工具八件套                                                                                        | [packages/virtual-fs](../packages/virtual-fs/README.md)                 |
| `@nimbo/mini-bash`          | 跑在任意 NimboFS 上的只读命令解释器（bash 工具的纯内存执行环境，零依赖极简档，随 sdk 装入）                                                           | [packages/mini-bash](../packages/mini-bash/README.md)                   |
| `@nimbo/just-bash`          | 跑在任意 NimboFS 上的全语法档 bash（`if`/`for`/`while`/`case`/函数，vercel-labs/just-bash 适配器，**不随 sdk 装入**，需单独 `pnpm add`）              | [packages/just-bash](../packages/just-bash/README.md)                   |
| `@nimbo/sandbox-e2b`        | NimboFS & NimboExec 适配 E2B 云沙盒（真实 Firecracker microVM，BYO 实例，e2b 仅类型依赖，**不随 sdk 装入**）                                          | [packages/sandbox-e2b](../packages/sandbox-e2b/README.md)               |
| `@nimbo/sandbox-vercel`     | NimboFS & NimboExec 适配 Vercel Sandbox（真实 Amazon Linux 2023 Firecracker microVM，BYO 实例，`@vercel/sandbox` 仅类型依赖，**不随 sdk 装入**）      | [packages/sandbox-vercel](../packages/sandbox-vercel/README.md)         |
| `@nimbo/sandbox-cloudflare` | NimboFS & NimboExec 适配 Cloudflare Sandbox（网关形态：`.` 纯 fetch 客户端跑在任意 Node，`./worker` 网关部署在宿主 wrangler 项目，**不随 sdk 装入**） | [packages/sandbox-cloudflare](../packages/sandbox-cloudflare/README.md) |
| `@nimbo/persist-kysely`     | 持久化 + 租约版归属仲裁的核心实现，吃一个 Kysely 实例；三方言差异收敛在一处                                                                            | [packages/persist-kysely](../packages/persist-kysely/README.md)         |
| `@nimbo/persist-sqlite`     | 薄壳：吃 better-sqlite3 实例 → Kysely → 核心                                                                                                          | [packages/persist-sqlite](../packages/persist-sqlite/README.md)         |
| `@nimbo/persist-postgres`   | 薄壳：吃 `pg.Pool`                                                                                                                                    | [packages/persist-postgres](../packages/persist-postgres/README.md)     |
| `@nimbo/persist-mysql`      | 薄壳：吃 mysql2 连接池                                                                                                                                | [packages/persist-mysql](../packages/persist-mysql/README.md)           |
| `@nimbo/persist-mongo`      | MongoDB 直接实现三个领域接口（不走 Kysely——那是 SQL 的东西）                                                                                          | [packages/persist-mongo](../packages/persist-mongo/README.md)           |
| `@nimbo/conformance`        | 契约一致性套件：写了自己的持久化 / 归属仲裁实现，拿它验合不合契约（**不依赖任何测试框架**）                                                            | [packages/conformance](../packages/conformance/README.md)               |

**bash 分档说明**：`bash` 工具的命令执行环境（`NimboExec`）分两档，按需二选一注入，一行代码互换、loop/session 代码零改动（[tech/core-sdk §4.5b](./logic/engine/tech/core-sdk.md)）——

- **`@nimbo/mini-bash`（零依赖极简档）**：六个只读命令（`cat`/`grep`/`find`/`tail`/`head`/`echo`）+ 四个控制操作符，随 `@nimbo/sdk` 一起装，无需额外安装，定位安全默认与测试/演示载体。
- **`@nimbo/just-bash`（全语法档）**：Claude 系模型高频产出的 `if`/`for`/`while`/`case`/函数等控制流脚本超出 mini-bash 语法面时换这一档。因依赖树含 sql.js / quickjs-emscripten 等 wasm 大件，**不进 `@nimbo/sdk` 依赖**，需要的宿主显式 `pnpm add @nimbo/just-bash`。

两档都是 `NimboExec` 接口的实现，也都不是唯一选项——真实本机命令执行用 `@nimbo/core` 的 `localExec`，宿主自有沙盒（Docker/e2b/远程执行器）直接实现 `NimboExec` 注入即可（示例见 [examples/05-custom-exec.ts](../examples/src/05-custom-exec.ts)）。

## 云沙盒适配器

三个适配器把 agent 的 fs/bash 放进真实云沙盒里，而 agent 本身跑在任意 Node 机器上——同一种「模式 A 同源工作区」形态（一个对象实现 `NimboFS & NimboExec`，经 `workspace` 注入）。调研与设计决策见 [沙盒功能](./host/contract/features/sandbox.md) / [技术方案](./host/contract/tech/sandbox.md) / [施工进展](./host/contract/plans/sandbox.md)；E2B 和 Vercel 已对真实沙盒验证，Cloudflare 走自部署网关。

## 示例应用：chat agent 网页应用

[`apps/`](../apps) 下是一个**基于** nimbo 构建的完整 chat agent 网页应用——SDK 的一个产品形态的具体演示。用户在 chat 界面里驱动 agent 在 Vercel 沙盒里修改真实仓库、开 PR、触发 Vercel 部署。亮点：会话级沙盒生命周期（活跃时保持、空闲快照休眠、下一条消息带分支代码恢复）、loop 每个事件断线可续地 SSE 流式推给前端（刷新/HMR 不断）、完整对话 SQLite 持久化、streamdown markdown 渲染、每轮 token 统计（含缓存命中）。设计见 [chat webapp 功能](./ingress/features/chat-webapp.md) / [技术方案](./ingress/tech/chat-webapp.md) / [施工进展](./ingress/plans/chat-webapp.md)。

```sh
cp .env.template .env         # 填入必需的 key（见模板注释）
pnpm install
pnpm chat:bootstrap           # db migrate + openapi + api client 生成
pnpm chat:server              # API 服务
pnpm chat:web                 # web 开发服务器
```

## 更多

- **可运行示例**：[examples/](../examples/README.md)——内存 diff、目录挂载、skills、mini-bash、自定义 exec 注入、结构化输出、流式消费、全语法档 just-bash、E2B/Vercel/Cloudflare 三个云沙盒工作区适配、真实项目端到端设计优化 + Git 工作流，十二个脚本均可无 API key/云凭证试跑（缺 env/凭证只跑确定性段并干净退出；最后一个脚本的真机段一旦配齐凭证会真实修改目标 GitHub 仓库，运行前见其文件头/examples/README 的须知）。
- **设计文档**：见下面「设计文档索引」。
- **术语表**：[terms.md](./terms.md)（写文档/讨论/代码注释引用术语一律以此为准）
- **开发**：`corepack pnpm install && corepack pnpm build && corepack pnpm typecheck && corepack pnpm test`（顺序 build 先行——workspace 循环 devDep 下跨包类型解析指向 dist）。Node ≥ 20（examples 与 L3 `tools/*.ts` 动态加载需 ≥ 22.18 原生 TS）。根 build/typecheck/test 脚本只作用于 `./packages/*`；apps 有自己的 `chat:*` 脚本。

## 设计文档索引

路径形状是 **`docs/<分层>/<视角>/<feature>.md`**——先按架构分层切目录，每个目录里边再分三个视角：`features/`（产品/使用手册）· `tech/`（技术方案）· `plans/`（施工进展）。同一个功能的三份文档并排放在同一个目录下，文件名相同。

框架本身只有两块——**agent 逻辑层**按三个子层切，**宿主层**按宿主环境切：

```
docs/
├─ terms.md · overview.md      词典与索引，留在根
├─ architecture/{features,tech,plans}/   架构总纲
├─ logic/                                agent 逻辑层（固定，不可替换）
│  ├─ arbitration/…                        归属仲裁——语义 + 三种随宿主变化的实现
│  ├─ orchestration/…                      轮编排（@nimbo/agent）
│  └─ engine/…                             执行引擎（@nimbo/core）
├─ host/                                 宿主层（可替换）
│  ├─ contract/…                           跨环境的接口契约：沙盒 · 持久化 · 流分发
│  ├─ node/…                               Node 长驻：单进程 / cluster / Docker / k8s
│  ├─ cloudflare/…                         Worker + Durable Object
│  ├─ vercel/…                             Functions + Sandbox
│  └─ e2b/…                                E2B 沙盒
├─ ingress/…                             接入层（构建者写的应用代码）
└─ misc/…                                周边（示例集、验证、文档站）
```

每份文档开头都有 front matter，标着它的 `layer` / `module` / `packages` / `tags`——想按层或按包捞文档，直接 grep 字段即可：

```sh
grep -rl 'module: 轮编排' docs/     # 轮编排相关的全部文档
grep -rl '@nimbo/agent' docs/       # 某个包相关的全部文档
ls docs/logic/orchestration/*/            # 轮编排的三视角文档一把捞全
```

### 先读这一份

**[agent-kernel（agent 内核包 `@nimbo/agent`）](./architecture/features/agent-kernel.md)** — [功能](./architecture/features/agent-kernel.md) · [技术](./architecture/tech/agent-kernel.md) · [施工](./architecture/plans/agent-kernel.md)

架构总纲：分层、四种可替换的宿主能力、六档部署形态、包怎么拆。**下面所有文档的归位都由它定义。** 设计讨论的完整记录（含被推翻的路线）见 [issue #2](https://github.com/ludafa/nimbo/issues/2)。

### agent 逻辑层 · 执行引擎（`@nimbo/core`）

> 给定历史和工具，调模型 → 跑工具 → 喂回去，直到模型说完。目录：`docs/logic/engine/`

| 功能 | 三视角 |
| --- | --- |
| **core-sdk**（核心 SDK） | [功能](./logic/engine/features/core-sdk.md) · [技术](./logic/engine/tech/core-sdk.md) · [施工](./logic/engine/plans/core-sdk.md) |
| **builtin-tools**（内置工具） | [功能](./logic/engine/features/builtin-tools.md) · [技术](./logic/engine/tech/builtin-tools.md) |
| **compaction**（上下文压缩） | [功能](./logic/engine/features/compaction.md) · [技术](./logic/engine/tech/compaction.md) · [施工](./logic/engine/plans/compaction.md) |
| **approval-grant-split**（分段授权） | [功能](./logic/engine/features/approval-grant-split.md) · [技术](./logic/engine/tech/approval-grant-split.md) · [施工](./logic/engine/plans/approval-grant-split.md) |
| **web-search**（联网搜索） | [功能](./logic/engine/features/web-search.md) · [技术](./logic/engine/tech/web-search.md) · [施工](./logic/engine/plans/web-search.md) |
| **native-search**（原生搜索快路径） | [施工](./logic/engine/plans/native-search.md)（仅施工视角） |

### agent 逻辑层 · 轮编排（`@nimbo/agent`）

> 一轮的一生：起、中断、挂起、恢复、收尾、状态推导；定义账本/裁决/待发队列的模型；管沙盒生命周期。目录：`docs/logic/orchestration/`

| 功能 | 三视角 |
| --- | --- |
| **single-ledger**（UIMessage 单账本） | [功能](./logic/orchestration/features/single-ledger.md) · [技术](./logic/orchestration/tech/single-ledger.md) · [施工](./logic/orchestration/plans/single-ledger.md) |
| **agent-runtime**（轮编排运行时 `@nimbo/agent`） | [功能](./logic/orchestration/features/agent-runtime.md) · [技术](./logic/orchestration/tech/agent-runtime.md) · [施工](./logic/orchestration/plans/agent-runtime.md) |
| **in-flight-draft**（进行中草稿放内存） | [技术](./logic/orchestration/tech/in-flight-draft.md) · [施工](./logic/orchestration/plans/in-flight-draft.md) |
| **turn-abort**（停止本轮） | [功能](./logic/orchestration/features/turn-abort.md) · [技术](./logic/orchestration/tech/turn-abort.md) · [施工](./logic/orchestration/plans/turn-abort.md) |
| **steer-and-queue**（插话与排队） | [功能](./logic/orchestration/features/steer-and-queue.md) · [技术](./logic/orchestration/tech/steer-and-queue.md) · [施工](./logic/orchestration/plans/steer-and-queue.md) |
| **sandbox-keepalive**（沙盒保活） | [功能](./logic/orchestration/features/sandbox-keepalive.md) · [技术](./logic/orchestration/tech/sandbox-keepalive.md) · [施工](./logic/orchestration/plans/sandbox-keepalive.md) |
| **turn-checkpoint**（每轮代码快照） | [功能](./logic/orchestration/features/turn-checkpoint.md) · [技术](./logic/orchestration/tech/turn-checkpoint.md) · [施工](./logic/orchestration/plans/turn-checkpoint.md) |
| **graceful-shutdown**（优雅关闭与崩溃恢复） | [功能](./logic/orchestration/features/graceful-shutdown.md) · [技术](./logic/orchestration/tech/graceful-shutdown.md) · [施工](./logic/orchestration/plans/graceful-shutdown.md) |

### agent 逻辑层 · 归属仲裁（`@nimbo/agent` + 随宿主变化的实现）

> 保证同一份对话、同一时刻只有一个执行在跑。**语义固定，实现随宿主换**——所以三种实现的文档跟语义并排放在这里，而不是散在各个宿主环境下。目录：`docs/logic/arbitration/`

| 功能 | 三视角 |
| --- | --- |
| **arbitration-impl**（三种归属仲裁机制） 🚧 | [功能](./logic/arbitration/features/arbitration-impl.md) · [技术](./logic/arbitration/tech/arbitration-impl.md) |

> 归属仲裁本身的语义推导在[总纲 §5](./architecture/tech/agent-kernel.md)。

### 宿主层 · 跨环境的接口契约

> 所有宿主环境**共同实现**的那份接口。**只写一遍**，各环境怎么落地看下面几段。目录：`docs/host/contract/`

| 模块 | 功能 | 三视角 |
| --- | --- | --- |
| **沙盒** | **sandbox**（沙盒工作区契约） | [功能](./host/contract/features/sandbox.md) · [技术](./host/contract/tech/sandbox.md) · [施工](./host/contract/plans/sandbox.md) |
| **沙盒** | **sandbox-provider**（provider 抽象与选型） | [功能](./host/contract/features/sandbox-provider.md) · [技术](./host/contract/tech/sandbox-provider.md) · [施工](./host/contract/plans/sandbox-provider.md) |
| **持久化** | **persistence** 🚧 | [功能](./host/contract/features/persistence.md) · [技术](./host/contract/tech/persistence.md) |
| **流分发** | **stream-fanout** 🚧 | [功能](./host/contract/features/stream-fanout.md) · [技术](./host/contract/tech/stream-fanout.md) |

### 宿主层 · 四档宿主环境

> 每一档讲的是「这个环境下四样能力各怎么配、有什么固有边界」。想比较各档差异，先看[总纲附录 B](./architecture/tech/agent-kernel.md)。

| 环境 | 一句话 | 三视角 |
| --- | --- | --- |
| **Node 长驻** | 唯一一档零配置就能跑的；从 CLI 一路加到 k8s | [功能](./host/node/features/deployment.md) · [技术](./host/node/tech/deployment.md) |
| **Cloudflare** | Durable Object 把归属仲裁白送了 | [功能](./host/cloudflare/features/deployment.md) · [技术](./host/cloudflare/tech/deployment.md) |
| **Vercel** | 最费事的一档——找不到持有者，流分发必须外挂 Redis | [功能](./host/vercel/features/deployment.md) · [技术](./host/vercel/tech/deployment.md) |
| **E2B** | 只提供沙盒这一样能力，可配在任何一档下 | [功能](./host/e2b/features/deployment.md) · [技术](./host/e2b/tech/deployment.md) |
| —— | **cloudflare-worker-server**（CF 那档的参考实现） | [功能](./host/cloudflare/features/cloudflare-worker-server.md) · [技术](./host/cloudflare/tech/cloudflare-worker-server.md) · [施工](./host/cloudflare/plans/cloudflare-worker-server.md) |

🚧 = 接口未定稿，文档写的是已拍板的形态与约束，未定处标了 `TODO`。

### 接入层 —— 构建者写的应用代码

> 路由、SSE、转发、审批端点、前端。**不在框架里**，这里的文档是 `apps/` 下那个示例 chat 应用。目录：`docs/ingress/`

| 功能 | 三视角 |
| --- | --- |
| **chat-webapp**（示例 chat 应用） | [功能](./ingress/features/chat-webapp.md) · [技术](./ingress/tech/chat-webapp.md) · [施工](./ingress/plans/chat-webapp.md) |
| **chat-ui**（界面语言） | [功能](./ingress/features/chat-ui.md) · [技术](./ingress/tech/chat-ui.md) · [施工](./ingress/plans/chat-ui.md) |
| **push-notification**（推送通知） | [功能](./ingress/features/push-notification.md) · [技术](./ingress/tech/push-notification.md) · [施工](./ingress/plans/push-notification.md) |
| **composer-skill-mention**（composer 指定 skill） | [功能](./ingress/features/composer-skill-mention.md) · [技术](./ingress/tech/composer-skill-mention.md) · [施工](./ingress/plans/composer-skill-mention.md) |
| **telemetry**（遥测） | [功能](./ingress/features/telemetry.md) · [技术](./ingress/tech/telemetry.md) · [施工](./ingress/plans/chat-observability.md) |

### 周边

| 功能 | 三视角 |
| --- | --- |
| **examples**（示例集/实验田） | [功能](./misc/features/examples.md) · [技术](./misc/tech/examples.md) · [施工](./misc/plans/examples.md) |
| **verification**（验证与验收） | [施工](./misc/plans/verification.md)（仅施工视角） |
