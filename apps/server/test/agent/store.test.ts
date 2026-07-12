import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../../src/agent/store.js';
import {
  appendAgentEvent,
  createChatSession,
  getChatSession,
  getMaxEventSeq,
  listAgentEvents,
  listChatSessions,
  updateChatSession,
} from '../../src/agent/store.js';
import { createTestDb, seedUser } from '../helpers/test-db.js';

describe('agent/store', () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
    seedUser(db, 'user-1');
    seedUser(db, 'user-2');
  });

  it('chat_sessions: create/list/get scoped by user, and update() patches status/nimboStateJson/lastActiveAt', () => {
    const row = createChatSession(db, {
      id: 'sess-1',
      userId: 'user-1',
      title: 'My session',
      repo: 'acme/demo',
      branchName: 'nimbo/chat-sess-1',
      sandboxName: 'nimbo-chat-sess-1',
    });
    expect(row.status).toBe('active');
    expect(row.nimboStateJson).toBeNull();

    createChatSession(db, {
      id: 'sess-2',
      userId: 'user-2',
      title: 'Someone else’s session',
      repo: 'acme/demo',
      branchName: 'nimbo/chat-sess-2',
      sandboxName: 'nimbo-chat-sess-2',
    });

    expect(listChatSessions(db, 'user-1').map((r) => r.id)).toEqual(['sess-1']);
    expect(listChatSessions(db, 'user-2').map((r) => r.id)).toEqual(['sess-2']);

    expect(getChatSession(db, 'sess-1', 'user-1')?.id).toBe('sess-1');
    expect(getChatSession(db, 'sess-1', 'user-2')).toBeUndefined(); // not this user's session
    expect(getChatSession(db, 'does-not-exist', 'user-1')).toBeUndefined();

    const patchTime = new Date('2026-01-01T00:00:00.000Z');
    updateChatSession(db, 'sess-1', {
      status: 'sleeping',
      nimboStateJson: '{"turn":1}',
      lastActiveAt: patchTime,
    });
    const updated = getChatSession(db, 'sess-1', 'user-1');
    expect(updated?.status).toBe('sleeping');
    expect(updated?.nimboStateJson).toBe('{"turn":1}');
    expect(updated?.lastActiveAt.toISOString()).toBe(patchTime.toISOString());
  });

  it('agent_events: seq is monotonic per session and continues from MAX(seq) across a fresh store instance', () => {
    createChatSession(db, {
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
    appendAgentEvent(db, {
      sessionId: 'sess-1',
      seq,
      type: 'session.started',
      payloadJson: JSON.stringify({
        type: 'session.started',
        sessionId: 'sess-1',
      }),
    });
    seq += 1;
    appendAgentEvent(db, {
      sessionId: 'sess-1',
      seq,
      type: 'turn.started',
      payloadJson: JSON.stringify({ type: 'turn.started', turn: 1 }),
    });

    expect(getMaxEventSeq(db, 'sess-1')).toBe(2);

    // "Process restart": a brand-new call to getMaxEventSeq must continue from the persisted max, not from 0.
    let resumedSeq = getMaxEventSeq(db, 'sess-1');
    resumedSeq += 1;
    appendAgentEvent(db, {
      sessionId: 'sess-1',
      seq: resumedSeq,
      type: 'turn.completed',
      payloadJson: JSON.stringify({ type: 'turn.completed', usage: {} }),
    });

    const rows = listAgentEvents(db, 'sess-1');
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.type)).toEqual([
      'session.started',
      'turn.started',
      'turn.completed',
    ]);

    expect(listAgentEvents(db, 'sess-1', 1).map((r) => r.seq)).toEqual([2, 3]);
    expect(listAgentEvents(db, 'sess-1', 3)).toEqual([]);
  });

  it('agent_events: seq sequences are independent per session', () => {
    createChatSession(db, {
      id: 'a',
      userId: 'user-1',
      title: 't',
      repo: 'acme/demo',
      branchName: 'b-a',
      sandboxName: 'sb-a',
    });
    createChatSession(db, {
      id: 'b',
      userId: 'user-1',
      title: 't',
      repo: 'acme/demo',
      branchName: 'b-b',
      sandboxName: 'sb-b',
    });

    appendAgentEvent(db, {
      sessionId: 'a',
      seq: 1,
      type: 'session.started',
      payloadJson: '{}',
    });
    appendAgentEvent(db, {
      sessionId: 'b',
      seq: 1,
      type: 'session.started',
      payloadJson: '{}',
    });
    appendAgentEvent(db, {
      sessionId: 'a',
      seq: 2,
      type: 'turn.started',
      payloadJson: '{}',
    });

    expect(getMaxEventSeq(db, 'a')).toBe(2);
    expect(getMaxEventSeq(db, 'b')).toBe(1);
    expect(listAgentEvents(db, 'a')).toHaveLength(2);
    expect(listAgentEvents(db, 'b')).toHaveLength(1);
  });
});
