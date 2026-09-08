# @runko/just-bash

## 0.1.2

### Patch Changes

- 63d90e5: 修复 **0.1.1 无法用 npm 安装**的问题。

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

- Updated dependencies [63d90e5]
  - @runko/core@0.1.2

## 0.1.1

### Patch Changes

- c29a6eb: 补上 `repository` 字段，指向 https://github.com/ludafa/runko。

  npm 包页面此前没有任何指向源码的链接（0.1.0 首发时漏了这个字段）。现在每个包都带上仓库地址与自己在
  monorepo 里的子目录（`directory`），npm 上的「Repository」入口会直接落到该包的源码目录，而不是仓库根。

- Updated dependencies [c29a6eb]
  - @runko/core@0.1.1

## 0.1.0

### Minor Changes

- 首发：`RunkoExec` 的两个实现——**同一个接口、两档语法面**，一行代码互换。

  ```ts
  exec: miniBash(fs); // 极简档
  exec: justBash(fs); // 全语法档
  ```

  两个都跑在任意 `RunkoFS` 上（跟文件工具共享同一份虚拟文件系统，一致性是结构性的，
  不需要同步），**都不 fork 子进程、不碰真实磁盘与网络**。

  **怎么选**：

  |        | `@runko/mini-bash`                                           | `@runko/just-bash`                                                          |
  | ------ | ------------------------------------------------------------ | --------------------------------------------------------------------------- |
  | 语法面 | 六个只读命令（cat/grep/find/tail/head/echo）+ 四个控制操作符 | 完整 `if`/`for`/`while`/`until`/`case`/函数/变量与参数扩展/glob/管道/重定向 |
  | 依赖   | **零依赖**，随 `@runko/sdk` 一起装                           | 含 sql.js / quickjs-emscripten 等 wasm 大件，**需显式安装**                 |
  | 定位   | 安全默认、测试与演示载体                                     | Claude 系模型高频产出的控制流脚本撑不住时换这档                             |

  真实命令执行是第三个选项（`@runko/core` 的 `localExec`，或宿主自己的沙盒实现），
  不在这两个包里。

### Patch Changes

- Updated dependencies [847222d]
- Updated dependencies [be08aac]
- Updated dependencies [fca6c03]
- Updated dependencies [b342e5b]
- Updated dependencies [3ffdf28]
- Updated dependencies [fca6c03]
  - @runko/core@0.1.0
