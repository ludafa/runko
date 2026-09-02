# @nimbo/sandbox-cloudflare

## 0.1.0

### Minor Changes

- 首发：把 Cloudflare Sandbox（真实 Linux 容器）包成 `NimboFS & NimboExec`。

  跟 E2B / Vercel 两个适配器**架构不一样，这点要先知道**：Cloudflare Sandbox 只能从
  Worker 内部经 Durable Object binding 访问，**没有办法从任意 Node 进程直连**。所以本包
  是「网关形态」，两个入口：

  - `.`——纯 `fetch` 协议客户端，跑在**任意** Node ≥20 进程，不 import `@cloudflare/sandbox`
    （那个包只能在 workerd 里加载）。
  - `./worker`——网关，部署在**你自己的** wrangler 项目里，把协议翻译成对真实
    `@cloudflare/sandbox` 的调用。

  拿到之后跟别的工作区一样一次注入 `createSession(agent, { workspace })`，agent 侧代码
  零改动。

### Patch Changes

- Updated dependencies [847222d]
- Updated dependencies [be08aac]
- Updated dependencies [fca6c03]
- Updated dependencies [b342e5b]
- Updated dependencies [3ffdf28]
- Updated dependencies [fca6c03]
- Updated dependencies
  - @nimbo/core@0.1.0
  - @nimbo/virtual-fs@0.1.0
