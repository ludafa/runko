/**
 * `@nimbo/sandbox-vercel` 公共入口（tech-spec §4.5a "模式 A 同源工作区" / docs/06
 * §8.2 Vercel 小节）：`vercelWorkspace(sandbox, opts?)` 把一个已创建的 Vercel
 * Sandbox 实例（BYO——本包不负责创建/销毁）包成 `NimboFS & NimboExec`，一次注入
 * `createSession(agent, { workspace })`。
 *
 * `@vercel/sandbox` 只是 devDependency（类型对照用，见
 * `test/type-conformance.test-d.ts`）——本包运行时零 import 它，工厂函数收
 * 结构化接口 `VercelSandboxLike` 而非具体类（docs/06 §8.1）。
 */
import type { NimboExec, NimboFS } from "@nimbo/core";
import { createVercelExec } from "./exec.js";
import { createVercelFs } from "./fs.js";
import { DEFAULT_ROOT, type VercelSandboxLike, type VercelWorkspaceOptions } from "./types.js";

export function vercelWorkspace(sandbox: VercelSandboxLike, opts: VercelWorkspaceOptions = {}): NimboFS & NimboExec {
  const root = opts.root ?? DEFAULT_ROOT;
  return {
    ...createVercelFs(sandbox, root),
    ...createVercelExec(sandbox, root),
  };
}

export type {
  VercelSandboxLike,
  VercelWorkspaceOptions,
  VercelFileSystemLike,
  VercelDirentLike,
  VercelStatsLike,
  VercelRunCommandParams,
  VercelCommandResultLike,
} from "./types.js";
