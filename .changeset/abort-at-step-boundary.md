---
"@nimbo/core": patch
---

`TurnOptions.signal` 的停止时机变确定：loop 现在在**每个 step 边界**显式检查 abort 信号，看到已中止就直接以 `status: 'interrupted'`（`NimboError.code: 'aborted'`）收尾，绝不开始新的一步。

此前只有「模型调用本身被信号掐断」这一条路径能停——工具执行被中止时工具是正常收尾的（「失败即 ExecResult」，不抛错），于是 loop 会照常进入下一步、白打一次模型调用，直到那次调用因信号已中止而抛错才停下。现在那次多余的模型调用不再发生。
