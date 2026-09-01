/**
 * chat 应用为**每一轮**贡献的那两块 agent 装配：系统提示词（`buildInstructions`）与
 * 「把 bash 卡进[审批链](../../../../docs/terms.md)」的工作区包装（`gateWorkspace`）。
 *
 * 建 `Session` 这件事已经不在这里了——它归 `@nimbo/agent` 的[轮编排](../../../../docs/terms.md)
 * （框架要读[账本](../../../../docs/terms.md)重建 `SessionState`、要注入自己的
 * [人审通道](../../../../docs/terms.md)，这些 chat 层都不该碰）。本文件因此只剩两个纯函数，
 * 由 `runtime.ts` 的 `prepareTurn` 调用。
 */
import type { NimboExec, NimboFS } from '@nimbo/core';

/**
 * Chinese instructions (this repo's convention for task-facing prose, same
 * as example 12): the session's working branch is pinned to `branchName`
 * across every turn (checked out once by `sandbox-manager.ts`, never
 * switched again), and the agent is told explicitly not to touch the repo
 * unless the user's *current* message actually asks for a code change —
 * multi-turn chat means most turns are just questions/discussion.
 */
export function buildInstructions(opts: {
  repoOwner: string;
  repoName: string;
  defaultBranch: string;
  branchName: string;
  /** `web-search` 是否注册进了工具表——没注册就不提它，免得指令让模型去找一个不存在的工具（docs/tech/web-search.md §5）。 */
  hasWebSearch: boolean;
}): string {
  const { repoOwner, repoName, defaultBranch, branchName } = opts;
  const webSearchLine =
    opts.hasWebSearch ?
      `
- 遇到你不确定、或可能已经过时的外部信息（某个库的最新用法/版本、陌生的报错、时效性事实），先用 web-search 工具查一遍再动手，不要凭记忆猜；引用结论时带上来源网址。`
    : '';
  return `你在一个已经 clone 好用户仓库 ${repoOwner}/${repoName}（默认分支 ${defaultBranch}）的 Vercel Sandbox 里工作，仓库根目录就是你的工作区根目录 "/"。你正在一段持续的多轮对话中协助用户维护这个仓库：

- 本次会话固定使用工作分支 "${branchName}"（已经为你 checkout 好，之后每一轮都请继续在这个分支上工作，不要切换到其他分支，也不要自己新建分支）。
- 之前几轮的改动（包括尚未 commit/push 的）仍然保留在工作区里，跨轮累积；除非用户明确要求撤销，否则不要丢弃它们。
- **如果用户这条消息没有明确要求你修改代码或文件**（只是提问、请你解释、请你规划），就只读、不要写：不要主动改动任何文件，不要 git add/commit/push，除非用户明确要求。
- 只有当用户明确要求提交/推送/开 PR 时，才执行 git 操作；push 前确保当前分支就是 "${branchName}"；开 PR 时用 curl 调 GitHub REST API（\`$GH_TOKEN\` 已是沙盒环境变量，直接引用，不要猜测、复述或打印它的值），head 用 "${branchName}"，base 用 "${defaultBranch}"。
- 开 PR 前要先检查一下之前的 PR 是否已经被合入：若已合入，请新开个 PR。
- 每次回复如实说明这一轮做了什么、为什么这么做，或者为什么这一轮没有改动代码——不要夸大、不要编造未发生的操作结果。
- 当你需要用户做决定或澄清需求时，用 ask-user 工具直接提问，不要在回复文本里空等。${webSearchLine}`;
}

/**
 * Forces `workspace`'s `bash` tool to always require approval (docs/tech/chat-webapp.md §2.2c
 * （审批链）, docs/tech/single-ledger.md §6.4): `createBashTool` (packages/core/src/tools/builtin/bash.ts)
 * picks its per-tool `ApprovalPolicy` from `exec.defaultApproval`, and the
 * Vercel sandbox's own `NimboExec` implementation declares `"allow"` there
 * (it has no notion of a human in the loop) — left as-is, every bash command
 * would run unattended regardless of `approvalMode`. Overriding it to
 * `"review"` is what actually makes `packages/core/src/approval.ts`'s
 * evaluation chain classify every call as needing a human, escalating to the
 * session's `onApproval` classifier (and, once that also says `'review'`, to
 * `onReview`'s 人审通道) instead of executing straight away.
 *
 * Explicit per-method delegation, not `{ ...workspace, defaultApproval: 'review' }`:
 * `workspace` here is a real object (the Vercel sandbox's own workspace, or a
 * `MemoryFS`-backed fake in tests) whose methods live on its prototype chain
 * — a shallow object spread only copies *own* enumerable properties, which
 * for a class instance is none of its methods, silently producing an object
 * with `undefined` where every `NimboFS`/`NimboExec` method should be.
 *
 * 显式逐方法转发的对价：`NimboFS` 的**可选能力方法**（`searchFiles`/
 * `searchContent`，原生搜索快路径——docs/tech/builtin-tools.md §3.7/§3.8）也必须
 * 在这里显式跟上，否则会被这层包装静默剥掉、grep/glob 永远走 JS 逐文件回退
 * （在远端沙盒上是每文件一次网络往返的慢路径）——这正是 2026-07-16 线上
 * "grep 依旧十几秒"的事故根因。往 `NimboFS` 再加可选方法时，这里要同步。
 */
export function gateWorkspace(
  workspace: NimboFS & NimboExec,
): NimboFS & NimboExec {
  const describe = workspace.describe?.bind(workspace);
  const searchFiles = workspace.searchFiles?.bind(workspace);
  const searchContent = workspace.searchContent?.bind(workspace);
  return {
    readFile: (path) => workspace.readFile(path),
    writeFile: (path, data) => workspace.writeFile(path, data),
    rm: (path, opts) => workspace.rm(path, opts),
    mkdir: (path) => workspace.mkdir(path),
    readdir: (path) => workspace.readdir(path),
    stat: (path) => workspace.stat(path),
    glob: (pattern) => workspace.glob(pattern),
    exec: (req, opts) => workspace.exec(req, opts),
    ...(describe !== undefined ? { describe } : {}),
    ...(searchFiles !== undefined ? { searchFiles } : {}),
    ...(searchContent !== undefined ? { searchContent } : {}),
    defaultApproval: 'review',
  };
}
