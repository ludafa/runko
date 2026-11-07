---
"@runko/just-bash": patch
---

能在 Cloudflare Workers 与浏览器打包里用了：适配器不再从 just-bash 导入它浏览器构建里没有的 `unsafeBytesFromLatin1`，也不再依赖 `Buffer`。行为不变。
