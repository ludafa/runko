/**
 * `@runko/sandbox-vercel` 公共入口（docs/tech/core-sdk.md §4.5a "模式 A 同源工作区" / docs/06
 * §8.2 Vercel 小节）：`vercelWorkspace(sandbox, opts?)` 把一个已创建的 Vercel
 * Sandbox 实例（BYO——本包不负责创建/销毁）包成 `RunkoFS & RunkoExec`，一次注入
 * `createSession(agent, { workspace })`。
 *
 * `@vercel/sandbox` 只是 devDependency（类型对照用，见
 * `test/type-conformance.test-d.ts`）——本包运行时零 import 它，工厂函数收
 * 结构化接口 `VercelSandboxLike` 而非具体类（docs/tech/sandbox.md §8.1）。
 */
import type { RunkoActivityAware, RunkoExec, RunkoFS, RunkoKeepAliveCapable } from "@runko/core";
import { createVercelExec } from "./exec.js";
import { createVercelFs } from "./fs.js";
import { createVercelKeepAlive } from "./keepalive.js";
import { DEFAULT_ROOT, type VercelSandboxLike, type VercelWorkspaceOptions } from "./types.js";

/** `vercelWorkspace()` 的返回形状：工作区两面 + 两个可选的保活面（只在开了 `keepAlive` 时真的存在）。 */
export type VercelWorkspace = RunkoFS & RunkoExec & RunkoActivityAware & RunkoKeepAliveCapable;

export function vercelWorkspace(sandbox: VercelSandboxLike, opts: VercelWorkspaceOptions = {}): VercelWorkspace {
  const root = opts.root ?? DEFAULT_ROOT;
  const keepAlive = createVercelKeepAlive(sandbox, opts.keepAlive);
  const workspace: VercelWorkspace = {
    ...createVercelFs(sandbox, root),
    ...createVercelExec(sandbox, root, keepAlive),
  };
  // 没开保活就不挂这两个方法——core 的结构探测因此找不到 `onActivity`，整段跳过。
  if (keepAlive !== undefined) {
    workspace.onActivity = (signal) => keepAlive.onActivity(signal);
    workspace.keepAlive = (targetMs) => keepAlive.keepAlive(targetMs);
  }
  return workspace;
}

export { KEEPALIVE_UNSUPPORTED_MESSAGE, extensionFor } from "./keepalive.js";

export type {
  VercelSandboxLike,
  VercelWorkspaceOptions,
  VercelFileSystemLike,
  VercelDirentLike,
  VercelStatsLike,
  VercelRunCommandParams,
  VercelCommandResultLike,
} from "./types.js";
