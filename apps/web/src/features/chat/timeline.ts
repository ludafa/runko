/**
 * Render-shaping helpers for the `NimboUIMessage[]` ledger `materialize.ts`
 * produces (docs/tech/single-ledger.md §5/§6). Two concerns live
 * here:
 *
 * - Interleaving `use-chat-messages.ts`'s short-lived optimistic user echoes
 *   (`buildRenderEntries` — see that hook's own file header for why they're
 *   only short-lived now, popped as soon as the real turn-start
 *   `MessageFrame` arrives, not permanent) with the materialized messages, in
 *   the position they were sent.
 * - Narrowing a tool part's `input`/`output` (typed `unknown` — `NimboUIMessage`'s
 *   `TOOLS` type parameter is necessarily the generic `UITools`, see
 *   `@nimbo/core`'s `state.ts` own `NimboUIMessage` doc comment for why no
 *   compile-time-known tool name union exists to do better) into the shapes
 *   the tool-specific cards need (`bash`'s command, `ask-user`'s question).
 */
import type {
  NimboDataParts,
  NimboUIMessage,
  ToolTimingData,
} from '@nimbo/core';
import type { ToolUIPart, UIMessagePart, UITools } from 'ai';
import { getToolName, isToolUIPart } from 'ai';
import { z } from 'zod';

import type { JsonValue } from './schema';
import { jsonValueSchema } from './schema';

// ---- optimistic user-message echo interleaving ----

export interface PendingUserEcho {
  /** Assigned in send order (`use-chat-messages.ts`'s `nextEchoIdRef`) — the tie-break `buildRenderEntries` sorts same-anchor echoes by, below. */
  id: number;
  text: string;
  /** `messages.length` at the moment this was sent (`use-chat-messages.ts`'s `sendMessage`) — anchors where it renders relative to the materialized ledger, since it briefly has no wire position of its own yet (until the real `MessageFrame` arrives and pops it — that hook's own file header). */
  afterMessageCount: number;
  /**
   * 这条回显来自 [steer 中途插话](../../../../../docs/terms.md)（而不是「起新一轮」）。
   *
   * 两者的等待含义不同，界面要说清：起新一轮的回显几乎立刻就被真实消息顶替；
   * 插话的真实注入点是 core 的**下一个 step 边界**，当前工具跑得久就可能等上
   * 几十秒。所以插话回显要标成「待注入」并压暗——它还没被 agent 看到，画成
   * 一条正常指令是在撒谎。
   */
  steered?: boolean;
}

export type RenderEntry =
  | { kind: 'message'; message: NimboUIMessage }
  | { kind: 'pending-echo'; echo: PendingUserEcho };

/**
 * Splices `pendingEchoes` into `messages` at each one's `afterMessageCount`
 * anchor — stable under `messages` growing (new messages append past
 * whatever index an echo was anchored at, never shifting it), so an echo
 * sent mid-turn-1 still renders between turn 1 and turn 2 once turn 2 starts
 * appending its own messages.
 *
 * Defensive tie-break for same-anchor echoes (`use-chat-messages.ts`'s own
 * fix makes at most one echo pending at a time in the normal flow, but this
 * stays correct even if a stale-closure race — the exact mechanism behind
 * this codebase's original "连发两条消息乱序" bug report — ever produces two):
 * `Array.prototype.sort` is stable, so a `b - a` (descending-anchor)
 * comparator alone would, for a tie, insert the earlier-sent echo *first* —
 * but each `splice(index, 0, …)` below pushes whatever was already at
 * `index` one slot to the right, so inserting earlier-sent-first actually
 * ends up placing it *after* the later-sent one once both share that same
 * index (the exact reversal that used to surface as the bug). Breaking ties
 * by `id` **descending** — the later-sent echo processed (and therefore
 * inserted) first, so the earlier-sent one's later insertion at the same
 * index pushes it back to the left — is what makes the final splice order
 * come out ascending-`id` (send order), matching how `messages` itself is
 * always in send order.
 */
export function buildRenderEntries(
  messages: readonly NimboUIMessage[],
  pendingEchoes: readonly PendingUserEcho[],
): RenderEntry[] {
  const entries: RenderEntry[] = messages.map((message) => ({
    kind: 'message',
    message,
  }));
  // Insert from the highest anchor down so earlier insertions don't shift
  // the index a later (smaller-anchor) one needs to splice at; ties broken
  // by `id` descending (see doc comment above).
  const sorted = [...pendingEchoes].sort(
    (a, b) => b.afterMessageCount - a.afterMessageCount || b.id - a.id,
  );
  for (const echo of sorted) {
    const index = Math.min(Math.max(echo.afterMessageCount, 0), entries.length);
    entries.splice(index, 0, { kind: 'pending-echo', echo });
  }
  return entries;
}

// ---- tool part narrowing (`input`/`output: unknown`, see file header) ----

export type NimboToolPart = ToolUIPart<UITools>;

/** `ai`'s own `isToolUIPart` also accepts a `DynamicToolUIPart` — nimbo never produces one (every tool part is a static `tool-${name}`, `@nimbo/core`'s `loop.ts`), so this narrows one step further to just the shape this app's cards render. */
export function isNimboToolPart(
  part: UIMessagePart<NimboDataParts, UITools>,
): part is NimboToolPart {
  return isToolUIPart(part) && part.type.startsWith('tool-');
}

export function toolPartName(part: NimboToolPart): string {
  return getToolName(part);
}

function parseUnknownJsonValue(value: unknown): JsonValue {
  const parsed = jsonValueSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** `bash`'s own input shape (docs/tech/builtin-tools.md): `{ command: string, timeout_ms？ }`. */
export function bashCommandFromInput(input: unknown): string | undefined {
  const value = parseUnknownJsonValue(input);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const { command } = value;
  return typeof command === 'string' ? command : undefined;
}

const askUserInputSchema = z.object({
  question: z.string(),
  options: z.array(z.string()).optional(),
});

export type AskUserInput = z.infer<typeof askUserInputSchema>;

/** `ask-user`'s own input shape (`apps/node-server/src/agent/chat-agent.ts`'s `askUserInputSchema`): `{ question, options？ }`. */
export function askUserInputFrom(input: unknown): AskUserInput | undefined {
  const result = askUserInputSchema.safeParse(input);
  return result.success ? result.data : undefined;
}

/** `ask-user`'s `execute()` returns a plain string (the answer, or the timeout's fixed message) — `output: unknown` narrowed the same defensive way as `bashCommandFromInput`. */
export function askUserAnswerFromOutput(output: unknown): string | undefined {
  return typeof output === 'string' ? output : undefined;
}

export function prettyJson(value: unknown): string {
  return JSON.stringify(parseUnknownJsonValue(value), null, 2);
}

export function summarizeJson(value: unknown): string {
  const json = JSON.stringify(parseUnknownJsonValue(value));
  return json.length > 120 ? `${json.slice(0, 120)}…` : json;
}

// ---- tool timing (`data-tool-timing`, `@nimbo/core`'s `state.ts` —
// persistent, unlike `data-tool-progress`) ----

/**
 * Finds the `data-tool-timing` part matching `toolCallId` (its `id`, per
 * `@nimbo/core`'s `loop.ts` `upsertToolTimingPart`) — never rendered as its
 * own card (`message-entry.tsx`'s switch has no case for it, falling through
 * to the generic tool-part guard, which rejects it), only joined into the
 * matching tool-call entry's own card (`tool-call-card.tsx`). Absent for a
 * tool part whose input is still streaming (`startToolTiming` only fires
 * once `tool-input-available` has, `loop.ts`), or for a message persisted
 * before this part existed.
 */
export function findToolTiming(
  message: NimboUIMessage,
  toolCallId: string,
): ToolTimingData | undefined {
  for (const part of message.parts) {
    if (part.type === 'data-tool-timing' && part.id === toolCallId) {
      return part.data;
    }
  }
  return undefined;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** `HH:MM:SS`, local time — deliberately not `toLocaleTimeString()` (this repo's existing `count` precedent, `turn-stats-dialog.tsx`): keeps the rendered text independent of ICU data availability/locale. */
export function formatClockTime(epochMs: number): string {
  const date = new Date(epochMs);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** `<1s` → ms, `<60s` → one decimal place of seconds, longer → `Xm Ys` — the one humanization ladder `tool-call-card.tsx` uses for both a settled duration and a still-running elapsed tick. Negative input (clock skew between `Date.now()` calls) clamps to zero rather than rendering a nonsensical negative duration. */
export function formatDuration(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < 1000) {
    return `${String(Math.round(clamped))}ms`;
  }
  // Rounds to the same one-decimal precision the render below uses before
  // comparing against the 60s boundary — otherwise e.g. 59999ms would
  // display as the nonsensical "60.0s" instead of rolling over to "1m 0s".
  const roundedSeconds = Math.round(clamped / 100) / 10;
  if (roundedSeconds < 60) {
    return `${roundedSeconds.toFixed(1)}s`;
  }
  const totalSeconds = Math.round(clamped / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes)}m ${String(seconds)}s`;
}
