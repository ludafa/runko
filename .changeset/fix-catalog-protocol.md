---
"@runko/agent": patch
"@runko/conformance": patch
"@runko/core": patch
"@runko/just-bash": patch
"@runko/mini-bash": patch
"@runko/persist-kysely": patch
"@runko/persist-mongo": patch
"@runko/persist-mysql": patch
"@runko/persist-postgres": patch
"@runko/persist-sqlite": patch
"@runko/sandbox-cloudflare": patch
"@runko/sandbox-e2b": patch
"@runko/sandbox-vercel": patch
"@runko/sdk": patch
"@runko/virtual-fs": patch
---

修复 **0.1.1 无法用 npm 安装**的问题。

0.1.1 的发布产物里，`zod` / `kysely` / `just-bash` 等依赖的版本范围写的是 pnpm 的
`catalog:` 协议原文。npm 不认识这个协议，安装时直接报错：

```
npm error code EUNSUPPORTEDPROTOCOL
npm error Unsupported URL Type "catalog:": catalog:
```

原因是发布流程改用 `npm publish`（为了 OIDC 与 provenance）后，只把 `workspace:`
换成了真实版本，漏了 `catalog:`。0.1.2 起两个协议都会解析，并在发布前断言不留任何
pnpm 私有协议；发布后还会用 npm 真装一次做兜底验证。

**0.1.1 请勿使用**，直接升到 0.1.2。0.1.0 不受影响（它是用 `pnpm publish` 发的）。
