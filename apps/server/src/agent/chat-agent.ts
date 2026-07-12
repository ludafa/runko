/**
 * `buildSession` (docs/08-chat-agent-webapp.md §2.2 `chat-agent.ts`): loads
 * the frontend-design skill straight from the sandbox's filesystem
 * (`Skill.fromFS`, same as
 * examples/12-vercel-sandbox-real-project.e2e.test.ts), builds instructions
 * with owner/repo/branch/defaultBranch baked in (the model is never asked to
 * guess them — same discipline as example 12's `buildInstructions`), and
 * hands the whole thing to `@nimbo/sdk`'s `createSession` — **not**
 * `@nimbo/core`'s: only the sdk facade's version bundles the eight-piece
 * file-tool default assembly (read_file/write_file/edit_file/...) around
 * whatever `workspace` it's given, which is what actually lets the agent
 * edit the sandbox's checked-out repo.
 *
 * Called fresh on every turn (every `POST .../messages`, per docs/08 §2.2) —
 * there is no long-lived in-memory `Session` object across requests; message
 * history round-trips through `chat_sessions.nimbo_state_json`
 * (`Session.toJSON()`/`resume`), while the sandbox's filesystem (including
 * any uncommitted edits on the session branch) round-trips separately via
 * the Vercel snapshot (`sandbox-manager.ts`) — docs/08 §2.2's "持久化恢复语义"
 * note.
 */
import type { NimboExec, NimboFS, Session, SessionState } from '@nimbo/sdk';
import { createSession, defineAgent, Skill } from '@nimbo/sdk';
import type { LanguageModel } from 'ai';

const FRONTEND_DESIGN_SKILL_PATH = '/.agents/skills/frontend-design';

export interface BuildSessionOptions {
  model: LanguageModel;
  workspace: NimboFS & NimboExec;
  repoOwner: string;
  repoName: string;
  defaultBranch: string;
  branchName: string;
  resume?: SessionState;
}

/**
 * Chinese instructions (this repo's convention for task-facing prose, same
 * as example 12): the session's working branch is pinned to `branchName`
 * across every turn (checked out once by `sandbox-manager.ts`, never
 * switched again), and the agent is told explicitly not to touch the repo
 * unless the user's *current* message actually asks for a code change —
 * multi-turn chat means most turns are just questions/discussion.
 */
function buildInstructions(opts: {
  repoOwner: string;
  repoName: string;
  defaultBranch: string;
  branchName: string;
}): string {
  const { repoOwner, repoName, defaultBranch, branchName } = opts;
  return `你在一个已经 clone 好用户仓库 ${repoOwner}/${repoName}（默认分支 ${defaultBranch}）的 Vercel Sandbox 里工作，仓库根目录就是你的工作区根目录 "/"。你正在一段持续的多轮对话中协助用户维护这个仓库：

- 本次会话固定使用工作分支 "${branchName}"（已经为你 checkout 好，之后每一轮都请继续在这个分支上工作，不要切换到其他分支，也不要自己新建分支）。
- 之前几轮的改动（包括尚未 commit/push 的）仍然保留在工作区里，跨轮累积；除非用户明确要求撤销，否则不要丢弃它们。
- **如果用户这条消息没有明确要求你修改代码或文件**（只是提问、请你解释、请你规划），就只读、不要写：不要主动改动任何文件，不要 git add/commit/push，除非用户明确要求。
- 只有当用户明确要求提交/推送/开 PR 时，才执行 git 操作；push 前确保当前分支就是 "${branchName}"；开 PR 时用 curl 调 GitHub REST API（\`$GH_TOKEN\` 已是沙盒环境变量，直接引用，不要猜测、复述或打印它的值），head 用 "${branchName}"，base 用 "${defaultBranch}"。
- 开 PR 前要先检查一下之前的 PR 是否已经被合入：若已合入，请新开个 PR。
- 每次回复如实说明这一轮做了什么、为什么这么做，或者为什么这一轮没有改动代码——不要夸大、不要编造未发生的操作结果。`;
}

/**
 * Builds a fresh nimbo `Session` for one turn: loads the skill, defines the
 * agent, and (re)creates the session — restoring message history from
 * `opts.resume` when this is a returning chat session.
 */
export async function buildSession(
  opts: BuildSessionOptions,
): Promise<Session<NimboFS & NimboExec>> {
  const skill = await Skill.fromFS(opts.workspace, FRONTEND_DESIGN_SKILL_PATH);
  const agent = defineAgent({
    model: opts.model,
    skills: [skill],
    instructions: buildInstructions(opts),
  });
  return createSession(agent, {
    workspace: opts.workspace,
    ...(opts.resume !== undefined ? { resume: opts.resume } : {}),
  });
}
