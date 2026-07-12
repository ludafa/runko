/**
 * @nimbo/sandbox-e2b 公共入口（docs/06 §8.2）：`e2bWorkspace(sandbox, opts?)`
 * 把一个 BYO 的 e2b 沙盒包成 `NimboFS & NimboExec`；`E2bSandboxLike` 是它接受
 * 的结构化最小接口（`e2b` 只作类型对照依赖，见 `types.ts` 头注释与
 * `test/type-conformance.ts`），不在此包运行时 import "e2b"。
 */
export { e2bWorkspace } from "./workspace.js";
export type { E2bWorkspaceOptions } from "./workspace.js";
export type {
  E2bCommandResult,
  E2bCommandRunOpts,
  E2bCommandsLike,
  E2bEntryInfo,
  E2bFilesystemLike,
  E2bFilesystemListOpts,
  E2bSandboxLike,
  E2bWriteInfo,
} from "./types.js";
