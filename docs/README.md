# @nimbo/docs

nimbo 的设计文档站（VitePress）。**它是一个独立的 workspace 成员**——自带依赖、自己构建、可以单独部署，不跟 `packages/*` 的发布流程绑在一起。

> 这份 README 是给「要动这个站」的人看的。**文档站本身的产品/技术/施工三份文档**在
> [文档站（VitePress） · 功能](./misc/features/docs-site.md) ·
> [文档站（VitePress） · 技术方案](./misc/tech/docs-site.md) ·
> [文档站（VitePress） · 施工进展](./misc/plans/docs-site.md)。

## 跑起来

在这个目录里：

```sh
pnpm check      # front matter 体检：字段齐全、取值合法、不会漏出侧栏
pnpm build      # 构建 + 全站死链检查（跑完即退）
pnpm preview    # 预览构建产物
pnpm dev        # 本地开发服务器（常驻进程）
pnpm typecheck  # 检查 .vitepress/ 下的配置与脚本
```

仓库根也有等价的快捷方式：`pnpm docs:check` / `docs:build` / `docs:preview` / `docs:dev`。

## 目录怎么组织

**路径形状是 `<分层>/<视角>/<feature>.md`**——先按架构分层切目录，每段里边再分功能 / 技术方案 / 施工进展三个视角。

框架本身只有两块：**agent 逻辑层**（固定，不可替换）和**宿主层**（可替换）。逻辑层按三个子层切，宿主层按宿主环境切。

| 目录 | 装什么 |
| --- | --- |
| `architecture/` | 架构总纲：分层、部署形态、包怎么拆 |
| `logic/arbitration/` | 逻辑层 · 归属仲裁——语义 + 随宿主变化的三种实现 |
| `logic/orchestration/` | 逻辑层 · 轮编排（`@nimbo/agent`） |
| `logic/engine/` | 逻辑层 · 执行引擎（`@nimbo/core`） |
| `host/contract/` | 宿主层 · 跨环境的接口契约：沙盒 · 持久化 · 流分发 |
| `host/node/` | 宿主层 · Node 长驻：单进程 / cluster / Docker / k8s |
| `host/cloudflare/` | 宿主层 · Worker + Durable Object |
| `host/vercel/` | 宿主层 · Functions + Sandbox |
| `host/e2b/` | 宿主层 · E2B 沙盒 |
| `ingress/` | 接入层：`apps/` 下那个示例 chat 应用 |
| `misc/` | 周边：示例集、验证与验收、本站 |
| `terms.md` · `overview.md` · `index.md` | 术语表、总览、站点首页——不属于任何一层，留在根 |

**同一个 feature 的三份文档 slug 必须一致；跨目录同名是有意的**——四档宿主的落地文档都叫 `deployment.md`，`ls host/*/tech/deployment.md` 正好捞出「所有环境怎么落地」。

## 加一份新文档

1. 放进对的 `<分层>/<视角>/` 目录，文件名（slug）三个视角保持一致。
2. 写好 front matter（字段清单见根 [`CLAUDE.md`](../CLAUDE.md)「文档规范」）。
3. `pnpm check && pnpm build`。

**不用改任何配置**——导航与侧栏是构建时扫 front matter 现推的。

## 依赖里那几个「看着没用」的包

`dayjs` / `cytoscape` / `cytoscape-cose-bilkent` / `@braintree/sanitize-url` / `debug` —— **本站一行都不 import 它们**，它们是 mermaid 的传递依赖。

之所以要显式声明，是因为 **pnpm 的严格 node_modules 布局 + Vite 开发模式**：`vitepress-plugin-mermaid` 会把这几个写进 `optimizeDeps.include`（还给 dayjs/cytoscape 配了 alias），而 pnpm 不提升传递依赖，Vite 从 `docs/` 根解析不到它们 → 预打包失败 → 浏览器直接拿到 CJS 原文件 → 报 `does not provide an export named 'default'`。**只在 `pnpm docs:dev` 下犯病，`docs:build` 是好的**（构建走另一条打包路径）。

版本**照抄 mermaid 自己声明的 range**，pnpm 因此复用同一份，不会装出第二个副本。插件 README 给的办法是 `pnpm install --shamefully-hoist`，那会把整个 workspace 的依赖可见性放开，不采用。

> `debug` 其实已经不是 mermaid v11 的依赖了（插件那份清单停留在 mermaid 10 时代），但它还在 `optimizeDeps.include` 里，不装每次 dev 都报一行解析失败，所以一并带上。

## 站点配置在哪

```
.vitepress/
├─ config.ts      站点配置：导航、侧栏、搜索、出站链接改写
├─ structure.ts   唯一手写的两张表：区段 → 中文名 + 落地页，导航分组
├─ docs.ts        扫 markdown 读 front matter（config 与 check 共用）
├─ check.ts       front matter 体检
├─ shims.d.ts     让 tsc 认得 .vue
└─ theme/         默认主题 + 每篇正文上方那行归位标签
```

## 部署

产物在 `.vitepress/dist/`，是一堆静态文件，托管在哪儿都行。

**部署到子路径**（比如 GitHub Pages 的 `https://<user>.github.io/nimbo/`）时用环境变量指定，不用改配置：

```sh
DOCS_BASE=/nimbo/ pnpm build
```

放在域名根下（Cloudflare Pages / Vercel / Netlify）则不用设，默认就是 `/`。
