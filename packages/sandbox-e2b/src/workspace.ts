/**
 * `e2bWorkspace(sandbox, opts?)`：把一个已创建好的 e2b 沙盒包成
 * `NimboFS & NimboExec`，供 `createSession(agent, { workspace })` 一次注入
 * （docs/core/core-sdk/tech.md §4.5a 模式 A；docs/host/sandbox/tech.md §5.2/§8.2）。
 *
 * BYO 实例是唯一入口：本函数不创建、不销毁沙盒——沙盒的生命周期（创建、
 * 暂停/恢复、销毁）完全由宿主自己管理，`e2bWorkspace()` 只是给一个已经
 * 存在的沙盒包一层 NimboFS/NimboExec 的视图（docs/host/sandbox/tech.md §5.2 "nimbo 不关心沙盒
 * 长什么样"）。
 *
 * **唯一的例外是[保活](../../../docs/terms.md)**（docs/host/sandbox-keepalive/feature.md）：
 * 传了 `opts.keepAlive` 才开，开了之后一轮进行期间会自动续期。这不违反 BYO——
 * 建盒销盒仍归宿主，开不开保活也是宿主一行配置决定的，下沉的只是「续期动作怎么执行」。
 * 不传就一次网络调用都不会发生，行为与没有这个功能时完全一致。
 */
import type { KeepAliveOptions, NimboActivityAware, NimboExec, NimboFS, NimboKeepAliveCapable } from "@nimbo/core";
import { createE2bExec } from "./exec.js";
import { createE2bFs } from "./fs.js";
import { createE2bKeepAlive } from "./keepalive.js";
import { createPathAnchor } from "./path.js";
import type { E2bSandboxLike } from "./types.js";

/** e2b 官方模板默认的登录用户主目录——多数模板下也是命令的默认 cwd。 */
const DEFAULT_ROOT = "/home/user";

export interface E2bWorkspaceOptions {
  /** 沙盒内锚定虚拟根 `/` 的真实目录，默认 `/home/user`。 */
  root?: string;
  /**
   * 开启[保活](../../../docs/terms.md)。**不传 = 不保活**（默认行为不变）。
   *
   * `idleTimeoutMs` 应与建盒时 `Sandbox.create({ timeoutMs })` 的值一致——两处不一致
   * 很难查（比如建盒 5 分钟、这里按 10 分钟补足，就永远补不上去）。
   */
  keepAlive?: KeepAliveOptions;
}

/** `e2bWorkspace()` 的返回形状：工作区两面 + 两个可选的保活面（只在开了 `keepAlive` 时真的存在）。 */
export type E2bWorkspace = NimboFS & NimboExec & NimboActivityAware & NimboKeepAliveCapable;

export function e2bWorkspace(sandbox: E2bSandboxLike, opts: E2bWorkspaceOptions = {}): E2bWorkspace {
  const anchor = createPathAnchor(opts.root ?? DEFAULT_ROOT);
  const keepAlive = createE2bKeepAlive(sandbox, opts.keepAlive);
  const workspace: E2bWorkspace = {
    ...createE2bFs(sandbox, anchor),
    ...createE2bExec(sandbox, anchor, keepAlive),
  };
  // 没开保活就不挂这两个方法——core 的结构探测因此找不到 `onActivity`，整段跳过。
  if (keepAlive !== undefined) {
    workspace.onActivity = (signal) => keepAlive.onActivity(signal);
    workspace.keepAlive = (targetMs) => keepAlive.keepAlive(targetMs);
  }
  return workspace;
}
