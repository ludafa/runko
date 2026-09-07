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

补上 `repository` 字段，指向 https://github.com/ludafa/runko。

npm 包页面此前没有任何指向源码的链接（0.1.0 首发时漏了这个字段）。现在每个包都带上仓库地址与自己在
monorepo 里的子目录（`directory`），npm 上的「Repository」入口会直接落到该包的源码目录，而不是仓库根。
