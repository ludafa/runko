# @nimbo/mini-bash

## 0.1.0

### Minor Changes

- 首发：`NimboExec` 的两个实现——**同一个接口、两档语法面**，一行代码互换。

  ```ts
  exec: miniBash(fs); // 极简档
  exec: justBash(fs); // 全语法档
  ```

  两个都跑在任意 `NimboFS` 上（跟文件工具共享同一份虚拟文件系统，一致性是结构性的，
  不需要同步），**都不 fork 子进程、不碰真实磁盘与网络**。

  **怎么选**：

  |        | `@nimbo/mini-bash`                                           | `@nimbo/just-bash`                                                          |
  | ------ | ------------------------------------------------------------ | --------------------------------------------------------------------------- |
  | 语法面 | 六个只读命令（cat/grep/find/tail/head/echo）+ 四个控制操作符 | 完整 `if`/`for`/`while`/`until`/`case`/函数/变量与参数扩展/glob/管道/重定向 |
  | 依赖   | **零依赖**，随 `@nimbo/sdk` 一起装                           | 含 sql.js / quickjs-emscripten 等 wasm 大件，**需显式安装**                 |
  | 定位   | 安全默认、测试与演示载体                                     | Claude 系模型高频产出的控制流脚本撑不住时换这档                             |

  真实命令执行是第三个选项（`@nimbo/core` 的 `localExec`，或宿主自己的沙盒实现），
  不在这两个包里。

### Patch Changes

- Updated dependencies [847222d]
- Updated dependencies [be08aac]
- Updated dependencies [fca6c03]
- Updated dependencies [b342e5b]
- Updated dependencies [3ffdf28]
- Updated dependencies [fca6c03]
  - @nimbo/core@0.1.0
