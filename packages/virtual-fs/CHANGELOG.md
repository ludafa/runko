# @nimbo/virtual-fs

## 0.1.0

### Minor Changes

- 首发：nimbo 的虚拟文件系统内核。

  agent 看到的是一个普通文件系统，宿主看到的是一个**可检查、可导出 diff、可写回、可丢弃**
  的对象——**写入默认永不落真实磁盘**。

  三个 `NimboFS` 实现按「要不要碰真实磁盘」分档：

  - `MemoryFS`：全内存，最安全的默认。
  - `OverlayFS`：底层只读、改动落在上层，`diff()` 导出改了什么、`writeBack()` 决定要不要真写。
  - `DirFS`：直接映到一个真实目录。

  外加 mime 推断、reference 条目与**文件工具八件套**（读/写/改/删/列/搜/移动/复制），
  装配进 session 就能让 agent 直接操作工作区。

  装 `@nimbo/sdk` 的话本包全部 API 都已 re-export、八件套也自动拼进 session；**单独装**
  适合「只要一个文件沙盒、不要 agent loop」的场景。

### Patch Changes

- Updated dependencies [847222d]
- Updated dependencies [be08aac]
- Updated dependencies [fca6c03]
- Updated dependencies [b342e5b]
- Updated dependencies [3ffdf28]
- Updated dependencies [fca6c03]
  - @nimbo/core@0.1.0
