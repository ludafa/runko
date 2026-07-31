/**
 * `schemas/chat.ts`'s wire vocabulary (docs/tech/single-ledger.md §5
 * 单-3): `chunkEnvelopeSchema` (`{seq?, chunk}` — the live tail's own shape,
 * also reused for a replayed `kind = 'chunk'` row), `messageFrameSchema`
 * (`{seq, message}` — replay-only, a finished `kind = 'message'` row),
 * `chatReplayFrameSchema` (their union — structurally discriminated by which
 * of `chunk`/`message` the frame actually carries, no shared literal
 * discriminant field), and `ConversationEventsListSchema` (`GET .../events`'s
 * `{frames}` response envelope — NOT a bare array, `events` was the retired
 * field name).
 */
import { describe, expect, it } from 'vitest';

import {
  ConversationEventsListSchema,
  chatReplayFrameSchema,
  chunkEnvelopeSchema,
  messageFrameSchema,
} from '../../src/schemas/chat.js';

const sampleChunk = { type: 'text-delta', id: 't1', delta: 'hi' };
const sampleMessage = {
  id: 'm1',
  role: 'assistant' as const,
  parts: [{ type: 'text', text: 'hi' }],
};

describe('schemas/chat: chunkEnvelopeSchema', () => {
  it('parses an envelope with no `seq` key at all — the ephemeral shape (docs/tech/single-ledger.md §5 单-3)', () => {
    const result = chunkEnvelopeSchema.safeParse({ chunk: sampleChunk });
    expect(result.success).toBe(true);
  });

  it('parses an envelope carrying an integer `seq` — the durable/replayed shape', () => {
    const result = chunkEnvelopeSchema.safeParse({
      seq: 1,
      chunk: sampleChunk,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-integer seq (e.g. 1.5)', () => {
    const result = chunkEnvelopeSchema.safeParse({
      seq: 1.5,
      chunk: sampleChunk,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a payload with no `chunk` field at all', () => {
    const result = chunkEnvelopeSchema.safeParse({ seq: 1 });
    expect(result.success).toBe(false);
  });

  // Documents actual behavior, not a claim this should be relied on: the
  // schema only constrains `seq` with `.int()`, not `.nonnegative()` — a
  // negative value round-trips fine here even though the server itself never
  // produces one (`createEmitWire` in turn-runner/ only ever counts up from
  // `getMaxEventSeq`). Carried over verbatim from the pre-migration
  // `chatEventEnvelopeSchema` coverage this schema replaces.
  it('does NOT reject a negative seq — the schema has no .nonnegative() constraint', () => {
    const result = chunkEnvelopeSchema.safeParse({
      seq: -1,
      chunk: sampleChunk,
    });
    expect(result.success).toBe(true);
  });
});

describe('schemas/chat: messageFrameSchema', () => {
  it('parses a { seq, message } frame', () => {
    const result = messageFrameSchema.safeParse({
      seq: 1,
      message: sampleMessage,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a frame with no seq at all — unlike chunkEnvelopeSchema, seq is required here (replay-only, always a persisted row)', () => {
    const result = messageFrameSchema.safeParse({ message: sampleMessage });
    expect(result.success).toBe(false);
  });

  it('rejects a frame with no message field', () => {
    const result = messageFrameSchema.safeParse({ seq: 1 });
    expect(result.success).toBe(false);
  });
});

describe('schemas/chat: chatReplayFrameSchema (union, structurally discriminated)', () => {
  it('accepts a chunk-shaped frame', () => {
    const result = chatReplayFrameSchema.safeParse({
      seq: 1,
      chunk: sampleChunk,
    });
    expect(result.success).toBe(true);
  });

  it('accepts an ephemeral chunk-shaped frame with no seq', () => {
    const result = chatReplayFrameSchema.safeParse({ chunk: sampleChunk });
    expect(result.success).toBe(true);
  });

  it('accepts a message-shaped frame', () => {
    const result = chatReplayFrameSchema.safeParse({
      seq: 2,
      message: sampleMessage,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a frame carrying neither `chunk` nor `message`', () => {
    const result = chatReplayFrameSchema.safeParse({ seq: 1 });
    expect(result.success).toBe(false);
  });
});

describe('schemas/chat: ConversationEventsListSchema', () => {
  it('parses { frames: [...] } — mixed message and chunk frames, in any order', () => {
    const result = ConversationEventsListSchema.safeParse({
      frames: [
        { seq: 1, message: sampleMessage },
        { seq: 2, chunk: sampleChunk },
        { chunk: { type: 'text-delta', id: 't2', delta: 'more' } },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('parses an empty frames array (a session with no events yet)', () => {
    const result = ConversationEventsListSchema.safeParse({ frames: [] });
    expect(result.success).toBe(true);
  });

  it('rejects the retired bare-array shape (no `frames` wrapper) — `events`/a top-level array is not this schema', () => {
    const result = ConversationEventsListSchema.safeParse([
      { seq: 1, message: sampleMessage },
    ]);
    expect(result.success).toBe(false);
  });

  it('rejects `{ events: [...] }` — the retired field name', () => {
    const result = ConversationEventsListSchema.safeParse({
      events: [{ seq: 1, message: sampleMessage }],
    });
    expect(result.success).toBe(false);
  });
});
