---
title: "文档站（VitePress）— 使用手册"
slug: docs-site
view: 功能
layer: 周边
module: —
packages: []
tags: ["文档站", "VitePress", "mermaid", "站内搜索"]
related: ["misc/tech/docs-site.md", "misc/plans/docs-site.md", "architecture/tech/agent-kernel.md"]
---

# 文档站（VitePress）— 使用手册

> 相关：[技术方案](../tech/docs-site.md)，[施工进展](../plans/docs-site.md)。
> 依赖：整站的目录结构由 [agent 内核包](../../architecture/tech/agent-kernel.md) 的分层定义，见根 [`CLAUDE.md`](../../../CLAUDE.md)「文档规范」。

## 1. 要解决什么问题

`docs/` 现在有 70 多份 markdown、上千条互链、几十张 mermaid 图。在 GitHub 上读有三个实打实的难处：

- **翻不动**——没有目录树，只能靠记路径或一层层点文件夹。
- **搜不了**——GitHub 的仓库内搜索是全文匹配，搜「归属仲裁」会把 issue、代码注释一起端上来。
- **图看不全**——GitHub 能渲染 mermaid，但复杂的时序图在窄栏里挤成一团，也不能缩放。

文档站解决的就是这三件：**左边有树、顶上有搜索框、图能正常看**。

## 2. 怎么用

`docs/` 是一个**独立的 workspace 成员**（`@runko/docs`）——自带依赖、自己构建、产物可单独部署。

在仓库根跑：

```sh
pnpm docs:dev        # 本地开发，改完即时刷新
pnpm docs:build      # 构建静态站；顺带做全站死链检查
pnpm docs:preview    # 预览构建产物
pnpm docs:check      # front matter 体检
```

或者进 `docs/` 目录直接跑 `pnpm dev` / `build` / `preview` / `check` / `typecheck`。

> **`docs:dev` 是常驻进程**，跑起来不会自己退出。验证改动优先用 `docs:build`（跑完即退，而且死链检查更严）。

### 部署

产物在 `docs/.vitepress/dist/`，是一堆静态文件，托管在哪儿都行。**部署到子路径**（比如 GitHub Pages 的 `https://<user>.github.io/runko/`）用环境变量指定，不用改配置：

```sh
DOCS_BASE=/runko/ pnpm docs:build
```

放在域名根下（Cloudflare Pages / Vercel / Netlify）则不用设。

## 3. 站点长什么样

**顶部导航 = 架构分层**。框架本身的两块（agent 逻辑层、宿主层）内部还有分档，所以那两栏是下拉菜单：

| 导航项 | 下拉里有什么 | 对应目录 |
| --- | --- | --- |
| 架构 | —— | `docs/architecture/`：分层总纲、部署形态、包怎么拆 |
| **agent 逻辑层** | 归属仲裁 | `docs/logic/arbitration/`：语义 + 三种随宿主变化的实现 |
| | 轮编排 | `docs/logic/orchestration/`：`@runko/agent`，账本、挂起恢复、排队、保活 |
| | 执行引擎 | `docs/logic/engine/`：`@runko/core`，loop、内置工具、审批链 |
| **宿主层** | 契约（跨环境） | `docs/host/contract/`：沙盒 · 持久化 · 流分发三份接口 |
| | Node 长驻 | `docs/host/node/`：单进程 / cluster / Docker / k8s |
| | Cloudflare | `docs/host/cloudflare/`：Worker + Durable Object |
| | Vercel | `docs/host/vercel/`：Functions + Sandbox |
| | E2B | `docs/host/e2b/`：E2B 沙盒 |
| 接入层 | —— | `docs/ingress/`：`apps/` 下那个示例 chat 应用 |
| 周边 | —— | `docs/misc/`：示例集、验证与验收、本文 |

**左侧侧栏 = 这一段的三视角**：进到某一段之后，侧栏按「功能 / 技术方案 / 施工进展」分三组，每组列出这一段的全部文档。想看「轮编排的技术方案有哪些」，点开「agent 逻辑层 → 轮编排」再看第二组即可。

侧栏按**最长路径前缀**匹配，所以宿主层每个环境各有自己一套侧栏，观感跟只有一层时完全一样。

**侧栏是自动生成的**——从每份文档的 front matter 读 `view` / `title`，新增文档不用手动登记，放对目录就会自己出现。

## 4. 你会看到的行为

- **mermaid 图正常渲染**，跟着站点主题切明暗色。
- **站内搜索**（右上角，或按 `/`）：本地索引，不依赖任何外部服务，**中文按字与二元组切词**，搜「归属」「仲裁」「归属仲裁」都能命中。
- **指向仓库代码的链接自动跳 GitHub**：文档里写的是 `../../packages/core/README.md` 这种相对路径（方便在编辑器里直接跳），构建时会自动改写成 GitHub 上的地址——**源文件不动，站上能点**。
- **死链构建即报错**：`docs:build` 会检查每一条站内链接，指向不存在的页面就直接构建失败。CI 里也跑这一步。

## 5. 范围与非目标

**不做的**：

- **不做多语言。** 站点只有中文。根 [`README.md`](../../../README.md) 的英文版仍是英文入口，不进站。
- **不做版本化文档**（VitePress 的 versioning）。包还没稳定到需要为旧版本留一套文档。
- **本期不接托管。** 站点已经是**可独立部署**的形态（独立成员、自带依赖、子路径可配），但具体托管到哪儿（GitHub Pages / Cloudflare Pages / Vercel）与自动发布流程另议，见[施工进展](../plans/docs-site.md)。
- **不改文档内容。** 站点是 `docs/` 的一层皮，markdown 该怎么写还怎么写。

## 6. 成功标准

1. `pnpm docs:build` 在干净 checkout 上一次通过，**零死链**。
2. 70+ 份文档全部出现在侧栏里，且归位与 front matter 一致——没有孤儿页。
3. 每一张 mermaid 图都渲染出来，明暗两个主题下都看得清。
4. 搜「归属仲裁」「租期标识」「挂起」这类中文词能命中正确的页面。
5. 新增一份文档时，**只需把文件放进对的目录并写好 front matter**，不用改任何配置。
