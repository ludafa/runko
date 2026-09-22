import { describe, expect, it } from 'vitest';

import {
  chatReplayFrameSchema,
  conversationListSchema,
  conversationMessagesListSchema,
  conversationSchema,
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
} from './helpers/runko-chunks';

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

describe('conversationSchema — 本地沙盒（provider: local，repo/branchName: null）', () => {
  /** 本地沙盒没有仓库、没有分支——服务端会给 `repo`/`branchName` 记 `null`（docs/ingress/tech/unified-demo.md §4.3）。 */
  function localConversation(): Record<string, unknown> {
    return {
      id: 'conv-local',
      title: null,
      repo: null,
      branchName: null,
      sandboxName: 'runko-conv-local',
      provider: 'local',
      status: 'active',
      lastActiveAt: new Date(0).toISOString(),
      queuedMessages: [],
      availableSkills: [],
      turnInProgress: false,
      pendingDecisions: 0,
      createdAt: new Date(0).toISOString(),
    };
  }

  it('解析 provider: local 且 repo/branchName: null，不报错', () => {
    const result = conversationSchema.safeParse(localConversation());
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.provider).toBe('local');
    expect(result.data.repo).toBeNull();
    expect(result.data.branchName).toBeNull();
  });

  it('会话列表里混着云沙盒（有仓库/分支）与本地沙盒（都是 null）也能一起解析', () => {
    const result = conversationListSchema.safeParse([
      localConversation(),
      {
        ...localConversation(),
        id: 'conv-cloud',
        provider: 'e2b',
        repo: 'acme/demo',
        branchName: 'runko/chat-abc',
      },
    ]);
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data).toHaveLength(2);
  });
});
