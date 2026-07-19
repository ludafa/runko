/**
 * `buildSession` (docs/tech/chat-webapp.md §2.2 `chat-agent.ts`): loads
 * the frontend-design skill straight from the sandbox's filesystem
 * (`Skill.fromFS`, same as
 * examples/src/12-vercel-sandbox-real-project.ts), builds instructions
 * with owner/repo/branch/defaultBranch baked in (the model is never asked to
 * guess them — same discipline as example 12's `buildInstructions`), and
 * hands the whole thing to `@nimbo/sdk`'s `createSession` — **not**
 * `@nimbo/core`'s: only the sdk facade's version bundles the eight-piece
 * file-tool default assembly (read-file/write-file/edit-file/...) around
 * whatever `workspace` it's given, which is what actually lets the agent
 * edit the sandbox's checked-out repo.
 *
 * Called fresh on every turn (every `POST .../messages`, per docs/tech/chat-webapp.md §2.2) —
 * there is no long-lived in-memory `Session` object across requests; message
 * history round-trips through `conversation_events`'s `kind = 'message'` rows +
 * `conversations`'s `nimbo*` scalar header (docs/tech/single-ledger.md
 * §5 单-3, `store.ts`'s `loadResumeState`/`Session.toJSON()`/`resume`), while
 * the sandbox's filesystem (including any uncommitted edits on the session
 * branch) round-trips separately via the Vercel snapshot
 * (`sandbox-manager.ts`) — docs/tech/chat-webapp.md §2.2's "持久化恢复语义" note.
 */
import type {
  ApprovalPolicy,
  ApprovalReviewer,
  NimboExec,
  NimboFS,
  Session,
  SessionState,
  SessionTelemetry,
  Tool,
} from '@nimbo/sdk';
import { createSession, defineAgent, defineTool, Skill } from '@nimbo/sdk';
import type { LanguageModel } from 'ai';
import { z } from 'zod';

import type { ChatApprovalMode } from './approval-policy.js';
import type { AskUserOutcome, RequestUserAnswerInput } from './turn-runner.js';

const FRONTEND_DESIGN_SKILL_PATH = '/.agents/skills/frontend-design';

export interface BuildSessionOptions {
  model: LanguageModel;
  workspace: NimboFS & NimboExec;
  repoOwner: string;
  repoName: string;
  defaultBranch: string;
  branchName: string;
  resume?: SessionState;
  /** `routes/chat.ts`'s approval bridge (docs/tech/chat-webapp.md §2.2c（审批链）, docs/tech/single-ledger.md §6.2) — the session-level 审批分类器 (`packages/core/src/approval.ts`'s `evaluateApproval`), a three-value `ApprovalOutcome` classifier. Passing one when `approvalMode` is `'off'` has no effect either way, since the workspace isn't gated in that mode (see `gateWorkspace`) — nothing ever escalates to it. */
  onApproval?: ApprovalPolicy;
  /** `routes/chat.ts`'s 人审通道 (docs/tech/single-ledger.md §6.4 `ApprovalReviewer`) — `@nimbo/core`'s loop `await`s this only after it has already yielded a `tool-approval-request` chunk for a `'review'`-classified call. Independent of `onApproval`: the classifier decides *whether* a human is needed; this is *how* the human's decision actually arrives. */
  onReview?: ApprovalReviewer;
  /** Defaults to `'dangerous'` (`approval-policy.ts`'s own default) — controls whether/how the workspace's `bash` tool is gated, not what the model is allowed to do overall. */
  approvalMode?: ChatApprovalMode;
  /** `routes/chat.ts`'s ask-user bridge (docs/tech/chat-webapp.md §2.2c（审批链）), wired to `turn-runner.ts`'s `requestUserAnswer` — registers the `ask-user` tool (see `createAskUserTool`) when present. Independent of `approvalMode`: `ask-user` is a product capability, not a safety gate, so it's registered the same way regardless of mode (including `'off'`). */
  onAskUser?: (req: RequestUserAnswerInput) => Promise<AskUserOutcome>;
  /** telemetry 事件集成透传（`@nimbo/core` 的 `SessionTelemetry`，docs/tech/chat-webapp.md §11.4）——生产由 `src/telemetry.ts` 的 SQLite 集成供给（routes 经 deps 注入），测试注入假集成或不传。 */
  telemetry?: SessionTelemetry;
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
- 每次回复如实说明这一轮做了什么、为什么这么做，或者为什么这一轮没有改动代码——不要夸大、不要编造未发生的操作结果。
- 当你需要用户做决定或澄清需求时，用 ask-user 工具直接提问，不要在回复文本里空等。`;
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
function gateWorkspace(workspace: NimboFS & NimboExec): NimboFS & NimboExec {
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

const askUserInputSchema = z.object({
  question: z.string().min(1),
  options: z.array(z.string()).optional(),
});

/** `requestUserAnswer`'s own timeout (`turn-runner.ts`) surfaces as this outcome — a normal tool result (`status: "completed"`, not a thrown error), so the model can react instead of the turn just dying. */
const ASK_USER_TIMEOUT_MESSAGE =
  'The user did not respond within the time limit. Proceed with your best judgment, or ask again later.';

/**
 * `ask-user` (docs/tech/chat-webapp.md §2.2c（审批链）): registered only when `opts.onAskUser`
 * is supplied (see `buildSession`) — same conditional-registration shape as
 * `load-skill`/`bash`, just driven by an option instead of `agent.skills`/
 * `exec`. No `approval` set: asking the user *is* the human-in-the-loop step
 * here, there's nothing left to gate on top of it.
 */
function createAskUserTool(
  onAskUser: (req: RequestUserAnswerInput) => Promise<AskUserOutcome>,
): Tool {
  return defineTool({
    description:
      'Ask the user a question and wait for their answer. Use this when you need the user to make a decision, ' +
      'clarify a requirement, or choose between multiple options — not to request approval to run a command ' +
      '(the approval chain handles that automatically; you never need to ask for it yourself). `options`, if ' +
      'given, are quick-reply suggestions shown to the user — they can still answer freely instead of picking one.',
    inputSchema: askUserInputSchema,
    execute: async (input, ctx) => {
      const outcome = await onAskUser({
        callId: ctx.callId,
        question: input.question,
        ...(input.options !== undefined ? { options: input.options } : {}),
      });
      return outcome.outcome === 'answered' ?
          outcome.answer
        : ASK_USER_TIMEOUT_MESSAGE;
    },
  });
}

/**
 * Builds a fresh nimbo `Session` for one turn: loads the skill, defines the
 * agent, and (re)creates the session — restoring message history from
 * `opts.resume` when this is a returning chat session.
 *
 * `approvalMode` (docs/tech/chat-webapp.md §2.2c（审批链）) gates the workspace (see
 * `gateWorkspace`) for every mode except `'off'`, which passes `opts.workspace`
 * straight through unchanged — zero behavior change from before this bridge
 * existed. `onApproval`/`onReview` are otherwise passed through as-is
 * regardless of mode; in `'off'` mode neither ever gets called (nothing ever
 * escalates to them). `onAskUser` (also docs/tech/chat-webapp.md §2.2c（审批链）) registers
 * `ask-user` independent of `approvalMode` — see
 * `BuildSessionOptions.onAskUser`'s own doc comment.
 */
export async function buildSession(
  opts: BuildSessionOptions,
): Promise<Session<NimboFS & NimboExec>> {
  const skill = await Skill.fromFS(opts.workspace, FRONTEND_DESIGN_SKILL_PATH);
  const agent = defineAgent({
    model: opts.model,
    skills: [skill],
    instructions: buildInstructions(opts),
    ...(opts.onAskUser !== undefined ?
      { tools: { 'ask-user': createAskUserTool(opts.onAskUser) } }
    : {}),
  });
  const approvalMode = opts.approvalMode ?? 'dangerous';
  const workspace =
    approvalMode === 'off' ? opts.workspace : gateWorkspace(opts.workspace);
  return createSession(agent, {
    workspace,
    ...(opts.resume !== undefined ? { resume: opts.resume } : {}),
    ...(opts.onApproval !== undefined ? { onApproval: opts.onApproval } : {}),
    ...(opts.onReview !== undefined ? { onReview: opts.onReview } : {}),
    ...(opts.telemetry !== undefined ? { telemetry: opts.telemetry } : {}),
  });
}
