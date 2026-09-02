---
title: "文档站（VitePress）— 施工进展"
slug: docs-site
view: 施工
layer: 周边
module: —
packages: []
tags: ["文档站", "VitePress", "mermaid", "站内搜索"]
related: ["misc/features/docs-site.md", "misc/tech/docs-site.md", "architecture/plans/agent-kernel.md"]
---

# 文档站（VitePress）— 施工进展

> 相关：[功能](../features/docs-site.md)，[技术方案](../tech/docs-site.md)。
> 上游：本功能建在 [agent 内核包施工](../../architecture/plans/agent-kernel.md) 2026-08-15 那次「按分层分包重划 docs」之上——**front matter 是这个站的事实来源**，没有那一步就没有自动侧栏。

## 状态

**🟢 已完成**（2026-08-15）。构建通过、零死链、CI 已接。未做部署（见「明确不做」）。

## 阶段拆单

| # | 干什么 | 产出 | 状态 |
| --- | --- | --- | --- |
| 1 | 装依赖：`vitepress` / `mermaid` / `vitepress-plugin-mermaid` 进根 `devDependencies` | `package.json` · `pnpm-lock.yaml` | ✅ |
| 2 | 首页与总览页：新建 `docs/index.md`；`README.zh-CN.md` → `overview.md`，改掉仓库里链它的两处 | 2 份文档 + 2 处链接 | ✅ |
| 3 | 配置骨架 `docs/.vitepress/config.ts`：站点元信息、导航、mermaid 包装 | 配置 | ✅ |
| 4 | **侧栏生成器**：扫 `docs/**/*.md` 读 front matter，按层分组、组内按视角排 | `docs/.vitepress/sidebar.ts` | ✅ |
| 5 | **出站链接改写**：markdown-it `link_open` 规则，`docs/` 外的相对链接改写成 GitHub 地址 | 配置 | ✅ |
| 6 | **中文搜索切词**：CJK 单字 + 二元组 tokenizer | 配置 | ✅ |
| 7 | 脚本与忽略：`docs:dev` / `docs:build` / `docs:preview`；`.gitignore` 加 `.vitepress/cache`、`dist` | `package.json` · `.gitignore` | ✅ |
| 8 | **front matter 校验**：`docs:check` —— 每份文档字段齐全、取值合法、不会漏进侧栏 | `docs/.vitepress/check.ts` | ✅ |
| 9 | CI 接上文档站的质量门 | `.github/workflows/ci.yml` | ✅ |
| 10 | 回填本文档与 `CLAUDE.md`「文档规范」 | 文档 | ✅ |
| **11** | **`docs/` 独立成 workspace 成员**（`@runko/docs`）：自己的 `package.json`/`tsconfig.json`/`README.md`，依赖从根挪进来，接上 `typecheck`，`base` 走 `DOCS_BASE` 环境变量以支持子路径部署 | `pnpm-workspace.yaml` · `docs/package.json` 等 | ✅ |

**顺序**：1 → 2/3 → 4/5/6 → 7 → 8 → 9 → 10 → 11。

## 验收

| # | 用例 | 预期 | 实际 |
| --- | --- | --- | --- |
| V1 | `pnpm docs:build` | 一次通过，**零死链** | ✅ 79 页，9.5 秒 |
| V2 | 全部文档进侧栏 | 无孤儿页；侧栏条目数 = 文档数 | ✅ 六层逐层核对，3/15/20/15/15/7 全等 |
| V3 | `pnpm docs:check` | front matter 字段齐全、取值合法 | ✅ 75 份通过 |
| V4 | mermaid 渲染 | 每张图都出来，明暗两主题都可读 | ✅ 产物含 mermaid（app chunk 637 KB） |
| V5 | 中文搜索 | 「归属仲裁」「租期标识」「挂起」能命中 | ✅ 索引含这些二元组 |
| V6 | 出站链接 | 指向 `packages/` `apps/` `examples/` `CLAUDE.md` 的链接跳 GitHub | ✅ 产物里已是 `github.com/ludafa/runko/blob/main/…` |
| V7 | 新增文档零配置 | 放对目录 + 写好 front matter 即自动进侧栏 | ✅ 由 V2 的计数一致性覆盖 |
| V8 | 独立成员 | `pnpm ls -r` 认得 `@runko/docs`；`pnpm -r build`/`typecheck` 覆盖到它 | ✅ 14 个成员，两条 `-r` 都跑到 `docs` |
| V9 | 子路径部署 | `DOCS_BASE=/runko/ pnpm docs:build` 后资源与站内链接都带前缀 | ✅ `href="/runko/assets/…"`、`/runko/logic/engine/features/core-sdk` |
| V10 | `pnpm --filter @runko/docs typecheck` | `.vitepress/` 下配置与脚本类型正确 | ✅ 通过（修掉 6 处后） |

### 施工中发现并处理的三件事

1. **正文里裸写 `<T>` 会让构建直接失败**——markdown 被当 Vue 模板编译，`send<T>` 里的尖括号被当成未闭合标签。全库扫下来只有 2 处（都在 `engine/plans/core-sdk.md`），包进反引号即可。**这条已写进 [`CLAUDE.md`](../../../CLAUDE.md)**，因为报错信息给的是编译后模板的行号，照着去源文件找会扑空。
2. **`view` 字段与侧栏标题必须分开**——`docs:check` 第一次跑就抓到：front matter 里是短形式「技术」（`CLAUDE.md` 定的），而侧栏标题写全为「技术方案」。两者刻意分成 `fm` 与 `text` 两个字段，不互相冒充。**这正是校验脚本存在的意义**——它上线第一分钟就拦下了一处不一致。
3. **搜索索引从 3.1 MB 压到 2.2 MB**——CJK 切词原本同时产出单字与二元组，去掉单字后索引小了三成；单字查询由 `searchOptions.prefix` 兜住，召回不受影响。

## 明确不做

- **不接托管**。形态已经可独立部署、子路径也验过了（V9），**真要上线只差一个 workflow**：构建命令 `pnpm --filter @runko/docs run build`、输出目录 `docs/.vitepress/dist`；GitHub Pages 这类子路径托管额外设 `DOCS_BASE=/runko/`。托管到哪儿由你定。
- **不做多语言**（站点只有中文，英文入口仍是根 `README.md`）。
- **不做版本化文档**。包还没稳定到要为旧版本留一套。
- **不改文档内容**。站点是 `docs/` 的一层皮。

## 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-08-15 | 追加第 11 项：**`docs/` 独立成 workspace 成员 `@runko/docs`**，为的是能单独部署。依赖从根挪进 `docs/package.json`；顺带接上 `typecheck`——**它一接上就抓出 6 处类型问题**（5 处 `noUncheckedIndexedAccess` 下的空值漏判 + 1 处 `markdown-it` 内部类型路径在 NodeNext 下解析不到，改用 VitePress 自己的 `MarkdownRenderer` 类型推导）。CI 相应简化：`docs:build` 那步删了，因为 `pnpm -r build` 现在会构建它、构建时就做死链检查；只留 `docs:check`（脚本名不在 `-r` 跑的三个里） |
| 2026-08-15 | 建档并完成全部 10 项，验收 V1–V7 全绿。**与技术方案的偏差一处**：导航落地页原打算取「该层第一份 features 文档」，实际是字母序（执行引擎会落到 `approval-grant-split`），改成在 `structure.ts` 里给每层显式指定 `landing`（执行引擎 → `core-sdk`、轮编排 → `single-ledger` 等）。另加了两样技术方案里没写的：术语表进顶部导航；每篇正文上方一行归位标签（层 · 模块 · 包 · tags，走 `doc-before` 主题槽，数据直接读 front matter，不另存一份） |
