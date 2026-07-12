/**
 * 类型对照（typecheck-only——没有 describe/it，不在 `vitest run` 里执行，只走
 * `tsc --noEmit`）：验证手写的 `CfSandboxLike`（worker.ts）与 `@cloudflare/sandbox`
 * 真实 `ISandbox` 之间的赋值兼容性。`declare const` + 直接赋值，编译器拒绝就是两者
 * 结构不匹配的真实信号——不用 `as` 掩盖，真出问题就该在这里暴露。
 */
import type { ISandbox } from "@cloudflare/sandbox";
import type { CfSandboxLike } from "../src/worker.js";

declare const realSandbox: ISandbox;
const asCfSandboxLike: CfSandboxLike = realSandbox;
void asCfSandboxLike;
