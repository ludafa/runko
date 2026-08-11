/**
 * 类型对照测试（typecheck-only）：证明真实 `e2b` `Sandbox` 结构性满足手写的
 * `E2bSandboxLike`（docs/host/sandbox/tech.md §8.1 依赖策略）。刻意不叫 `*.test.ts`——vitest 的
 * `include: ["test/**\/*.test.ts"]` 不会收集它当运行时用例（这里没有任何
 * `it()`/`expect()`），但它落在 `tsconfig.json` 的 `include: ["test/**\/*.ts"]`
 * 范围内，`pnpm typecheck` 仍会编译到它——编译通过即证明成立，不需要运行。
 *
 * `import type { Sandbox } from "e2b"` 只出现在这一个文件里，且只是
 * `import type`（不产生运行时依赖）——src 里连这一行都没有，`e2b` 全程只是
 * devDependency。
 */
import type { Sandbox } from "e2b";
import type { E2bSandboxLike } from "../src/index.js";

declare const real: Sandbox;

function accepts(sandbox: E2bSandboxLike): void {
  void sandbox;
}

// 编译通过即断言成立：真实 Sandbox 无需任何 `as` 转换即可赋给 E2bSandboxLike。
accepts(real);
