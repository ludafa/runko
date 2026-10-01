import { describe, expect, it } from 'vitest';

import {
  chatReplayFrameSchema,
  conversationListSchema,
  conversationMessagesListSchema,
  conversationSchema,
  frameSeq,
  githubRepoRefSchema,
  githubRepoSchema,
  githubReposListSchema,
  githubStatusSchema,
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

// ---- 按用户授权加载 GitHub 仓库（docs/ingress/tech/github-repo-access.md §5） ----

describe('githubStatusSchema', () => {
  function status(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      configured: true,
      linked: true,
      installUrl: 'https://github.com/apps/demo-app/installations/new',
      ...overrides,
    };
  }

  it('接受合法的响应', () => {
    const result = githubStatusSchema.safeParse(status());
    expect(result.success).toBe(true);
  });

  it('installUrl 允许为 null（没配 App 时没有安装页）', () => {
    const result = githubStatusSchema.safeParse(
      status({ configured: false, linked: false, installUrl: null }),
    );
    expect(result.success).toBe(true);
  });

  it('installUrl 缺失（不是 null，是完全没有这个字段）时拒绝', () => {
    const result = githubStatusSchema.safeParse({
      configured: true,
      linked: true,
    });
    expect(result.success).toBe(false);
  });

  it('configured 缺失时拒绝', () => {
    const result = githubStatusSchema.safeParse({
      linked: true,
      installUrl: null,
    });
    expect(result.success).toBe(false);
  });
});

describe('githubRepoSchema / githubReposListSchema', () => {
  function repo(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      installationId: 1,
      repoId: 100,
      fullName: 'acme/demo',
      private: false,
      defaultBranch: 'main',
      ...overrides,
    };
  }

  it('接受合法的一条仓库', () => {
    const result = githubRepoSchema.safeParse(repo());
    expect(result.success).toBe(true);
  });

  it('installationId 不是整数（比如带小数）时拒绝', () => {
    const result = githubRepoSchema.safeParse(repo({ installationId: 1.5 }));
    expect(result.success).toBe(false);
  });

  it('repoId 不是整数（比如是字符串）时拒绝', () => {
    const result = githubRepoSchema.safeParse(repo({ repoId: '100' }));
    expect(result.success).toBe(false);
  });

  it('缺少 fullName 时拒绝', () => {
    const result = githubRepoSchema.safeParse({
      installationId: 1,
      repoId: 100,
      private: false,
      defaultBranch: 'main',
    });
    expect(result.success).toBe(false);
  });

  it('githubReposListSchema 要求包在 { repos } 里，不接受裸数组', () => {
    const wrapped = githubReposListSchema.safeParse({ repos: [repo()] });
    expect(wrapped.success).toBe(true);

    const bare = githubReposListSchema.safeParse([repo()]);
    expect(bare.success).toBe(false);
  });
});

describe('githubRepoRefSchema — POST /api/chat/conversations 里 repo 字段的形状', () => {
  it('只要 installationId/repoId 两个整数字段，多余字段不影响', () => {
    const result = githubRepoRefSchema.safeParse({
      installationId: 1,
      repoId: 100,
      fullName: '多余字段也能过',
    });
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    // .pick() 出来的 schema 不带多余字段
    expect(result.data).toEqual({ installationId: 1, repoId: 100 });
  });

  it('installationId 非整数时拒绝', () => {
    const result = githubRepoRefSchema.safeParse({
      installationId: 1.1,
      repoId: 100,
    });
    expect(result.success).toBe(false);
  });

  it('缺少 repoId 时拒绝', () => {
    const result = githubRepoRefSchema.safeParse({ installationId: 1 });
    expect(result.success).toBe(false);
  });
});
