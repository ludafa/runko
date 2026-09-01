import { describe, expect, it } from 'vitest';

import {
  chatReplayFrameSchema,
  conversationMessagesListSchema,
  frameSeq,
  isMessageFrame,
  parseChatReplayFrame,
} from '../schema';
import {
  assistantMessage,
  finishChunk,
  messageFrame,
  startChunk,
  userMessage,
} from './helpers/nimbo-chunks';

describe('chatReplayFrameSchema / parseChatReplayFrame', () => {
  it('accepts a ChunkEnvelope with a seq (durable/replayable chunk)', () => {
    const raw = JSON.stringify({ seq: 3, chunk: startChunk('msg-1') });
    const result = parseChatReplayFrame(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.frame).toEqual({ seq: 3, chunk: startChunk('msg-1') });
    expect(isMessageFrame(result.frame)).toBe(false);
  });

  it('accepts a ChunkEnvelope with no seq at all (ephemeral live-tail-only chunk)', () => {
    const raw = JSON.stringify({
      chunk: { type: 'text-delta', id: 'a', delta: 'hi' },
    });
    const result = parseChatReplayFrame(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(frameSeq(result.frame)).toBeUndefined();
    expect(isMessageFrame(result.frame)).toBe(false);
  });

  it('accepts a MessageFrame (replay-only, always carries a seq)', () => {
    const message = assistantMessage('msg-1', [
      { type: 'text', text: 'hi', state: 'done' },
    ]);
    const raw = JSON.stringify({ seq: 5, message });
    const result = parseChatReplayFrame(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(isMessageFrame(result.frame)).toBe(true);
    if (!isMessageFrame(result.frame)) {
      return;
    }
    expect(frameSeq(result.frame)).toBe(5);
    expect(result.frame.message).toEqual(message);
  });

  it('rejects a MessageFrame with no seq (message frames are always durable/replayed)', () => {
    const message = userMessage('msg-1', 'hi');
    const result = chatReplayFrameSchema.safeParse({ message });
    expect(result.success).toBe(false);
  });

  it('rejects a frame carrying neither chunk nor message', () => {
    const result = chatReplayFrameSchema.safeParse({ seq: 1 });
    expect(result.success).toBe(false);
  });

  it('parseChatReplayFrame reports invalid JSON without throwing', () => {
    const result = parseChatReplayFrame('not json at all {');
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain('invalid JSON');
  });

  it('parseChatReplayFrame reports a structurally invalid payload (neither shape) without throwing', () => {
    const result = parseChatReplayFrame(JSON.stringify({ foo: 'bar' }));
    expect(result.ok).toBe(false);
  });

  it('a seq of 0 round-trips (falsy but valid)', () => {
    const raw = JSON.stringify({ seq: 0, chunk: finishChunk('stop') });
    const result = parseChatReplayFrame(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(frameSeq(result.frame)).toBe(0);
  });
});

describe('isMessageFrame', () => {
  it('narrows a MessageFrame', () => {
    const frame = messageFrame(1, userMessage('msg-1', 'hi'));
    expect(isMessageFrame(frame)).toBe(true);
  });

  it('narrows a ChunkEnvelope as false', () => {
    const frame = { seq: 1, chunk: startChunk('msg-1') };
    expect(isMessageFrame(frame)).toBe(false);
  });
});

describe('conversationMessagesListSchema', () => {
  it('parses { frames: [...] } — not a bare array', () => {
    const payload = {
      frames: [
        { seq: 1, chunk: startChunk('msg-1') },
        messageFrame(2, userMessage('msg-1', 'hi')),
      ],
    };
    const result = conversationMessagesListSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.frames).toHaveLength(2);
  });

  it('rejects a bare array (not wrapped in { frames })', () => {
    const result = conversationMessagesListSchema.safeParse([
      { seq: 1, chunk: startChunk('msg-1') },
    ]);
    expect(result.success).toBe(false);
  });

  it('accepts an empty frame list (a brand-new session with no history yet)', () => {
    const result = conversationMessagesListSchema.safeParse({ frames: [] });
    expect(result.success).toBe(true);
  });
});
