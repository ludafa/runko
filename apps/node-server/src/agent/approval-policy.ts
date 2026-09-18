/**
 * chat 这一档的审批策略（docs/ingress/tech/chat-webapp.md §2.2c（审批链）、
 * docs/logic/orchestration/tech/single-ledger.md §6）。
 *
 * 本文件只有**纯函数**：没有 I/O，也不碰运行时那张进程内的轮登记表。
 *
 * `classifyApproval` 只在一个地方接线：`routes/chat.ts` 的 `POST .../messages` 处理器把
 * 它作为会话级的「审批分类器」（`@runko/core` 的 `SessionOptions.onApproval`，即
 * `ApprovalPolicy` 的回调形态）交给 `buildSession`（`chat-agent.ts`）。
 *
 * `classifyApproval(mode, ctx.toolName, input)` 当场判定：这次工具调用是安全到可以无人
 * 值守直接跑（`'allow'`），还是需要人来看一眼（`'review'`）。只有后者，`@runko/core` 的
 * loop 才会升级到会话的人审通道（`onReview`，即 `@runko/agent` 的 `requestReview`），
 * 而且必定是在它已经 yield 过一条 `tool-approval-request` chunk 之后
 * （docs/logic/orchestration/tech/single-ledger.md §6.1）。「让界面看见」这一步与本模块无关。
 *
 * 本模块看不到 `ApprovalContext`/`callId`：那两样只有在请求真要路由给某个挂起的人工裁决
 * 时才有意义，那是 `@runko/agent` 的活。
 *
 * chat 这一档**从不**从这个分类器给出硬 `'deny'`——所有升级都是 `'review'`，最终由人来
 * 决定。
 */
import type { ApprovalOutcome, JsonValue } from '@runko/core';

export type ChatApprovalMode = 'dangerous' | 'all' | 'off';

const APPROVAL_MODES: readonly ChatApprovalMode[] = ['dangerous', 'all', 'off'];

function isChatApprovalMode(value: string): value is ChatApprovalMode {
  return (APPROVAL_MODES as readonly string[]).includes(value);
}

/** 读 `CHAT_APPROVAL_MODE`。认不出来的值（没设、拼错、空串）一律回落到 `'dangerous'`——它是既安全、又还能让日常只读 bash 命令无人值守通过的那个默认档。 */
export function resolveApprovalMode(
  env: NodeJS.ProcessEnv = process.env,
): ChatApprovalMode {
  const raw = env.CHAT_APPROVAL_MODE?.trim();
  return raw !== undefined && isChatApprovalMode(raw) ? raw : 'dangerous';
}

// ---------------------------------------------------------------------------
// 危险清单（`'dangerous'` 档真正的规则集）。
//
// 它是对一条 shell 命令字符串做的**正则层面尽力而为**的静态分析，不是真的 shell 解析
// 器，刻意保守。下面每条规则互相独立，命中任意一条就要求人来看一眼。
//
// 误判（一条安全命令碰巧命中）只是让用户多点一下；漏判会让一条破坏性/外泄数据的命令
// 无人值守地跑掉。所以每条规则都宁可匹配得太宽，也不匹配得太窄。
// ---------------------------------------------------------------------------

/** 任意形态的 `git push`，包含强推（`--force`/`-f`）——只匹配裸的 "push" 就够了，强推本身也是 push。 */
const GIT_PUSH_RE = /\bgit\s+push\b/;

/** `git reset --hard`——不可逆地丢掉工作区改动。 */
const GIT_RESET_HARD_RE = /\bgit\s+reset\b[^\n]*--hard\b/;

/** 带强制标志的 `git clean`（`-f`、`-fd`、`--force` 等）——不可逆地删掉未跟踪文件。 */
const GIT_CLEAN_FORCE_RE =
  /\bgit\s+clean\b[^\n]*(?:-[a-zA-Z]*f[a-zA-Z]*\b|--force\b)/i;

/** 带递归和/或强制标志的 `rm`（`-r`、`-f`、`-rf`、`--recursive`、`--force` 等）——这才是 `rm` 真正有破坏性的形态；裸的 `rm somefile` 不拦。 */
const RM_RECURSIVE_FORCE_RE =
  /\brm\s[^\n]*(?:-[a-zA-Z]*[rRf][a-zA-Z]*\b|--recursive\b|--force\b)/;

/**
 * 引用了 GitHub REST API 域名、或沙盒自己那个 PAT 环境变量（`$GH_TOKEN`）的 `curl`。
 *
 * 这条就是「建 PR 及其同类操作」的路径（`chat-agent.ts` 的提示词里就是这么教模型的）。
 * 静态分析没有可靠办法在这里分辨读（GET）与写（POST/PATCH/DELETE），所以两者一律
 * 走人审——「静态无法区分读写，一律人审」。
 */
function isGithubApiCurl(command: string): boolean {
  if (!/\bcurl\b/.test(command)) {
    return false;
  }
  return /api\.github\.com|\$GH_TOKEN/.test(command);
}

/** 一条 bash `command` 字符串是不是危险到 `'dangerous'` 档也要人来看一眼（docs/ingress/tech/chat-webapp.md §2.2c（审批链））。 */
export function commandNeedsHumanApproval(command: string): boolean {
  return (
    GIT_PUSH_RE.test(command) ||
    GIT_RESET_HARD_RE.test(command) ||
    GIT_CLEAN_FORCE_RE.test(command) ||
    RM_RECURSIVE_FORCE_RE.test(command) ||
    isGithubApiCurl(command)
  );
}

/** 结构化地从 `bash` 的 `{ command: string, ... }` 入参里取出命令。不用 `any`、不做断言：先用普通的形状判断把 `JsonValue` 收窄成一个记录，再读它的 `command`。 */
function extractBashCommand(input: JsonValue): string | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return undefined;
  }
  const command = input.command;
  return typeof command === 'string' ? command : undefined;
}

/**
 * chat 会话级「审批分类器」给一次工具调用的三值判定
 * （docs/logic/orchestration/tech/single-ledger.md §6.1 的 `ApprovalOutcome`）。这里从不返回
 * `'deny'`（见文件头）。
 *
 * - `'off'`：恒为 `'allow'`。这一档根本就不给工作区装审批闸门（`chat-agent.ts` 的
 *   `buildSession`），所以工具调用能走到这里本身就说明别处有 bug；无论如何 `'allow'`
 *   都是安全的防御性答案。
 * - `'all'`：恒为 `'review'`。凡是走到会话级分类器的工具调用都要人看一眼，没有例外。
 * - `'dangerous'`：只有 `toolName === 'bash'`、`input` 里能取出 `command` 字符串、且
 *   `commandNeedsHumanApproval` 判它安全时才 `'allow'`。其他工具，或者入参形状对不上的
 *   `bash` 调用，一律升级成 `'review'`——宁可多问一次，也不要悄悄跑掉一条这套策略根本
 *   没认出来的命令。
 */
export function classifyApproval(
  mode: ChatApprovalMode,
  toolName: string,
  input: JsonValue,
): ApprovalOutcome {
  if (mode === 'off') {
    return 'allow';
  }
  if (mode === 'all') {
    return 'review';
  }

  if (toolName !== 'bash') {
    return 'review';
  }
  const command = extractBashCommand(input);
  if (command === undefined) {
    return 'review';
  }
  return commandNeedsHumanApproval(command) ? 'review' : 'allow';
}
