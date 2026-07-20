import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../../src/agent/store.js';
import {
  appendConversationEvent,
  createConversation,
  deleteChunkEventsAfter,
  getConversation,
  getMaxEventSeq,
  listConversationEvents,
  listConversations,
  updateConversation,
} from '../../src/agent/store.js';
import { createTestDb, seedUser } from '../helpers/test-db.js';

describe('agent/store', () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
    seedUser(db, 'user-1');
    seedUser(db, 'user-2');
  });

  it('conversations: create/list/get scoped by user — a fresh row has a null nimbo header (docs/tech/single-ledger.md §5 单-3)', () => {
    const row = createConversation(db, {
      id: 'sess-1',
      userId: 'user-1',
      title: 'My session',
      repo: 'acme/demo',
      branchName: 'nimbo/chat-sess-1',
      sandboxName: 'nimbo-chat-sess-1',
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
      branchName: 'nimbo/chat-sess-2',
      sandboxName: 'nimbo-chat-sess-2',
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
      branchName: 'nimbo/chat-sess-1',
      sandboxName: 'nimbo-chat-sess-1',
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
      branchName: 'nimbo/chat-sess-e2b',
      sandboxName: 'nimbo-chat-sess-e2b',
      provider: 'e2b',
      sandboxId: 'sbx_123',
    });
    expect(row.provider).toBe('e2b');
    expect(row.sandboxId).toBe('sbx_123');
  });

  it('updateConversation: a sandboxId-only patch persists in isolation — status/lastActiveAt and the nimbo header columns are untouched (docs/tech/sandbox-provider.md §3.1)', () => {
    createConversation(db, {
      id: 'sess-1',
      userId: 'user-1',
      title: 'My session',
      repo: 'acme/demo',
      branchName: 'nimbo/chat-sess-1',
      sandboxName: 'nimbo-chat-sess-1',
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

  it('updateConversation: status/lastActiveAt patch independently of the nimbo header (agentSessionHeader omitted leaves the header columns untouched)', () => {
    createConversation(db, {
      id: 'sess-1',
      userId: 'user-1',
      title: 'My session',
      repo: 'acme/demo',
      branchName: 'nimbo/chat-sess-1',
      sandboxName: 'nimbo-chat-sess-1',
    });

    const patchTime = new Date('2026-01-01T00:00:00.000Z');
    updateConversation(db, 'sess-1', {
      status: 'sleeping',
      lastActiveAt: patchTime,
    });
    const updated = getConversation(db, 'sess-1', 'user-1');
    expect(updated?.status).toBe('sleeping');
    expect(updated?.lastActiveAt.toISOString()).toBe(patchTime.toISOString());
    // nimbo header columns untouched — still the fresh-session null triple.
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
      branchName: 'nimbo/chat-sess-1',
      sandboxName: 'nimbo-chat-sess-1',
    });

    const createdAt = new Date('2026-01-02T00:00:00.000Z');
    updateConversation(db, 'sess-1', {
      status: 'active',
      agentSessionHeader: {
        conversationId: 'nimbo-sess-abc',
        createdAt,
        turn: 1,
      },
    });

    const updated = getConversation(db, 'sess-1', 'user-1');
    expect(updated?.agentSessionId).toBe('nimbo-sess-abc');
    expect(updated?.agentSessionCreatedAt?.toISOString()).toBe(
      createdAt.toISOString(),
    );
    expect(updated?.agentSessionTurn).toBe(1);

    // A second patch (turn 2, same session id/createdAt as a real "resumed" turn would send) overwrites all three again.
    updateConversation(db, 'sess-1', {
      agentSessionHeader: {
        conversationId: 'nimbo-sess-abc',
        createdAt,
        turn: 2,
      },
    });
    expect(getConversation(db, 'sess-1', 'user-1')?.agentSessionTurn).toBe(2);
  });

  it('conversation_events: appendConversationEvent carries the kind discriminator through to listConversationEvents', () => {
    createConversation(db, {
      id: 'sess-1',
      userId: 'user-1',
      title: 'My session',
      repo: 'acme/demo',
      branchName: 'nimbo/chat-sess-1',
      sandboxName: 'nimbo-chat-sess-1',
    });

    appendConversationEvent(db, {
      conversationId: 'sess-1',
      seq: 1,
      kind: 'chunk',
      payloadJson: JSON.stringify({
        id: 't1',
        delta: 'hi',
      }),
    });
    appendConversationEvent(db, {
      conversationId: 'sess-1',
      seq: 2,
      kind: 'message',
      payloadJson: JSON.stringify({ id: 'm1', role: 'user', parts: [] }),
    });

    const rows = listConversationEvents(db, 'sess-1');
    expect(rows.map((r) => r.kind)).toEqual(['chunk', 'message']);
  });

  it('conversation_events: seq is monotonic per session (spans both kinds) and continues from MAX(seq) across a fresh store instance', () => {
    createConversation(db, {
      id: 'sess-1',
      userId: 'user-1',
      title: 'My session',
      repo: 'acme/demo',
      branchName: 'nimbo/chat-sess-1',
      sandboxName: 'nimbo-chat-sess-1',
    });

    expect(getMaxEventSeq(db, 'sess-1')).toBe(0);

    let seq = getMaxEventSeq(db, 'sess-1');
    seq += 1;
    appendConversationEvent(db, {
      conversationId: 'sess-1',
      seq,
      kind: 'chunk',
      payloadJson: JSON.stringify({ type: 'start', messageId: 'm1' }),
    });
    seq += 1;
    appendConversationEvent(db, {
      conversationId: 'sess-1',
      seq,
      kind: 'chunk',
      payloadJson: JSON.stringify({ type: 'start-step' }),
    });

    expect(getMaxEventSeq(db, 'sess-1')).toBe(2);

    // "Process restart": a brand-new call to getMaxEventSeq must continue from the persisted max, not from 0.
    let resumedSeq = getMaxEventSeq(db, 'sess-1');
    resumedSeq += 1;
    appendConversationEvent(db, {
      conversationId: 'sess-1',
      seq: resumedSeq,
      kind: 'message',
      payloadJson: JSON.stringify({ id: 'm1', role: 'assistant', parts: [] }),
    });

    const rows = listConversationEvents(db, 'sess-1');
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.kind)).toEqual(['chunk', 'chunk', 'message']);

    expect(listConversationEvents(db, 'sess-1', 1).map((r) => r.seq)).toEqual([
      2, 3,
    ]);
    expect(listConversationEvents(db, 'sess-1', 3)).toEqual([]);
  });

  it('conversation_events: seq sequences are independent per session', () => {
    createConversation(db, {
      id: 'a',
      userId: 'user-1',
      title: 't',
      repo: 'acme/demo',
      branchName: 'b-a',
      sandboxName: 'sb-a',
    });
    createConversation(db, {
      id: 'b',
      userId: 'user-1',
      title: 't',
      repo: 'acme/demo',
      branchName: 'b-b',
      sandboxName: 'sb-b',
    });

    appendConversationEvent(db, {
      conversationId: 'a',
      seq: 1,
      kind: 'chunk',
      payloadJson: '{}',
    });
    appendConversationEvent(db, {
      conversationId: 'b',
      seq: 1,
      kind: 'chunk',
      payloadJson: '{}',
    });
    appendConversationEvent(db, {
      conversationId: 'a',
      seq: 2,
      kind: 'chunk',
      payloadJson: '{}',
    });

    expect(getMaxEventSeq(db, 'a')).toBe(2);
    expect(getMaxEventSeq(db, 'b')).toBe(1);
    expect(listConversationEvents(db, 'a')).toHaveLength(2);
    expect(listConversationEvents(db, 'b')).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // deleteChunkEventsAfter (docs/tech/single-ledger.md §5 单-3's turn-finalization GC) — deletes
  // exactly the `kind = 'chunk'` rows with `seq > afterSeq`, leaving every
  // `kind = 'message'` row and every earlier/other-session `chunk` row alone.
  // ---------------------------------------------------------------------------

  describe('deleteChunkEventsAfter', () => {
    beforeEach(() => {
      createConversation(db, {
        id: 'sess-1',
        userId: 'user-1',
        title: 'My session',
        repo: 'acme/demo',
        branchName: 'nimbo/chat-sess-1',
        sandboxName: 'nimbo-chat-sess-1',
      });
    });

    it('deletes only chunk rows with seq strictly greater than afterSeq, leaving message rows (any seq) and earlier chunk rows untouched', () => {
      appendConversationEvent(db, {
        conversationId: 'sess-1',
        seq: 1,
        kind: 'chunk',
        payloadJson: '{}',
      }); // seq <= afterSeq(2) — survives
      appendConversationEvent(db, {
        conversationId: 'sess-1',
        seq: 2,
        kind: 'message',
        payloadJson: '{}',
      }); // message kind — always survives regardless of seq
      appendConversationEvent(db, {
        conversationId: 'sess-1',
        seq: 3,
        kind: 'chunk',
        payloadJson: '{}',
      }); // seq > afterSeq(2) — deleted
      appendConversationEvent(db, {
        conversationId: 'sess-1',
        seq: 4,
        kind: 'chunk',
        payloadJson: '{}',
      }); // seq > afterSeq(2) — deleted

      deleteChunkEventsAfter(db, 'sess-1', 2);

      const remaining = listConversationEvents(db, 'sess-1');
      expect(remaining.map((r) => r.seq)).toEqual([1, 2]);
      expect(remaining.map((r) => r.kind)).toEqual(['chunk', 'message']);
    });

    it('is a no-op when there is nothing past afterSeq', () => {
      appendConversationEvent(db, {
        conversationId: 'sess-1',
        seq: 1,
        kind: 'chunk',
        payloadJson: '{}',
      });
      deleteChunkEventsAfter(db, 'sess-1', 10);
      expect(listConversationEvents(db, 'sess-1')).toHaveLength(1);
    });

    it('only touches the given session — another session’s chunk rows past the same afterSeq are left alone', () => {
      createConversation(db, {
        id: 'sess-2',
        userId: 'user-1',
        title: 'Other',
        repo: 'acme/demo',
        branchName: 'nimbo/chat-sess-2',
        sandboxName: 'nimbo-chat-sess-2',
      });
      appendConversationEvent(db, {
        conversationId: 'sess-1',
        seq: 1,
        kind: 'chunk',
        payloadJson: '{}',
      });
      appendConversationEvent(db, {
        conversationId: 'sess-2',
        seq: 1,
        kind: 'chunk',
        payloadJson: '{}',
      });

      deleteChunkEventsAfter(db, 'sess-1', 0);

      expect(listConversationEvents(db, 'sess-1')).toHaveLength(0);
      expect(listConversationEvents(db, 'sess-2')).toHaveLength(1); // untouched
    });

    it('multi-turn boundary: a later turn’s GC (afterSeq = its own start seq) never deletes an earlier turn’s crash-residue chunk rows (docs/tech/single-ledger.md §5 单-3 accepted residue)', () => {
      // Turn 1: finished gracefully — one message row.
      appendConversationEvent(db, {
        conversationId: 'sess-1',
        seq: 1,
        kind: 'message',
        payloadJson: '{"turn":1}',
      });

      // Turn 2: crashed mid-flight — a durable chunk row and the synthetic
      // failed message-metadata chunk, neither ever GC'd (finalizeTurnPersistence
      // never ran for this turn).
      appendConversationEvent(db, {
        conversationId: 'sess-1',
        seq: 2,
        kind: 'chunk',
        payloadJson: '{"turn":2}',
      });
      appendConversationEvent(db, {
        conversationId: 'sess-1',
        seq: 3,
        kind: 'chunk',
        payloadJson: '{"turn":2,"status":"failed"}',
      });

      // Turn 3 starts with turnStartSeq = 3 (getMaxEventSeq at turn-start
      // time), pushes its own chunk rows, then finishes gracefully.
      appendConversationEvent(db, {
        conversationId: 'sess-1',
        seq: 4,
        kind: 'chunk',
        payloadJson: '{"turn":3}',
      });
      appendConversationEvent(db, {
        conversationId: 'sess-1',
        seq: 5,
        kind: 'message',
        payloadJson: '{"turn":3}',
      });

      deleteChunkEventsAfter(db, 'sess-1', 3); // turn 3's own turnStartSeq

      const remaining = listConversationEvents(db, 'sess-1');
      // Turn 3's own now-superseded chunk row (seq 4) is gone; turn 2's
      // crash-residue chunk rows (seq 2, 3) survive untouched, since their
      // seq is <= this GC's afterSeq.
      expect(remaining.map((r) => r.seq)).toEqual([1, 2, 3, 5]);
      expect(remaining.map((r) => r.kind)).toEqual([
        'message',
        'chunk',
        'chunk',
        'message',
      ]);
    });
  });
});
