# @runko/sdk

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
