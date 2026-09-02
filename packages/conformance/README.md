# @runko/conformance

**runko 宿主能力的契约一致性套件。** 写了一个[持久化](../../docs/host/contract/features/persistence.md)或[归属仲裁机制](../../docs/logic/arbitration/features/arbitration-impl.md)的实现，拿它验合不合契约。

接口注释里写死了一堆承诺——「同一个 seq 重复写入不得写出两行」「`settle` 对已结清的返回 `false` 而不是抛」「取号一律不抛错」——这个包把它们变成**可执行的断言**。runko 自己的五个官方实现跑的就是这一份。

## 它不依赖任何测试框架

套件只导出**用例数据**（`{ name, run }`），`describe` / `it` 由你来接。所以 vitest / jest / node:test / Workers 上都能跑，装它也不会把某个测试框架拖进你的依赖树。

```sh
pnpm add -D @runko/conformance
```

```ts
import { persistenceCases } from "@runko/conformance";
import { describe, it } from "vitest";

describe("我自己的持久化实现", () => {
  for (const testCase of persistenceCases) {
    it(testCase.name, async () => {
      const setup = { persistence: myPersistence(), cleanup: () => myTeardown() };
      try {
        await testCase.run(setup);
      } finally {
        await setup.cleanup();
      }
    });
  }
});
```

每条用例都要一份**干净的**实现（空库 / 新实例），所以 `makeSetup` 放在 `it` 里面调，不要放在外面共用一个。

## 三组归属仲裁用例，按能力分开接

归属仲裁的实现能力不一样：内存版就在一个进程里，没有第二个节点、也没有「心跳超时」这回事；租约版才有。所以用例**分三个数组**，不是一个数组配可选字段——后者会让一个本该支持接管的实现漏传 `expire` 时**静默跳过**那几条还显示绿。

| 导出 | 谁跑 | 需要的 setup |
| --- | --- | --- |
| `arbitrationCases` | 所有实现 | `{ arbitration }` |
| `arbitrationMultiNodeCases` | 能表达两个节点的 | `+ other` |
| `arbitrationTakeoverCases` | 能表达超时接管的 | `+ expire` |

```ts
import { arbitrationCases, arbitrationTakeoverCases } from "@runko/conformance";
```

跑了哪几组写在你自己的代码里，一眼可查。（三个数组之间没有类型绑定——少接一组编译照过，这条靠代码评审守。）

**`expire` 要让持有者「持续」看起来死了。** 只把心跳时刻拨到过去是不够的：持有者还活着，它下一拍心跳就把时刻刷回来了，接管会随机失败。要么让持有者那一侧的时钟停在过去，要么真的把它的心跳停掉。

## 断言失败长什么样

套件自带一套手写断言（连 `node:assert` 都不用，才能在任何环境里跑）。失败时抛 `ConformanceAssertionError`，带上 `expected` / `actual`，测试框架的 diff 视图直接能用：

```
ConformanceAssertionError: 结构不相等
  期望: {"ok":true,"seq":3}
  实际: {"ok":true,"seq":1}
```

## 文档

[持久化 · 功能手册](../../docs/host/contract/features/persistence.md) ·
[持久化 · 技术方案](../../docs/host/contract/tech/persistence.md) ·
[归属仲裁 · 技术方案](../../docs/logic/arbitration/tech/arbitration-impl.md)
