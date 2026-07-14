/**
 * Chat approval-bridge policy (docs/08-chat-agent-webapp.md §2.2c（审批链）):
 * pure, side-effect-free helpers only — no I/O, no reference to
 * `turn-runner.ts`'s in-memory `activeTurns`. `routes/chat.ts`'s
 * `POST .../messages` handler is the one place these get wired together into
 * the actual `ApprovalPolicy` callback it hands `buildSession` (`chat-agent.ts`):
 *
 *   `shouldAutoAllow(mode, ctx.toolName, input)` decides on the spot whether a
 *   tool call is safe enough to run unattended; anything it says `false` to
 *   gets escalated to `turn-runner.ts`'s `requestApproval` (registers a
 *   pending approval, emits `approval.requested`, suspends the turn).
 *
 * This module never sees an `ApprovalContext`/`callId` — those only matter
 * once a request actually needs to be routed to a pending human decision,
 * which is `turn-runner.ts`'s job, not this one's.
 */
import type { JsonValue } from '@nimbo/core';

export type ChatApprovalMode = 'dangerous' | 'all' | 'off';

const APPROVAL_MODES: readonly ChatApprovalMode[] = ['dangerous', 'all', 'off'];

function isChatApprovalMode(value: string): value is ChatApprovalMode {
  return (APPROVAL_MODES as readonly string[]).includes(value);
}

/** Reads `CHAT_APPROVAL_MODE` — anything unrecognized (unset, typo, empty) falls back to `'dangerous'`, the safest default that still lets routine read-only bash commands through unattended. */
export function resolveApprovalMode(
  env: NodeJS.ProcessEnv = process.env,
): ChatApprovalMode {
  const raw = env.CHAT_APPROVAL_MODE?.trim();
  return raw !== undefined && isChatApprovalMode(raw) ? raw : 'dangerous';
}

// ---------------------------------------------------------------------------
// Danger checklist (`'dangerous'` mode's actual rule set) — deliberately
// conservative, regex-based best-effort static analysis of a shell command
// string (not a real shell parser): each rule below is independent, any one
// match is enough to require a human. False positives (a safe command that
// happens to match) just cost an extra click; false negatives would let a
// destructive/exfiltrating command run unattended, so every rule below errs
// toward matching too broadly rather than too narrowly.
// ---------------------------------------------------------------------------

/** `git push` in any form, including force-pushes (`--force`/`-f`) — matching bare "push" already covers both, since a force-push is still a push. */
const GIT_PUSH_RE = /\bgit\s+push\b/;

/** `git reset --hard` — irreversibly discards working-tree changes. */
const GIT_RESET_HARD_RE = /\bgit\s+reset\b[^\n]*--hard\b/;

/** `git clean` with a force flag (`-f`, `-fd`, `--force`, ...) — irreversibly deletes untracked files. */
const GIT_CLEAN_FORCE_RE =
  /\bgit\s+clean\b[^\n]*(?:-[a-zA-Z]*f[a-zA-Z]*\b|--force\b)/i;

/** `rm` with a recursive and/or force flag (`-r`, `-f`, `-rf`, `--recursive`, `--force`, ...) — the actually-destructive form of `rm`; a bare `rm somefile` is left alone. */
const RM_RECURSIVE_FORCE_RE =
  /\brm\s[^\n]*(?:-[a-zA-Z]*[rRf][a-zA-Z]*\b|--recursive\b|--force\b)/;

/**
 * `curl` that references the GitHub REST API host or the sandbox's own PAT
 * env var (`$GH_TOKEN`) — this is the PR-creation-and-friends path
 * (`chat-agent.ts`'s own instructions tell the model to use exactly this).
 * Static analysis has no reliable way to tell a read (GET) from a write
 * (POST/PATCH/DELETE) apart here, so both are treated as needing a human,
 * per this ticket's "静态无法区分读写，一律人审".
 */
function isGithubApiCurl(command: string): boolean {
  if (!/\bcurl\b/.test(command)) return false;
  return /api\.github\.com|\$GH_TOKEN/.test(command);
}

/** Whether a bash `command` string is dangerous enough that `'dangerous'` mode still requires a human (docs/08 §2.2c（审批链）). */
export function commandNeedsHumanApproval(command: string): boolean {
  return (
    GIT_PUSH_RE.test(command) ||
    GIT_RESET_HARD_RE.test(command) ||
    GIT_CLEAN_FORCE_RE.test(command) ||
    RM_RECURSIVE_FORCE_RE.test(command) ||
    isGithubApiCurl(command)
  );
}

/** Structural extraction of `bash`'s `{ command: string, ... }` input shape — no `any`/assertion: a plain shape check that narrows `JsonValue` down to a record before reading `command` off it. */
function extractBashCommand(input: JsonValue): string | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    return undefined;
  const command = input.command;
  return typeof command === 'string' ? command : undefined;
}

/**
 * The other half of the bridge (see file header): whether a tool call can
 * run without ever producing an `approval.requested` event at all.
 *
 * - `'off'`: always `true` — this mode never gates the workspace in the
 *   first place (`chat-agent.ts`'s `buildSession`), so a tool call reaching
 *   here at all would already be a bug elsewhere; `true` is the safe
 *   defensive answer regardless.
 * - `'all'`: always `false` — every tool call that reaches the session-level
 *   `onApproval` bridge needs a human, no exceptions.
 * - `'dangerous'`: `true` only for `toolName === 'bash'` whose `input` has an
 *   extractable `command` string that `commandNeedsHumanApproval` clears.
 *   Any other tool, or a `bash` call whose input doesn't match the expected
 *   shape, escalates to a human — better to over-ask than to silently run
 *   something this policy failed to even recognize.
 */
export function shouldAutoAllow(
  mode: ChatApprovalMode,
  toolName: string,
  input: JsonValue,
): boolean {
  if (mode === 'off') return true;
  if (mode === 'all') return false;

  if (toolName !== 'bash') return false;
  const command = extractBashCommand(input);
  if (command === undefined) return false;
  return !commandNeedsHumanApproval(command);
}
