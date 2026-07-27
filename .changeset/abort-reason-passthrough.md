---
"@nimbo/core": patch
---

中止一轮时，宿主自己给的理由现在会出现在收尾信息里：`abortController.abort(new Error("..."))` 的那句话会成为 `message-metadata` 上 `error.message` 的内容（`code` 仍是 `aborted`）。

这让宿主能区分不同的中止原因——比如「用户按了停止键」和「服务进程要关闭了」——并在界面上分别解释，而不必让 SDK 认识这些宿主侧的概念。

`abort()` 不带参数时行为不变，仍是原来的默认文案（运行时自造的 `AbortError` 不算宿主的解释）。
