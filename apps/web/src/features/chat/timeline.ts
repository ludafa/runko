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
 */
import type { SessionItem, Usage } from '@nimbo/core';

import type { ChatStreamEnvelope } from './schema';

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

export type TimelineEntry =
  | ItemTimelineEntry
  | SessionStartedEntry
  | TurnStartedEntry
  | TurnFailedEntry
  | TurnResultEntry
  | UserMessageEntry;

function lifecycleOf(
  eventType: 'item.started' | 'item.updated' | 'item.completed',
): ItemLifecycle {
  if (eventType === 'item.started') return 'started';
  if (eventType === 'item.updated') return 'updated';
  return 'completed';
}

export function buildTimeline(
  envelopes: readonly ChatStreamEnvelope[],
): TimelineEntry[] {
  const slots = new Map<string, TimelineEntry>();
  const slotOrder: string[] = [];

  function upsert(key: string, entry: TimelineEntry): void {
    if (!slots.has(key)) slotOrder.push(key);
    slots.set(key, entry);
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
      case 'turn.failed':
        // Two structurally different wire shapes share this `type` literal
        // (see schema.ts) — `'error' in event` tells apart the graceful
        // mid-stream `SessionEvent` (nested `error: NimboError`) from
        // turn-runner's own flat terminal sentinel (`code`+`message`
        // directly on the event).
        upsert(`marker:${String(seq)}`, {
          kind: 'turn-failed',
          error:
            'error' in event ?
              event.error
            : { code: event.code, message: event.message },
          seq,
        });
        break;
      case 'turn.result':
        upsert(`marker:${String(seq)}`, {
          kind: 'turn-result',
          finalResponse: event.finalResponse,
          usage: event.usage,
          seq,
        });
        break;
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const key = `item:${event.item.id}`;
        const existing = slots.get(key);
        const firstSeq =
          existing !== undefined && existing.kind === 'item' ?
            existing.firstSeq
          : seq;
        upsert(key, {
          kind: 'item',
          id: event.item.id,
          item: event.item,
          lifecycle: lifecycleOf(event.type),
          firstSeq,
          lastSeq: seq,
        });
        break;
      }
    }
  }

  return slotOrder.map((key) => {
    const entry = slots.get(key);
    if (entry === undefined)
      throw new Error(`unreachable: timeline slot "${key}" vanished`);
    return entry;
  });
}
