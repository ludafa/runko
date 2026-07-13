import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../../src/agent/store.js';
import {
  createChatSession,
  getChatSession,
  listAgentEvents,
} from '../../src/agent/store.js';
import {
  isTurnActive,
  startTurn,
  steerTurn,
  subscribeTurn,
} from '../../src/agent/turn-runner.js';
import {
  createControllableSession,
  createSteerableControllableSession,
} from '../helpers/controllable-session.js';
import { createTestDb, seedUser } from '../helpers/test-db.js';

// `createControllableSession`'s internal wake/queue is driven purely by
// promise resolution (no timers) — Node always fully drains the microtask
// queue before running the next macrotask, so waiting on one `setImmediate`
// boundary reliably lets `driveTurn`'s background loop finish reacting to
// whatever was just pushed, however many promise hops that takes.
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

describe('agent/turn-runner', () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
    seedUser(db, 'user-1');
    createChatSession(db, {
      id: 'sess-1',
      userId: 'user-1',
      title: 'Session',
      repo: 'acme/demo',
      branchName: 'nimbo/chat-sess-1',
      sandboxName: 'nimbo-chat-sess-1',
    });
  });

  it('drives a turn end to end: user.message persisted first (synchronously, before any subscriber can attach), forwarded SessionEvents persisted+emitted in order, then turn.result — isTurnActive flips false and "done" fires once drained', async () => {
    const fake = createControllableSession();

    const result = startTurn({
      db,
      sessionId: 'sess-1',
      session: fake,
      text: '你好',
    });
    expect(result).toEqual({ started: true });
    expect(isTurnActive('sess-1')).toBe(true);

    // `startTurn` runs `driveTurn`'s synchronous prefix (which already emits
    // `user.message`) before returning — a subscriber attached only *after*
    // `startTurn` returns necessarily misses it (`routes/chat.ts`'s
    // `GET .../stream` covers exactly this gap with a DB replay before it
    // ever calls `subscribeTurn`; that's this module's contract, not a bug
    // here).
    const received: { seq: number; type: string }[] = [];
    let doneCalls = 0;
    const unsubscribe = subscribeTurn(
      'sess-1',
      (envelope) =>
        received.push({ seq: envelope.seq, type: envelope.event.type }),
      () => {
        doneCalls += 1;
      },
    );

    fake.pushEvent({ type: 'session.started', sessionId: 'sess-1' });
    await flushMicrotasks();
    fake.pushEvent({ type: 'turn.started', turn: 1 });
    await flushMicrotasks();
    fake.finish({ items: [], finalResponse: 'hi there', usage: {} });
    await flushMicrotasks();

    expect(isTurnActive('sess-1')).toBe(false);
    expect(doneCalls).toBe(1);
    expect(received.map((e) => e.type)).toEqual([
      'session.started',
      'turn.started',
      'turn.result',
    ]);
    expect(received.map((e) => e.seq)).toEqual([2, 3, 4]);

    const persisted = listAgentEvents(db, 'sess-1');
    expect(persisted.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(persisted.map((r) => r.type)).toEqual([
      'user.message',
      'session.started',
      'turn.started',
      'turn.result',
    ]);
    expect(JSON.parse(persisted[0]?.payloadJson ?? '{}')).toEqual({
      type: 'user.message',
      text: '你好',
    });
    expect(JSON.parse(persisted.at(-1)?.payloadJson ?? '{}')).toEqual({
      type: 'turn.result',
      finalResponse: 'hi there',
      usage: {},
    });

    const row = getChatSession(db, 'sess-1', 'user-1');
    expect(row?.nimboStateJson).not.toBeNull();

    unsubscribe();
  });

  it('rejects a second startTurn while one is already active for the same session', () => {
    const fake = createControllableSession();
    const first = startTurn({
      db,
      sessionId: 'sess-1',
      session: fake,
      text: 'a',
    });
    expect(first).toEqual({ started: true });

    const second = startTurn({
      db,
      sessionId: 'sess-1',
      session: fake,
      text: 'b',
    });
    expect(second).toEqual({ started: false });

    fake.finish({ items: [], finalResponse: 'ok', usage: {} });
  });

  it('allows starting a new turn once the previous one has finished, with seq continuing to climb across turns', async () => {
    const first = createControllableSession();
    startTurn({ db, sessionId: 'sess-1', session: first, text: 'a' });
    first.finish({ items: [], finalResponse: 'first', usage: {} });
    await flushMicrotasks();
    expect(isTurnActive('sess-1')).toBe(false);

    const second = createControllableSession();
    const result = startTurn({
      db,
      sessionId: 'sess-1',
      session: second,
      text: 'b',
    });
    expect(result).toEqual({ started: true });
    expect(isTurnActive('sess-1')).toBe(true);
    second.finish({ items: [], finalResponse: 'second', usage: {} });
    await flushMicrotasks();

    const persisted = listAgentEvents(db, 'sess-1');
    // 2 turns * 2 events each (user.message + turn.result, no mid-stream events pushed).
    expect(persisted.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(persisted.map((r) => r.type)).toEqual([
      'user.message',
      'turn.result',
      'user.message',
      'turn.result',
    ]);
  });

  it('an exception thrown while driving session.stream() (not a yielded turn.failed SessionEvent) emits/persists the turn-runner’s own turn.failed sentinel instead of turn.result, and never updates nimboStateJson', async () => {
    const fake = createControllableSession();
    startTurn({ db, sessionId: 'sess-1', session: fake, text: 'boom' });

    const received: { event: unknown }[] = [];
    subscribeTurn(
      'sess-1',
      (envelope) => received.push({ event: envelope.event }),
      () => undefined,
    );

    fake.fail(new Error('provider exploded'));
    await flushMicrotasks();

    expect(isTurnActive('sess-1')).toBe(false);
    expect(received.at(-1)?.event).toEqual({
      type: 'turn.failed',
      code: 'internal_error',
      message: 'provider exploded',
    });

    const persisted = listAgentEvents(db, 'sess-1');
    expect(persisted.map((r) => r.type)).toEqual([
      'user.message',
      'turn.failed',
    ]);

    const row = getChatSession(db, 'sess-1', 'user-1');
    expect(row?.nimboStateJson).toBeNull(); // never touched — no well-defined TurnResult to persist
    expect(fake.toJSONCalls).toHaveLength(0);
  });

  it('a SessionEvent-level turn.failed (session.stream() degrading gracefully, not throwing) still flows through as a normal event, followed by a turn.result sentinel', async () => {
    const fake = createControllableSession();
    startTurn({ db, sessionId: 'sess-1', session: fake, text: 'hi' });

    const received: { type: string }[] = [];
    subscribeTurn(
      'sess-1',
      (envelope) => received.push({ type: envelope.event.type }),
      () => undefined,
    );

    fake.pushEvent({
      type: 'turn.failed',
      error: { code: 'max_turns', message: 'ran out of turns' },
    });
    await flushMicrotasks();
    fake.finish({ items: [], finalResponse: '', usage: {} });
    await flushMicrotasks();

    expect(received.map((e) => e.type)).toEqual(['turn.failed', 'turn.result']);
    const row = getChatSession(db, 'sess-1', 'user-1');
    expect(row?.nimboStateJson).not.toBeNull(); // this path *does* reach updateChatSession
  });

  it('subscribeTurn is a no-op (safe-to-call unsubscribe) when there is no active turn for the session', () => {
    expect(isTurnActive('sess-does-not-exist')).toBe(false);
    let eventCalls = 0;
    let doneCalls = 0;
    const unsubscribe = subscribeTurn(
      'sess-does-not-exist',
      () => {
        eventCalls += 1;
      },
      () => {
        doneCalls += 1;
      },
    );
    expect(() => {
      unsubscribe();
    }).not.toThrow();
    expect(eventCalls).toBe(0);
    expect(doneCalls).toBe(0);
  });

  it('unsubscribe stops further delivery to that listener without affecting other subscribers', async () => {
    const fake = createControllableSession();
    startTurn({ db, sessionId: 'sess-1', session: fake, text: 'hi' });

    const a: string[] = [];
    const b: string[] = [];
    const unsubscribeA = subscribeTurn(
      'sess-1',
      (envelope) => a.push(envelope.event.type),
      () => undefined,
    );
    subscribeTurn(
      'sess-1',
      (envelope) => b.push(envelope.event.type),
      () => undefined,
    );

    fake.pushEvent({ type: 'turn.started', turn: 1 });
    await flushMicrotasks();
    unsubscribeA();
    fake.pushEvent({ type: 'turn.completed', usage: {} });
    await flushMicrotasks();
    fake.finish({ items: [], finalResponse: 'done', usage: {} });
    await flushMicrotasks();

    expect(a).toEqual(['turn.started']); // unsubscribed before turn.completed/turn.result
    expect(b).toEqual(['turn.started', 'turn.completed', 'turn.result']);
  });

  // ---------------------------------------------------------------------------
  // steerTurn (STEER-3B, this module's header comment) — the four states
  // `routes/chat.ts`'s `POST .../messages` branches on.
  // ---------------------------------------------------------------------------

  describe('steerTurn', () => {
    it('returns false when there is no active turn for the session at all', () => {
      expect(isTurnActive('sess-1')).toBe(false);
      expect(steerTurn('sess-1', 'hello')).toBe(false);
    });

    it('returns true and forwards the text to session.steer() when a turn is active and steer() reports success', () => {
      const steerable = createSteerableControllableSession();
      const { started } = startTurn({
        db,
        sessionId: 'sess-1',
        session: steerable,
        text: 'first',
      });
      expect(started).toBe(true);

      expect(steerTurn('sess-1', 'also check the tests')).toBe(true);
      expect(steerable.steerCalls).toEqual(['also check the tests']);

      steerable.finish({ items: [], finalResponse: 'ok', usage: {} });
    });

    it('returns false when the active turn’s session has no steer() method at all (e.g. a plain createControllableSession fixture)', () => {
      const plain = createControllableSession();
      const { started } = startTurn({
        db,
        sessionId: 'sess-1',
        session: plain,
        text: 'first',
      });
      expect(started).toBe(true);

      expect(steerTurn('sess-1', 'hello')).toBe(false);

      plain.finish({ items: [], finalResponse: 'ok', usage: {} });
    });

    it('returns false when session.steer() itself reports failure (the narrow race: the turn finished between steerTurn finding it active and steer() checking its own in-flight state)', () => {
      const steerable = createSteerableControllableSession();
      steerable.setSteerResult(false);
      const { started } = startTurn({
        db,
        sessionId: 'sess-1',
        session: steerable,
        text: 'first',
      });
      expect(started).toBe(true);

      expect(steerTurn('sess-1', 'too late')).toBe(false);
      // steer() was still actually called — it's the *result* that's false, not a short-circuit.
      expect(steerable.steerCalls).toEqual(['too late']);

      steerable.finish({ items: [], finalResponse: 'ok', usage: {} });
    });
  });
});
