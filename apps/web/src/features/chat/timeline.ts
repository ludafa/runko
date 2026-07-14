/**
 * Pure reducer: an ordered, seq-deduped `ChatStreamEnvelope[]` (history
 * replay + live stream, merged upstream by `useChatMessages`) → a flat list
 * of render-ready `TimelineEntry`s. Item lifecycle events
 * (`item.started`/`item.updated`/`item.completed`) collapse onto a single
 * slot per `item.id`, updated in place as later events for the same id
 * arrive — the rendering rule examples/12's `streamLive` applies for its
 * console timeline (one row per id, not one row per event); here it also
 * means no duplicate rows and no lost updates when React re-renders.
 *
 * `turn.completed` (a real `SessionEvent`, carries only `usage`) is folded
 * into the richer `turn.result` sentinel bar rather than getting its own
 * row — `turn.result` always follows it directly in the same turn and
 * carries the same `usage` plus `finalResponse`, so a separate row would be
 * a redundant duplicate of the same information (see final report's
 * ambiguity list).
 *
 * `user.message` (docs/08 §2.2 "契约细化" #1) is the server's echo of the
 * user's own outgoing text, pushed with a real `seq` as the first envelope
 * of the turn it kicks off — it replays from `GET events` like any other
 * event, so this reducer just slots it in at its `seq` position like every
 * other marker. `useChatMessages` additionally renders an *optimistic*
 * local copy the instant `sendMessage` is called (zero-latency echo) and
 * reconciles it against this real event once it arrives — see that file's
 * header for the dedup mechanics; this reducer only ever sees the
 * server-confirmed side of that merge.
 *
 * Approval/question bridge events (docs/08 §2.2c（审批链）) fold the same
 * way `item.*`'s lifecycle does: `approval.requested`/`question.asked`
 * upserts a `'pending'` slot keyed by `callId` (a different id space than
 * `item.id` — the wire's own `tool_call` item for the same call, if any,
 * gets its own separate row, see `ItemCard`'s ask_user suppression below),
 * and the matching `approval.resolved`/`question.answered` updates that same
 * slot in place to a terminal status, same "first-seen position, last-seen
 * content" rule as an `item`. Anything still `'pending'` when the turn's own
 * terminal sentinel (`turn.result`, or turn-runner's flat `turn.failed`)
 * arrives is swept to `'expired'` — a resolution that never made it onto the
 * wire (server crash, or turn-runner's own "deny residual pending but don't
 * emit" end-of-turn fallback) must not leave a card stuck offering buttons
 * for a decision the turn can no longer act on. Replay reruns this reducer
 * from scratch over the full persisted history, so a page reload folds the
 * exact same way live streaming did.
 */
import type { SessionItem, Usage } from '@nimbo/core';

import type { ChatStreamEnvelope, JsonValue } from './schema';

export type ItemLifecycle = 'started' | 'updated' | 'completed';

export interface ItemTimelineEntry {
  kind: 'item';
  id: string;
  item: SessionItem;
  lifecycle: ItemLifecycle;
  firstSeq: number;
  lastSeq: number;
}

export interface SessionStartedEntry {
  kind: 'session-started';
  sessionId: string;
  seq: number;
}

export interface TurnStartedEntry {
  kind: 'turn-started';
  turn: number;
  seq: number;
}

export interface UserMessageEntry {
  kind: 'user-message';
  text: string;
  seq: number;
}

/**
 * Widened from `@nimbo/core`'s `NimboError` on purpose: this entry has to
 * hold either that shape (a graceful mid-stream `turn.failed` `SessionEvent`
 * — `NimboError['code']`'s closed literal union) or apps/server's
 * turn-runner-level terminal sentinel (an open `string` `code`, e.g.
 * `"internal_error"`) — see `schema.ts`'s `turnRunnerFailedEventSchema`.
 * `NimboError` is structurally assignable into this wider shape with no
 * cast needed either way.
 */
export interface TurnFailedErrorInfo {
  code: string;
  message: string;
}

export interface TurnFailedEntry {
  kind: 'turn-failed';
  error: TurnFailedErrorInfo;
  seq: number;
}

export interface TurnResultEntry {
  kind: 'turn-result';
  finalResponse: string;
  usage: Usage;
  seq: number;
}

/**
 * `'pending'` — `approval.requested` seen, no resolution yet (interactive:
 * the card offers Allow/Deny). `'allowed'`/`'denied'` — a real
 * `approval.resolved` arrived (`message` only ever set on `'denied'`, mirrors
 * the wire event). `'expired'` — swept by the terminal-sweep (see file
 * header) *or* by `useChatMessages`'s own 404-on-submit fallback
 * (`buildTimeline`'s `locallyExpiredCallIds` option) when the server no
 * longer has this `callId` pending (already timed out / turn already ended)
 * by the time a human clicked a button.
 */
export type ApprovalEntryStatus = 'pending' | 'allowed' | 'denied' | 'expired';

export interface ApprovalTimelineEntry {
  kind: 'approval';
  callId: string;
  toolName: string;
  input: JsonValue;
  status: ApprovalEntryStatus;
  message?: string;
  seq: number;
}

/** Same shape of states as `ApprovalEntryStatus`, for the `ask_user` bridge — `'timeout'` (not `'denied'`) is the wire's own outcome for a question nobody answered in time, and `answer` is only ever set on `'answered'`. */
export type QuestionEntryStatus =
  'pending' | 'answered' | 'timeout' | 'expired';

export interface QuestionTimelineEntry {
  kind: 'question';
  callId: string;
  question: string;
  options?: string[];
  status: QuestionEntryStatus;
  answer?: string;
  seq: number;
}

export type TimelineEntry =
  | ItemTimelineEntry
  | SessionStartedEntry
  | TurnStartedEntry
  | TurnFailedEntry
  | TurnResultEntry
  | UserMessageEntry
  | ApprovalTimelineEntry
  | QuestionTimelineEntry;

function lifecycleOf(
  eventType: 'item.started' | 'item.updated' | 'item.completed',
): ItemLifecycle {
  if (eventType === 'item.started') return 'started';
  if (eventType === 'item.updated') return 'updated';
  return 'completed';
}

/** `chat-agent.ts`'s literal registration name (docs/08 §2.2c（审批链）) — the one tool whose `tool_call` item is suppressed in favor of its `question` card, see the `item.*` branch below. */
const ASK_USER_TOOL_NAME = 'ask_user';

export interface BuildTimelineOptions {
  /**
   * `callId`s a human tried to act on (`useChatMessages`'s `submitApproval`/
   * `submitAnswer`) that came back 404 — the server no longer has them
   * pending (already timed out, or the turn already ended) even though no
   * `approval.resolved`/`question.answered` (or terminal sentinel) ever made
   * it onto this client's event log. Folded into `'expired'` the same way
   * the terminal-sweep below is, just triggered by a failed submit instead
   * of a `turn.result`/`turn.failed` arriving.
   */
  locallyExpiredCallIds?: ReadonlySet<string>;
}

export function buildTimeline(
  envelopes: readonly ChatStreamEnvelope[],
  options?: BuildTimelineOptions,
): TimelineEntry[] {
  const slots = new Map<string, TimelineEntry>();
  const slotOrder: string[] = [];

  function upsert(key: string, entry: TimelineEntry): void {
    if (!slots.has(key)) slotOrder.push(key);
    slots.set(key, entry);
  }

  /** Terminal-sweep (see file header): every still-`'pending'` approval/question slot becomes `'expired'` — called once per terminal sentinel, and again at the end for `locallyExpiredCallIds`. */
  function expirePending(shouldExpire: (callId: string) => boolean): void {
    for (const key of slotOrder) {
      const entry = slots.get(key);
      if (entry === undefined) continue;
      if (
        (entry.kind === 'approval' || entry.kind === 'question') &&
        entry.status === 'pending' &&
        shouldExpire(entry.callId)
      ) {
        slots.set(key, { ...entry, status: 'expired' });
      }
    }
  }

  for (const { seq, event } of envelopes) {
    switch (event.type) {
      case 'session.started':
        upsert(`marker:${String(seq)}`, {
          kind: 'session-started',
          sessionId: event.sessionId,
          seq,
        });
        break;
      case 'user.message':
        upsert(`marker:${String(seq)}`, {
          kind: 'user-message',
          text: event.text,
          seq,
        });
        break;
      case 'turn.started':
        upsert(`marker:${String(seq)}`, {
          kind: 'turn-started',
          turn: event.turn,
          seq,
        });
        break;
      case 'turn.completed':
        break; // folded into the turn.result sentinel, see file header
      case 'turn.failed': {
        // Two structurally different wire shapes share this `type` literal
        // (see schema.ts) — `'error' in event` tells apart the graceful
        // mid-stream `SessionEvent` (nested `error: NimboError`, turn still
        // completes normally afterwards — not terminal by itself) from
        // turn-runner's own flat terminal sentinel (`code`+`message`
        // directly on the event, which *is* terminal).
        const isTurnRunnerSentinel = !('error' in event);
        upsert(`marker:${String(seq)}`, {
          kind: 'turn-failed',
          error:
            'error' in event ?
              event.error
            : { code: event.code, message: event.message },
          seq,
        });
        if (isTurnRunnerSentinel) expirePending(() => true);
        break;
      }
      case 'turn.result':
        upsert(`marker:${String(seq)}`, {
          kind: 'turn-result',
          finalResponse: event.finalResponse,
          usage: event.usage,
          seq,
        });
        expirePending(() => true);
        break;
      case 'approval.requested':
        upsert(`approval:${event.callId}`, {
          kind: 'approval',
          callId: event.callId,
          toolName: event.toolName,
          input: event.input,
          status: 'pending',
          seq,
        });
        break;
      case 'approval.resolved': {
        const key = `approval:${event.callId}`;
        const existing = slots.get(key);
        // `approval.requested` always precedes `approval.resolved` for the
        // same `callId` (register-then-emit, see file header) — the
        // fallback empty/null values only matter for a partial envelope
        // window that starts mid-way through a call's lifecycle, which
        // `useChatMessages` never actually produces (it always merges the
        // full replay + live tail).
        const toolName =
          existing !== undefined && existing.kind === 'approval' ?
            existing.toolName
          : '';
        const input =
          existing !== undefined && existing.kind === 'approval' ?
            existing.input
          : null;
        upsert(key, {
          kind: 'approval',
          callId: event.callId,
          toolName,
          input,
          status: event.behavior === 'allow' ? 'allowed' : 'denied',
          message: event.message,
          seq,
        });
        break;
      }
      case 'question.asked':
        upsert(`question:${event.callId}`, {
          kind: 'question',
          callId: event.callId,
          question: event.question,
          options: event.options,
          status: 'pending',
          seq,
        });
        break;
      case 'question.answered': {
        const key = `question:${event.callId}`;
        const existing = slots.get(key);
        const question =
          existing !== undefined && existing.kind === 'question' ?
            existing.question
          : '';
        const options =
          existing !== undefined && existing.kind === 'question' ?
            existing.options
          : undefined;
        upsert(key, {
          kind: 'question',
          callId: event.callId,
          question,
          options,
          status: event.outcome === 'answered' ? 'answered' : 'timeout',
          answer: event.answer,
          seq,
        });
        break;
      }
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const item = event.item;
        // ask_user's own question card (above) is its normal rendering —
        // the underlying tool_call item is only surfaced when it ended
        // *without* a question card to show for it (failed before asking,
        // or denied by an approval gate ahead of it); an in-progress/
        // completed one would just be a noisy duplicate of the question
        // card (docs/08 §2.2c（审批链）).
        if (
          item.type === 'tool_call' &&
          item.toolName === ASK_USER_TOOL_NAME &&
          item.status !== 'failed' &&
          item.status !== 'denied'
        ) {
          break;
        }
        const key = `item:${item.id}`;
        const existing = slots.get(key);
        const firstSeq =
          existing !== undefined && existing.kind === 'item' ?
            existing.firstSeq
          : seq;
        upsert(key, {
          kind: 'item',
          id: item.id,
          item,
          lifecycle: lifecycleOf(event.type),
          firstSeq,
          lastSeq: seq,
        });
        break;
      }
    }
  }

  const locallyExpiredCallIds = options?.locallyExpiredCallIds;
  if (locallyExpiredCallIds !== undefined && locallyExpiredCallIds.size > 0) {
    expirePending((callId) => locallyExpiredCallIds.has(callId));
  }

  return slotOrder.map((key) => {
    const entry = slots.get(key);
    if (entry === undefined)
      throw new Error(`unreachable: timeline slot "${key}" vanished`);
    return entry;
  });
}
