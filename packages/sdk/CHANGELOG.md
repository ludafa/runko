# @runko/sdk

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
  - @runko/mini-bash@0.1.2
  - @runko/virtual-fs@0.1.2

## 0.1.1

### Patch Changes

- c29a6eb: 补上 `repository` 字段，指向 https://github.com/ludafa/runko。

  npm 包页面此前没有任何指向源码的链接（0.1.0 首发时漏了这个字段）。现在每个包都带上仓库地址与自己在
  monorepo 里的子目录（`directory`），npm 上的「Repository」入口会直接落到该包的源码目录，而不是仓库根。

- Updated dependencies [c29a6eb]
  - @runko/core@0.1.1
  - @runko/mini-bash@0.1.1
  - @runko/virtual-fs@0.1.1

## 0.1.0

### Minor Changes

- 首发：runko 的主包（门面）。

  batteries-included——re-export `@runko/core` / `@runko/virtual-fs` / `@runko/mini-bash`
  的全部 API，**5 行上手只装这一个**：

  ```sh
  pnpm add @runko/sdk ai        # ai@^7 是 peerDependency，跟随宿主版本
  ```

  本包**只做门面，不放实现**——需要单独装某个子包（比如只要文件沙盒、不要 agent loop）
  也是合法用法。全语法档 bash（`@runko/just-bash`）因为依赖树含 wasm 大件，不在门面里，
  要显式装。

### Patch Changes

- Updated dependencies [847222d]
- Updated dependencies [be08aac]
- Updated dependencies
- Updated dependencies [fca6c03]
- Updated dependencies [b342e5b]
- Updated dependencies [3ffdf28]
- Updated dependencies [fca6c03]
- Updated dependencies
  - @runko/core@0.1.0
  - @runko/mini-bash@0.1.0
  - @runko/virtual-fs@0.1.0
