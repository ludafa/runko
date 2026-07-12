/**
 * `cd [dir]`：改变"当前生效工作目录"。本命令自身只做 `stat()` 校验（零写
 * 操作，与全只读性质和 `defaultApproval: "never"` 自洽），不直接触碰任何
 * 持久状态——成功时把新 cwd 通过 `CommandResult.cwd` 报给调用方，是否/
 * 如何传播（同一 exec() 调用内链间穿透、管道内 POSIX 子 shell 语义不传播、
 * 跨 exec() 调用持久化）完全由 exec.ts 的 runPipeline/runChain/exec() 决定，
 * 见该文件顶部注释。不支持 `cd -`（无上一个目录可回退）、`~`、环境变量
 * 展开——这些字符按字面路径段处理，未创建同名目录时会落到"不存在"分支。
 */
import { resolvePath } from "../path.js";
import { statSafe } from "./shared.js";
import type { CommandFn } from "./types.js";

export const cd: CommandFn = async (args, ctx) => {
  if (args.length > 1) {
    return { stdout: "", stderr: "cd: too many arguments\n", exitCode: 1 };
  }

  const first = args[0];
  if (first === "-") {
    return { stdout: "", stderr: "cd: cd -: not supported (no previous-directory tracking)\n", exitCode: 1 };
  }

  const target = first ?? "/";
  const path = resolvePath(ctx.cwd, target);
  const stat = await statSafe(ctx.fs, path);
  if (stat === undefined) {
    return { stdout: "", stderr: `cd: ${target}: No such file or directory\n`, exitCode: 1 };
  }
  if (stat.type !== "dir") {
    return { stdout: "", stderr: `cd: ${target}: Not a directory\n`, exitCode: 1 };
  }
  return { stdout: "", stderr: "", exitCode: 0, cwd: path };
};
