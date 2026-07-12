/**
 * `e2bWorkspace(sandbox, opts?)`：把一个已创建好的 e2b 沙盒包成
 * `NimboFS & NimboExec`，供 `createSession(agent, { workspace })` 一次注入
 * （tech-spec §4.5a 模式 A；docs/06 §5.2/§8.2）。
 *
 * BYO 实例是唯一入口：本函数不创建、不销毁沙盒——沙盒的生命周期（创建、
 * 超时延长、暂停/恢复）完全由宿主自己管理，`e2bWorkspace()` 只是给一个已经
 * 存在的沙盒包一层 NimboFS/NimboExec 的视图（docs/06 §5.2 "nimbo 不关心沙盒
 * 长什么样"）。
 */
import type { NimboExec, NimboFS } from "@nimbo/core";
import { createE2bExec } from "./exec.js";
import { createE2bFs } from "./fs.js";
import { createPathAnchor } from "./path.js";
import type { E2bSandboxLike } from "./types.js";

/** e2b 官方模板默认的登录用户主目录——多数模板下也是命令的默认 cwd。 */
const DEFAULT_ROOT = "/home/user";

export interface E2bWorkspaceOptions {
  /** 沙盒内锚定虚拟根 `/` 的真实目录，默认 `/home/user`。 */
  root?: string;
}

export function e2bWorkspace(sandbox: E2bSandboxLike, opts: E2bWorkspaceOptions = {}): NimboFS & NimboExec {
  const anchor = createPathAnchor(opts.root ?? DEFAULT_ROOT);
  return {
    ...createE2bFs(sandbox, anchor),
    ...createE2bExec(sandbox, anchor),
  };
}
