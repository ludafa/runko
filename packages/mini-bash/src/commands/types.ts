import type { RunkoFS } from "@runko/core";

/** 单条管道阶段执行时可见的环境：注入的 fs、已解析的 cwd、上一阶段的 stdout（首阶段为 undefined）。 */
export interface CommandContext {
  fs: RunkoFS;
  cwd: string;
  stdin: string | undefined;
  signal: AbortSignal;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /**
   * 仅 `cd` 在成功切换目录时设置，把新 cwd 报给调用方（其余七个命令永远不
   * 设置这个字段）。是否/如何据此传播——链内穿透、管道内 POSIX 子 shell
   * 语义（不传播）、跨 exec() 调用持久化——完全由 exec.ts 的
   * runPipeline/runChain/exec() 决定，cd 本身不关心传播规则。
   */
  cwd?: string;
}

export type CommandFn = (args: string[], ctx: CommandContext) => Promise<CommandResult>;
