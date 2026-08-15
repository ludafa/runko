---
layout: home

hero:
  name: nimbo
  text: 可嵌入的轻量 agent SDK
  tagline: 几行代码在自己的 Node 服务里跑起一个能读写文件、执行命令、装载 skills 的 agent loop——不 spawn 任何外部 CLI 二进制。
  actions:
    - theme: brand
      text: 总览
      link: /overview
    - theme: alt
      text: 架构：两块七个模块
      link: /architecture/features/agent-kernel
    - theme: alt
      text: 术语表
      link: /terms

features:
  - title: 架构总纲
    details: 分层总纲——两块七个模块、六档部署形态、15 个包怎么拆。凡是可替换的东西，语义在逻辑层、实现在宿主层。
    link: /architecture/features/agent-kernel
    linkText: 进入
  - title: 逻辑层 · 归属仲裁
    details: 保证同一份对话同时只有一个执行在跑。语义固定，实现随宿主换——内存 Map / 租约 / Durable Object 三档。
    link: /logic/arbitration/features/arbitration-impl
    linkText: 进入
  - title: 逻辑层 · 轮编排
    details: "@nimbo/agent：一轮的一生——起、中断、挂起、恢复、收尾，外加账本、待发队列、沙盒生命周期。"
    link: /logic/orchestration/features/single-ledger
    linkText: 进入
  - title: 逻辑层 · 执行引擎
    details: "@nimbo/core：调模型 → 跑工具 → 喂回去，直到模型说完。内置工具、审批链、skills、上下文压缩。"
    link: /logic/engine/features/core-sdk
    linkText: 进入
  - title: 宿主层
    details: 可替换的那一块。跨环境的接口契约只写一遍，落地按环境分四档——Node 长驻 · Cloudflare · Vercel · E2B。
    link: /host/contract/features/sandbox
    linkText: 进入
  - title: 接入层
    details: 构建者写的应用代码：路由、SSE、审批端点、前端。这里的文档是 apps/ 下那个示例 chat 应用。
    link: /ingress/features/chat-webapp
    linkText: 进入
  - title: 周边
    details: 示例集（打开即用的实验田）、验证与验收、以及这个文档站本身是怎么搭的。
    link: /misc/features/examples
    linkText: 进入
---

## 这份文档是怎么组织的

**先按架构分层切目录，每段里边再分三个视角**——路径形状是 `docs/<分层>/<视角>/<feature>.md`。

框架本身只有两块：**agent 逻辑层**（固定，不可替换）按三个子层切，**宿主层**（可替换）按宿主环境切。顶部导航里这两栏是下拉菜单；进到某一段之后，左侧侧栏按「功能 / 技术方案 / 施工进展」分三组，列出这一段的全部文档。

每份文档正文上方那行小标签（层 · 模块 · 包 · 标签）来自文档自己的 front matter，**侧栏也是从它现推的**——新增文档只要放对目录、写好 front matter 就会自动出现，不用改配置。

站点怎么搭的、怎么本地跑，见[文档站](/misc/features/docs-site)。
