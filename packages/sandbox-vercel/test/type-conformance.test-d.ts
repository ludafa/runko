/**
 * 类型对照测试（typecheck-only，不参与 `vitest run`——文件名故意用
 * `.test-d.ts` 而非 `.test.ts`，vitest 的 `test/**\/*.test.ts` include 不会
 * 收集它，只有 `pnpm typecheck` 会编译到它）。
 *
 * `import type { Sandbox } from "@vercel/sandbox"` 是本包唯一出现
 * `@vercel/sandbox` 的地方（devDependency，仅类型对照用，docs/06 §8.1）：
 * 把一个真实 `Sandbox` 实例赋给 `VercelSandboxLike` 形参，验证我们手写的结构
 * 化子集接口没有跟真实 d.ts 漂移——赋值本身就是断言（编译不过 = 接口面
 * 需要缩小/调整），不需要 `as`/非空断言。
 */
import type { Sandbox } from "@vercel/sandbox";
import type { VercelSandboxLike } from "../src/types.js";

declare const real: Sandbox;

function acceptsVercelSandboxLike(_sandbox: VercelSandboxLike): void {}

acceptsVercelSandboxLike(real);
