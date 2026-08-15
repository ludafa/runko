---
title: "联网搜索（web search）· 施工进展"
slug: web-search
view: 施工
layer: 逻辑层
module: 执行引擎
packages: ["@nimbo/core"]
tags: ["联网搜索", "工具", "provider"]
related: ["logic/engine/features/web-search.md", "logic/engine/tech/web-search.md", "architecture/tech/agent-kernel.md"]
---
# 联网搜索（web search）· 施工进展

> 相关：[产品文档](../features/web-search.md) · [技术方案](../tech/web-search.md) · [chat 应用施工进展](../../../ingress/plans/chat-webapp.md) · 术语见 [docs/terms.md](../../../terms.md)
> 依赖：无新依赖（不装 `exa-js`，用全局 `fetch`）；改动全部落在 `apps/node-server`，`packages/*` 零改动 → **不需要 changeset**。

## 设计定案摘要（主线程拍板，2026-07-26）

1. **落点在 chat 应用**：`apps/node-server/src/agent/web-search.ts`，经 `chat-agent.ts` 的 `defineAgent({ tools })` 条件注册，与 `ask-user` 同构；core 零改动（理由见[技术方案 §1](../tech/web-search.md)）。
2. **对模型的工具名 `web-search`**，配置项照实叫 `EXA_API_KEY`。
3. **`fetch` 直调 `POST https://api.exa.ai/search`** + zod 宽松 schema 校验响应，不装 SDK。
4. **输入四字段**：`query`（必填）/ `numResults`(1–10，默认 5) / `category` / `includeDomains`；输出为格式化纯文本。
5. **`readOnly: true`、不设 `approval`**；错误一律抛 `Error` → `tool-output-error`，文案分档（401/429/其他非 2xx/形状不符/超时）。
6. **`EXA_API_KEY` 缺席即不注册**，模型看不见这个工具；key 不进沙盒、不进 prompt。

## 拆单

| # | 内容 | 落点 | 状态 |
|---|---|---|---|
| 1 | 文档三件套 + 术语表词条 + `.env.template` | `docs/{features,tech,plans}/web-search.md`、`docs/terms.md`、`.env.template` | ✅ 已完成 |
| 2 | 工具实现：配置解析 + 请求构造 + 响应校验 + 结果格式化 + 错误分档 | `apps/node-server/src/agent/web-search.ts` | ✅ 已完成 |
| 3 | 接线：`BuildSessionOptions.webSearchTool` + 条件注册 + instructions 补一句 | `apps/node-server/src/agent/chat-agent.ts` | ✅ 已完成 |
| 4 | 测试：工具单测（注入假 `fetch`，零网络）+ `buildSession` 注册/缺席两态 | `apps/node-server/test/agent/web-search.test.ts`、`test/agent/chat-agent.test.ts` | ✅ 已完成（web-search 32 例、chat-agent +3 例） |
| 5 | 质量门：`typecheck` / `lint` / `test` | `apps/node-server` | ✅ 已完成（见验收结论） |

**依赖顺序**：#2 → #3 → #4；#1 先行（本仓库硬性流程：先文档后代码）。

## 验收要点

- 没配 `EXA_API_KEY` 时行为与本功能上线前一致：`agent.tools` 里没有 `web-search`，模型调它会得到 AI SDK 的 `unavailable tool` 错误（与 `ask-user` 未注册时同款）。
- 配了 key：请求体命中约定形状（`type: "auto"`、`contents.text.maxCharacters`、`highlights: true`），`x-api-key` 头带对，且 **key 不出现在任何返回给模型的文本里**。
- `numResults` 越界（模型给 0 或 99）由 zod 挡下；缺省为 5。
- 零结果、缺 `title`/缺 `publishedDate`、`highlights` 为空数组等残缺响应都能格式化出可读文本，不抛错。
- 401/429/500/响应形状不符/超时 各自抛出对应文案的 `Error`；本轮被[停止](../../../terms.md)时原样上抛 abort，不伪装成搜索失败。
- 工具 `readOnly === true`、无 `approval`。
- 测试零网络零凭证（`fetch` 注入假实现）。

## 验收结论

**2026-07-26 · 通过。** 主线程亲自跑 `apps/node-server`：

- `pnpm typecheck`：绿。全文件无 `any`、无类型断言（`as`）、无非空断言；唯一的 `unknown` 是 `Response.json()` 那一行的序列化边界，下一行就被 zod `safeParse` 收窄，带注释说明。
- `pnpm test`：**414/414 绿**（基线 379 → 新增 35：`web-search.test.ts` 32 例 + `chat-agent.test.ts` 3 例）。
- lint：本功能新增/改动的四个文件（`src/agent/{web-search,chat-agent}.ts` + 对应两个测试）**单独跑 `eslint --max-warnings 0` 干净**。⚠️ 但仓库级 `pnpm lint` **本来就是红的**：与本功能无关的存量文件有既有告警/错误（例：`test/agent/uimessage-single-ledger.test.ts` 单文件 11 errors + 90 prettier warnings，本次完全未触碰）。这条**不是本功能引入的**，也未在本次修复——存量 lint 清理该单开工单。

**一处防假绿自查**：「401 文案不回显 API key」这条断言用的是 `rejects.not.toThrow(...)`，这种否定式断言容易永远为真。特意把它临时改成必然失败的形式跑了一次，确认真的会红，再改回——断言有效。

覆盖到的关键分支：请求体/请求头形状（含三个刻意不用的 Exa 过时参数）、`numResults` 默认值与 zod 越界拒绝、可选字段只在模型给了时才进 body、零结果、`results` 整个缺席、`null` 字段、缺标题、highlights 优先于 text 且最多 3 段、text 空白压缩与 500 字截断、401/403/429/其他非 2xx（带体/空体）/JSON 解析失败/形状不符/超时/本轮停止/网络异常 各自的文案、`readOnly` 为真且无 `approval`、env 解析（缺席/空串/纯空白/两端空白）、`buildSession` 的三态（都没配 → `unavailable tool`；显式注入 → 生效；只配 `EXA_API_KEY` → 真工具跑通且 `x-api-key` 带对）。

**未做真机验证**（需要真实 `EXA_API_KEY` 与起着的 chat server，按本仓库规范 dev server 归用户自己起）。真机步骤见下。

## 真机验证步骤（待用户执行）

1. 在仓库根 `.env` 填 `EXA_API_KEY=<你的 key>`。
2. 起服务：`! pnpm chat:server` 与 `! pnpm chat:web`。
3. 新建会话，问一个模型显然不知道的时效性问题，例如「vitest 现在最新的稳定版是几点几？给出来源」。
4. 预期：对话流里出现 `web-search` 工具卡片（不弹审批），展开可见 query 与若干条「标题/网址/日期/摘录」；模型的回答里带得出来源网址。
5. 反向验证：把 `.env` 里的 `EXA_API_KEY` 注释掉重启 server，同样的问题不应再出现 `web-search` 卡片，且不出现任何「不可用工具」的失败卡片。

## 变更记录

| 日期 | 阶段 | 变更 | 结论 |
|---|---|---|---|
| 2026-07-26 | 设计定案（主线程） | 落点/工具名/对接方式/输入输出契约/错误分档 六条定案 | — |
| 2026-07-26 | 文档三件套（主线程） | 新建 features/tech/plans 三篇；`terms.md` 新增「联网搜索（web search）」词条；`.env.template` 新增 Exa 一节 | — |
| 2026-07-26 | 实现 + 测试（主线程） | `web-search.ts` 新建、`chat-agent.ts` 接线（`buildTools` 抽出 + instructions 条件补一行）；35 个新用例 | typecheck 绿、test 414/414 绿、改动文件 lint 干净（仓库级 lint 存量红，非本功能引入） |
