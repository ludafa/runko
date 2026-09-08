# @runko/conformance

## 0.1.1

### Patch Changes

- c29a6eb: 补上 `repository` 字段，指向 https://github.com/ludafa/runko。

  npm 包页面此前没有任何指向源码的链接（0.1.0 首发时漏了这个字段）。现在每个包都带上仓库地址与自己在
  monorepo 里的子目录（`directory`），npm 上的「Repository」入口会直接落到该包的源码目录，而不是仓库根。

- Updated dependencies [c29a6eb]
  - @runko/agent@0.1.1

## 0.1.0

### Minor Changes

- 48b461b: **新包 `@runko/conformance`：宿主能力的契约一致性套件。** 写了一个 `Persistence` 或
  `Arbitration` 实现，装上它就能验合不合契约——接口注释里那些写死了却从没验过的承诺
  （同一个 seq 重复写入不得写出两行、`settle` 对已结清的返回 `false` 而不是抛、取号一律
  不抛错……）全部变成可执行断言。runko 自己的五个官方持久化实现跑的就是这一份。

  **它不依赖任何测试框架。** 套件只导出**用例数据**（`{ name, run }`），`describe` / `it`
  由消费方来接，所以 vitest / jest / node:test / Workers 上都能跑：

  ```ts
  import { persistenceCases } from "@runko/conformance";

  describe("我自己的实现", () => {
    for (const testCase of persistenceCases) {
      it(testCase.name, async () => {
        await testCase.run({ persistence: myPersistence() });
      });
    }
  });
  ```

  内容：**持久化 31 条**（账本 / 裁决表 / 待发队列 / 跨 Store），**归属仲裁 18 条**，按能力
  分三组导出——`arbitrationCases`（所有实现都要过）、`arbitrationMultiNodeCases`（能表达
  两个节点的）、`arbitrationTakeoverCases`（能表达超时接管的）。分组不是可选字段，是三个
  独立数组：一个本该支持接管的实现漏传 `expire`，不会静默跳过还显示绿。

  **这套东西曾经是 `@runko/agent` 的子路径导出 `@runko/agent/conformance`，现已移除。**
  它需要一套断言，而断言不该把测试框架拖进一个**运行时**包的依赖里——`@runko/agent` 因此
  不再有 `vitest` 这个可选 peer。改用新包即可，用例内容一条没少。

### Patch Changes

- Updated dependencies [51d94e6]
- Updated dependencies [3029ae3]
- Updated dependencies [3029ae3]
- Updated dependencies [3029ae3]
- Updated dependencies [48b461b]
- Updated dependencies [3029ae3]
- Updated dependencies [1282005]
- Updated dependencies [85e5099]
- Updated dependencies [fca6c03]
  - @runko/agent@0.1.0
