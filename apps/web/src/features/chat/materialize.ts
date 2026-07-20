/**
 * Incrementally materializes the wire's `ChatReplayFrame` sequence (message
 * frames from replay + chunk envelopes from replay/live alike, docs/tech/single-ledger.md §5 单-3) into a single, render-ready
 * `NimboUIMessage[]` — the client-side mirror of `@nimbo/core`'s own
 * server-side "UIMessage 单账本".
 *
 * ---- materialization mechanism (P13-5-4 report §①) ----
 *
 * A `MessageFrame` is already a finished message — upserted verbatim, no
 * further processing.
 *
 * A `ChunkEnvelope`'s `chunk` is routed through ai's own official
 * chunk-to-UIMessage incremental builder, `readUIMessageStream()` — but
 * *one call per message*, not one call for a whole turn: `@nimbo/core`'s
 * `loop.ts` opens a fresh `start`/…/`finish` boundary for *every* assistant
 * step and for every steer-injected user message (its own file header: "一个
 * nimbo step = 一条 assistant NimboUIMessage"), so a turn's chunk stream is
 * really a *concatenation* of several independent per-message chunk streams,
 * not one continuous one. `readUIMessageStream()` mutates a single
 * accumulating `state.message` in place and only patches `.id` on a `start`
 * chunk — it never resets `.parts` — so feeding an entire multi-message turn
 * through *one* call would silently merge every step's parts into one
 * message. `MessageLedger` re-opens a fresh `ReadableStream` +
 * `readUIMessageStream()` pair at every `start` chunk and closes it at the
 * matching `finish`, bridging that gap.
 *
 * A second, narrower gap: `readUIMessageStream()`'s internal state is
 * hard-coded to `role: "assistant"` (ai's own `createStreamingUIMessageState`
 * — there is no way to seed it with a different role even via its own
 * `message` seed parameter, the ternary that consumes it only keeps a seed
 * whose `role` is already `"assistant"`). That's correct for every
 * *model-streamed* message, but `drainSteerMessages`'s own
 * `start`/`text-*`/`finish` sequence for a steer-injected **user** message
 * (already fully known up front, never actually streamed token-by-token —
 * `loop.ts`'s own doc comment) would come out mislabeled `assistant` if
 * routed through it. Its `start` chunk's `messageMetadata.steered === true`
 * (the same flag docs/tech/single-ledger.md §2.2a's steer marker) is the one signal available
 * at that point to tell the two apart, so `MessageLedger` special-cases it: a
 * `steered` `start` chunk is built directly (`applySteerChunk`, a handful of
 * known chunk types — `text-*`/`file`, never tool calls/reasoning/data
 * parts, matching exactly what `drainSteerMessages` can ever produce)
 * instead of through `readUIMessageStream()`. This is the "official
 * consumption API doesn't fit the mixed model" case P13-5-4's work order
 * asked to flag if found.
 *
 * A third case has *no* open message at all: the turn-ending
 * `message-metadata` chunk (`@nimbo/core`'s `loop.ts`'s `finalizeTurn`) is
 * always yielded *after* the last step's own `finish` already closed that
 * message — mirroring the ledger write server-side, where the metadata lands
 * on `target.metadata` (the *previous*, already-fully-built message), not
 * inside a message's own chunk sequence. `MessageLedger` merges it onto the
 * most-recently-seen assistant message (`applyStandaloneMetadata`), or — the
 * rare case where a turn fails before any step ever ran — synthesizes an
 * empty placeholder assistant message to carry it, mirroring `loop.ts`'s own
 * `appendPlaceholderAssistantMessage`. `onTurnEnd` fires exactly once per
 * turn at this same point — the client's equivalent of the retired
 * `turn.result`/`turn.failed` sentinels, used by `use-chat-messages.ts` to
 * flip turn status.
 *
 * A fourth, structurally trivial case needs no special chunk handling at
 * all: `applyFrame`'s `MessageFrame` branch (a finished message, upserted
 * verbatim, see above) also fires `onUserMessage` whenever that message's
 * `role` is `'user'` — today that's exclusively the turn-start synthesized
 * user message (`apps/node-server`'s `turn-runner.ts`, this ticket's fix for the
 * "连发两条消息乱序" bug). See `UserMessageListener`'s own doc comment for why
 * this — and not the steer-injected user message's `ChunkEnvelope`
 * sequence — is the one signal `use-chat-messages.ts` needs to retire its
 * short-lived optimistic echo.
 *
 * ---- P13-5-5 fix: "most-recently-seen assistant message" must not mean
 * "most-recently-*materialized*" ----
 *
 * `readUIMessageStream()`'s own delivery is asynchronous — queued
 * `enqueue()`s only actually reach this class's `consume()` `for await` loop
 * on a later microtask/macrotask, never synchronously within the same
 * `applyChunk()` call that enqueued them (confirmed empirically: not even
 * after two microtask ticks, only a real macrotask boundary flushes the
 * pipe — `__tests__/helpers/nimbo-chunks.ts`'s `flushLedger()`). A first cut
 * of this class tracked "the last assistant message" by recording the *id*
 * only once that message's *materialized object* had actually been `upsert`ed
 * from `consume()` — which meant a caller that applies a whole turn's frames
 * synchronously in a tight loop (`use-chat-messages.ts`'s mount effect, "回放")
 * would reach the trailing standalone `message-metadata` chunk *before* the
 * async pipeline had delivered anything at all for the turn's last message,
 * making it look like there was no prior assistant message yet — wrongly
 * synthesizing a placeholder (and permanently losing the metadata once the
 * real message *did* finally arrive, since a placeholder is never retargeted).
 * A caller that instead applies frames one at a time with a real tick between
 * each ("直播") happened to avoid this, since by the time the metadata chunk
 * arrived the pipeline had long since caught up — an inconsistency this
 * class must not have: replay and live delivery of the *same* frame sequence
 * have to materialize to the *same* `NimboUIMessage[]`, independent of
 * timing.
 *
 * The fix has two parts, both keyed off information `applyChunk()` already
 * has *synchronously*, before ever touching the async pipeline:
 *
 * 1. `lastAssistantId` is now updated the instant a non-steer `start` chunk
 *    is seen (`chunk.messageId`, right there in `applyChunk()`), not when
 *    that message's materialized object eventually shows up in `consume()`'s
 *    `upsert()`. The *id* a message will have is already fully known at
 *    `start` time — only its *content* streams in asynchronously — so there
 *    is no timing dependency left in identifying *which* message is "last".
 * 2. Identifying the *right* id isn't enough on its own if that id's message
 *    object hasn't materialized into `byId` *yet* (still true for "回放" at
 *    the moment the metadata chunk lands) — merging onto whatever's in
 *    `byId` right now (or not-yet-there) would still race the pipeline, and
 *    worse, a *later* `upsert()` for that same id (the pipeline delivering a
 *    fuller snapshot as more of the message streams in) would silently
 *    clobber an eagerly-merged copy, since every `upsert()` replaces the
 *    stored object wholesale. So standalone metadata is never merged into a
 *    stored message at all — it's kept in `pendingMetadata` (id → metadata)
 *    and merged **lazily, in `snapshot()`**, onto whatever the current
 *    `byId` entry for that id happens to be, every time a snapshot is taken.
 *    This is timing-independent by construction: it doesn't matter whether
 *    the target message has materialized yet, or how many more times it's
 *    still going to be `upsert()`-ed after this — the projection always
 *    recombines the *latest* content with the metadata fresh.
 */
import type {
  NimboChunk,
  NimboMessageMetadata,
  NimboUIMessage,
} from '@nimbo/core';
import type { FileUIPart, TextUIPart } from 'ai';
import { readUIMessageStream } from 'ai';

import type { ChatReplayFrame } from './schema';
import { isMessageFrame } from './schema';

// ---- steer-injected user message: built directly, not through
// `readUIMessageStream()` (see file header) — the only chunk types
// `drainSteerMessages` (loop.ts) can ever produce for one of these. ----

interface SteerMessageBuilder {
  message: NimboUIMessage;
  openText: Map<string, TextUIPart>;
}

function startSteerMessage(
  messageId: string,
  metadata: NimboMessageMetadata | undefined,
): SteerMessageBuilder {
  const message: NimboUIMessage = { id: messageId, role: 'user', parts: [] };
  if (metadata !== undefined) message.metadata = metadata;
  return { message, openText: new Map() };
}

function applySteerChunk(
  builder: SteerMessageBuilder,
  chunk: NimboChunk,
): void {
  switch (chunk.type) {
    case 'text-start': {
      const part: TextUIPart = { type: 'text', text: '', state: 'streaming' };
      builder.openText.set(chunk.id, part);
      builder.message.parts.push(part);
      break;
    }
    case 'text-delta': {
      const part = builder.openText.get(chunk.id);
      if (part !== undefined) part.text += chunk.delta;
      break;
    }
    case 'text-end': {
      const part = builder.openText.get(chunk.id);
      if (part !== undefined) part.state = 'done';
      break;
    }
    case 'file': {
      const part: FileUIPart = {
        type: 'file',
        url: chunk.url,
        mediaType: chunk.mediaType,
      };
      builder.message.parts.push(part);
      break;
    }
    default:
      break; // 'start'/'finish' are boundaries handled by the caller; drainSteerMessages never yields anything else for a steer message.
  }
}

export type MessageLedgerListener = (messages: NimboUIMessage[]) => void;
export type TurnEndListener = (metadata: NimboMessageMetadata) => void;
/**
 * Fires exactly when a `role === 'user'` `MessageFrame` is applied — today
 * that's *only* ever the turn-start synthesized user message
 * (`apps/node-server`'s `turn-runner.ts`'s `driveTurn`, broadcast as this turn's
 * very first frame). A steer-injected user message never fires this: it
 * reaches this ledger as a `ChunkEnvelope` sequence instead (a real
 * `start`/`text-*`/`finish` boundary, materialized through `applySteerChunk`
 * + `upsert` above) and only *later* ever shows up as a `MessageFrame` too —
 * once its `kind = 'message'` row is replayed after the turn has finished —
 * by which point `upsert`'s id-keyed dedup makes that replay a no-op for
 * `byId`, but this listener would still fire for it. `use-chat-messages.ts`
 * relies on this to pop its short-lived optimistic echo (see that file's own
 * header) the instant the real message lands; that same dedup-driven refire
 * on later replay is harmless there too, since a pop past an already-empty
 * echo queue is a no-op.
 */
export type UserMessageListener = () => void;

export class MessageLedger {
  private readonly order: string[] = [];
  private readonly byId = new Map<string, NimboUIMessage>();
  private openController:
    ReadableStreamDefaultController<NimboChunk> | undefined;
  private steerBuilder: SteerMessageBuilder | undefined;
  /** Set synchronously the instant a non-steer `start` chunk is seen — never derived from `consume()`'s (asynchronous) `upsert()` calls. See file header, "P13-5-5 fix". */
  private lastAssistantId: string | undefined;
  /** Standalone `message-metadata` waiting to be merged onto `lastAssistantId`'s message — merged lazily in `snapshot()`, never written directly into `byId`. See file header, "P13-5-5 fix" part 2. */
  private readonly pendingMetadata = new Map<string, NimboMessageMetadata>();
  private placeholderCount = 0;
  private readonly onChange: MessageLedgerListener;
  private readonly onTurnEnd: TurnEndListener | undefined;
  private readonly onUserMessage: UserMessageListener | undefined;

  constructor(
    onChange: MessageLedgerListener,
    onTurnEnd?: TurnEndListener,
    onUserMessage?: UserMessageListener,
  ) {
    this.onChange = onChange;
    this.onTurnEnd = onTurnEnd;
    this.onUserMessage = onUserMessage;
  }

  /** Feed one frame, in wire order — replay and live frames alike (both are just `ChatReplayFrame`s, see file header). */
  applyFrame(frame: ChatReplayFrame): void {
    if (isMessageFrame(frame)) {
      this.upsert(frame.message);
      if (frame.message.role === 'user') this.onUserMessage?.();
      return;
    }
    this.applyChunk(frame.chunk);
  }

  private applyChunk(chunk: NimboChunk): void {
    if (chunk.type === 'start') {
      this.closeOpenMessage(); // defensive: a prior unfinished stream (shouldn't happen, loop.ts's boundaries are always paired) is closed rather than leaked.
      if (
        chunk.messageMetadata?.steered === true &&
        chunk.messageId !== undefined
      ) {
        this.steerBuilder = startSteerMessage(
          chunk.messageId,
          chunk.messageMetadata,
        );
      } else {
        // Recorded here, synchronously — not from `consume()`'s (async)
        // `upsert()` calls — so a trailing standalone `message-metadata`
        // chunk always knows the right target id, even if this message's
        // content hasn't materialized yet (see file header, "P13-5-5 fix").
        if (chunk.messageId !== undefined)
          this.lastAssistantId = chunk.messageId;
        const stream = new ReadableStream<NimboChunk>({
          start: (controller) => {
            this.openController = controller;
          },
        });
        void this.consume(readUIMessageStream<NimboUIMessage>({ stream }));
      }
    }

    if (this.steerBuilder !== undefined) {
      applySteerChunk(this.steerBuilder, chunk);
      if (chunk.type === 'finish') {
        this.upsert(this.steerBuilder.message);
        this.steerBuilder = undefined;
      }
      return;
    }

    if (this.openController === undefined) {
      // No message currently open — the only chunk `@nimbo/core`'s loop ever
      // produces outside a start/finish window (see file header).
      if (chunk.type === 'message-metadata')
        this.applyStandaloneMetadata(chunk.messageMetadata);
      return;
    }

    this.openController.enqueue(chunk);
    if (chunk.type === 'finish') this.closeOpenMessage();
  }

  private closeOpenMessage(): void {
    this.openController?.close();
    this.openController = undefined;
  }

  private async consume(
    iterable: AsyncIterable<NimboUIMessage>,
  ): Promise<void> {
    for await (const message of iterable) this.upsert(message);
  }

  private applyStandaloneMetadata(metadata: NimboMessageMetadata): void {
    if (this.lastAssistantId === undefined) {
      // No assistant message has ever started this session (a turn failing
      // before its first step ever ran) — nothing to merge onto, ever;
      // synthesize a placeholder the same way `loop.ts`'s
      // `appendPlaceholderAssistantMessage` does server-side.
      this.placeholderCount += 1;
      this.upsert({
        id: `turn-signal-${String(this.placeholderCount)}`,
        role: 'assistant',
        parts: [],
        metadata,
      });
    } else {
      // Queued, not written directly onto `byId` — the target message may
      // not have materialized yet (or may still receive further `upsert()`s
      // that would clobber an eagerly-merged copy); `snapshot()` recombines
      // the latest stored content with this on every read instead (see file
      // header, "P13-5-5 fix" part 2).
      const prior = this.pendingMetadata.get(this.lastAssistantId);
      this.pendingMetadata.set(
        this.lastAssistantId,
        prior === undefined ? metadata : { ...prior, ...metadata },
      );
      this.notifyChange();
    }
    this.onTurnEnd?.(metadata);
  }

  private upsert(message: NimboUIMessage): void {
    if (!this.byId.has(message.id)) this.order.push(message.id);
    this.byId.set(message.id, message);
    this.notifyChange();
  }

  private notifyChange(): void {
    this.onChange(this.snapshot());
  }

  private snapshot(): NimboUIMessage[] {
    return this.order.map((id) => {
      const message = this.byId.get(id);
      if (message === undefined) {
        throw new Error(`unreachable: MessageLedger id "${id}" vanished`);
      }
      const pending = this.pendingMetadata.get(id);
      if (pending === undefined) return message;
      const mergedMetadata: NimboMessageMetadata =
        message.metadata === undefined ?
          pending
        : { ...message.metadata, ...pending };
      return { ...message, metadata: mergedMetadata };
    });
  }
}
