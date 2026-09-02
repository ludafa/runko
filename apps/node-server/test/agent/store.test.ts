import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../../src/agent/store.js';
import {
  createConversation,
  getConversation,
  listConversations,
  parseAvailableSkills,
  syncAvailableSkills,
  updateConversation,
} from '../../src/agent/store.js';
import { createLogger } from '../../src/logger.js';
import { createTestDb, seedUser } from '../helpers/test-db.js';

describe('agent/store', () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
    seedUser(db, 'user-1');
    seedUser(db, 'user-2');
  });

  it('conversations: create/list/get scoped by user — a fresh row has a null runko header (docs/tech/single-ledger.md §5 单-3)', () => {
    const row = createConversation(db, {
      id: 'sess-1',
      userId: 'user-1',
      title: 'My session',
      repo: 'acme/demo',
      branchName: 'runko/chat-sess-1',
      sandboxName: 'runko-chat-sess-1',
    });
    expect(row.status).toBe('active');
    expect(row.agentSessionId).toBeNull();
    expect(row.agentSessionCreatedAt).toBeNull();
    expect(row.agentSessionTurn).toBeNull();

    createConversation(db, {
      id: 'sess-2',
      userId: 'user-2',
      title: 'Someone else’s session',
      repo: 'acme/demo',
      branchName: 'runko/chat-sess-2',
      sandboxName: 'runko-chat-sess-2',
    });

    expect(listConversations(db, 'user-1').map((r) => r.id)).toEqual([
      'sess-1',
    ]);
    expect(listConversations(db, 'user-2').map((r) => r.id)).toEqual([
      'sess-2',
    ]);

    expect(getConversation(db, 'sess-1', 'user-1')?.id).toBe('sess-1');
    expect(getConversation(db, 'sess-1', 'user-2')).toBeUndefined(); // not this user's session
    expect(getConversation(db, 'does-not-exist', 'user-1')).toBeUndefined();
  });

  it('createConversation: provider/sandboxId default to vercel/null when omitted (docs/tech/sandbox-provider.md §2)', () => {
    const row = createConversation(db, {
      id: 'sess-1',
      userId: 'user-1',
      title: 'My session',
      repo: 'acme/demo',
      branchName: 'runko/chat-sess-1',
      sandboxName: 'runko-chat-sess-1',
    });
    expect(row.provider).toBe('vercel');
    expect(row.sandboxId).toBeNull();
  });

  it('createConversation: an explicit provider/sandboxId (E2B) are persisted as given', () => {
    const row = createConversation(db, {
      id: 'sess-e2b',
      userId: 'user-1',
      title: 'E2B session',
      repo: 'acme/demo',
      branchName: 'runko/chat-sess-e2b',
      sandboxName: 'runko-chat-sess-e2b',
      provider: 'e2b',
      sandboxId: 'sbx_123',
    });
    expect(row.provider).toBe('e2b');
    expect(row.sandboxId).toBe('sbx_123');
  });

  it('updateConversation: a sandboxId-only patch persists in isolation — status/lastActiveAt and the runko header columns are untouched (docs/tech/sandbox-provider.md §3.1)', () => {
    createConversation(db, {
      id: 'sess-1',
      userId: 'user-1',
      title: 'My session',
      repo: 'acme/demo',
      branchName: 'runko/chat-sess-1',
      sandboxName: 'runko-chat-sess-1',
      provider: 'e2b',
    });
    const before = getConversation(db, 'sess-1', 'user-1');
    expect(before?.sandboxId).toBeNull();

    updateConversation(db, 'sess-1', { sandboxId: 'sbx_new' });

    const after = getConversation(db, 'sess-1', 'user-1');
    expect(after?.sandboxId).toBe('sbx_new');
    // Unrelated columns untouched by a sandboxId-only patch.
    expect(after?.status).toBe(before?.status);
    expect(after?.lastActiveAt.toISOString()).toBe(
      before?.lastActiveAt.toISOString(),
    );
    expect(after?.agentSessionId).toBeNull();
    expect(after?.agentSessionCreatedAt).toBeNull();
    expect(after?.agentSessionTurn).toBeNull();

    // A second patch overwrites it again (e.g. a further rebuild).
    updateConversation(db, 'sess-1', { sandboxId: 'sbx_newer' });
    expect(getConversation(db, 'sess-1', 'user-1')?.sandboxId).toBe(
      'sbx_newer',
    );
  });

  it('updateConversation: status/lastActiveAt patch independently of the runko header (agentSessionHeader omitted leaves the header columns untouched)', () => {
    createConversation(db, {
      id: 'sess-1',
      userId: 'user-1',
      title: 'My session',
      repo: 'acme/demo',
      branchName: 'runko/chat-sess-1',
      sandboxName: 'runko-chat-sess-1',
    });

    const patchTime = new Date('2026-01-01T00:00:00.000Z');
    updateConversation(db, 'sess-1', {
      status: 'sleeping',
      lastActiveAt: patchTime,
    });
    const updated = getConversation(db, 'sess-1', 'user-1');
    expect(updated?.status).toBe('sleeping');
    expect(updated?.lastActiveAt.toISOString()).toBe(patchTime.toISOString());
    // runko header columns untouched — still the fresh-session null triple.
    expect(updated?.agentSessionId).toBeNull();
    expect(updated?.agentSessionCreatedAt).toBeNull();
    expect(updated?.agentSessionTurn).toBeNull();
  });

  it('updateConversation: agentSessionHeader patch writes all three scalar columns together (docs/tech/single-ledger.md §5 单-3 "session header")', () => {
    createConversation(db, {
      id: 'sess-1',
      userId: 'user-1',
      title: 'My session',
      repo: 'acme/demo',
      branchName: 'runko/chat-sess-1',
      sandboxName: 'runko-chat-sess-1',
    });

    const createdAt = new Date('2026-01-02T00:00:00.000Z');
    updateConversation(db, 'sess-1', {
      status: 'active',
      agentSessionHeader: {
        conversationId: 'runko-sess-abc',
        createdAt,
        turn: 1,
      },
    });

    const updated = getConversation(db, 'sess-1', 'user-1');
    expect(updated?.agentSessionId).toBe('runko-sess-abc');
    expect(updated?.agentSessionCreatedAt?.toISOString()).toBe(
      createdAt.toISOString(),
    );
    expect(updated?.agentSessionTurn).toBe(1);

    // A second patch (turn 2, same session id/createdAt as a real "resumed" turn would send) overwrites all three again.
    updateConversation(db, 'sess-1', {
      agentSessionHeader: {
        conversationId: 'runko-sess-abc',
        createdAt,
        turn: 2,
      },
    });
    expect(getConversation(db, 'sess-1', 'user-1')?.agentSessionTurn).toBe(2);
  });

  describe('available skills column', () => {
    beforeEach(() => {
      createConversation(db, {
        id: 'sess-1',
        userId: 'user-1',
        title: 'My session',
        repo: 'acme/demo',
        branchName: 'runko/chat-sess-1',
        sandboxName: 'runko-chat-sess-1',
      });
    });

    it('a fresh conversation starts with an empty catalog', () => {
      const row = getConversation(db, 'sess-1', 'user-1');

      expect(row?.availableSkillsJson).toBe('[]');
      expect(
        parseAvailableSkills(row?.availableSkillsJson ?? '', 'sess-1'),
      ).toEqual([]);
    });

    it('round-trips a catalog through the column', () => {
      const skills = [
        { name: 'code-review', description: 'Review a diff.' },
        { name: 'frontend-design', description: 'Improve a web UI.' },
      ];

      syncAvailableSkills(db, 'sess-1', '[]', skills);

      const row = getConversation(db, 'sess-1', 'user-1');
      expect(
        parseAvailableSkills(row?.availableSkillsJson ?? '', 'sess-1'),
      ).toEqual(skills);
    });

    it('returns the current json unchanged — and issues no write — when the catalog has not moved', () => {
      const skills = [
        { name: 'frontend-design', description: 'Improve a web UI.' },
      ];
      const firstJson = syncAvailableSkills(db, 'sess-1', '[]', skills);

      // 第二次同样的清单：拿到同一个 json，且没有写库（这正是每轮起轮都调它却
      // 不给 DB 添无谓写入的原因 —— 见 store.ts 的 syncAvailableSkills 注释）。
      const secondJson = syncAvailableSkills(db, 'sess-1', firstJson, skills);

      expect(secondJson).toBe(firstJson);
    });

    it('treats a corrupt column as an empty catalog instead of throwing', () => {
      const lines: string[] = [];
      const log = createLogger({ sink: (line) => lines.push(line) });

      expect(parseAvailableSkills('not json at all', 'sess-1', log)).toEqual(
        [],
      );
      expect(parseAvailableSkills('{"not":"an array"}', 'sess-1', log)).toEqual(
        [],
      );
      // 形状不对（缺 description）也当空清单
      expect(parseAvailableSkills('[{"name":"x"}]', 'sess-1', log)).toEqual([]);
      expect(lines.length).toBe(3);
    });
  });
});
