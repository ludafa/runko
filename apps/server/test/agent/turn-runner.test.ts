import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../../src/agent/store.js';
import {
  createChatSession,
  getChatSession,
  listAgentEvents,
} from '../../src/agent/store.js';
import {
  isTurnActive,
  requestApproval,
  requestUserAnswer,
  resolveApproval,
  resolveUserAnswer,
  startTurn,
  steerTurn,
  subscribeTurn,
} from '../../src/agent/turn-runner.js';
import type {
  ChatEventEnvelope,
  ChatStreamEvent,
} from '../../src/schemas/chat.js';
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
    // `seq` is `number | undefined` on the envelope type (docs/08 §2.2d: only
    // ephemeral `item.updated` frames omit it) — none of the events pushed
    // below are ephemeral, so the assertion further down still expects
    // concrete numbers.
    const received: { seq: number | undefined; type: string }[] = [];
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

  // ---------------------------------------------------------------------------
  // Approval bridge (docs/08 §2.2c（审批链）) — requestApproval/resolveApproval.
  // ---------------------------------------------------------------------------

  describe('requestApproval / resolveApproval', () => {
    it('denies immediately, without registering or emitting anything, when there is no active turn for the session', async () => {
      expect(isTurnActive('sess-1')).toBe(false);
      const decision = await requestApproval('sess-1', {
        callId: 'call_x',
        toolName: 'bash',
        input: { command: 'ls' },
      });
      expect(decision).toEqual({
        behavior: 'deny',
        message: 'No active turn to route this approval request to.',
      });
      // still no active turn was created as a side effect
      expect(isTurnActive('sess-1')).toBe(false);
    });

    it('registers the pending entry before emitting approval.requested — resolving it synchronously from inside the emit listener already finds it', async () => {
      const fake = createControllableSession();
      startTurn({ db, sessionId: 'sess-1', session: fake, text: 'hi' });

      let resolvedFromListener: boolean | undefined;
      subscribeTurn(
        'sess-1',
        (envelope) => {
          if (envelope.event.type === 'approval.requested') {
            // Only possible to return true here if the pending entry was
            // already in the map by the time this listener runs — i.e.
            // registration happened strictly before the emit that invoked it.
            resolvedFromListener = resolveApproval(
              'sess-1',
              envelope.event.callId,
              { behavior: 'allow' },
            );
          }
        },
        () => undefined,
      );

      const decision = await requestApproval('sess-1', {
        callId: 'call_sync',
        toolName: 'bash',
        input: { command: 'ls' },
      });

      expect(resolvedFromListener).toBe(true);
      expect(decision).toEqual({ behavior: 'allow' });

      fake.finish({ items: [], finalResponse: 'ok', usage: {} });
    });

    it('resolveApproval("allow") settles the pending promise and emits approval.resolved with no message field', async () => {
      const fake = createControllableSession();
      startTurn({ db, sessionId: 'sess-1', session: fake, text: 'hi' });

      const received: ChatStreamEvent[] = [];
      subscribeTurn(
        'sess-1',
        (envelope) => received.push(envelope.event),
        () => undefined,
      );

      const pending = requestApproval('sess-1', {
        callId: 'call_1',
        toolName: 'bash',
        input: { command: 'ls' },
      });

      expect(resolveApproval('sess-1', 'call_1', { behavior: 'allow' })).toBe(
        true,
      );
      await expect(pending).resolves.toEqual({ behavior: 'allow' });

      const resolvedEvent = received.find(
        (event) => event.type === 'approval.resolved',
      );
      expect(resolvedEvent).toEqual({
        type: 'approval.resolved',
        callId: 'call_1',
        behavior: 'allow',
      });
      expect(resolvedEvent !== undefined && 'message' in resolvedEvent).toBe(
        false,
      );

      fake.finish({ items: [], finalResponse: 'ok', usage: {} });
    });

    it('resolveApproval("deny", message) carries the message through both the settled decision and approval.resolved; a deny with no message omits the field entirely', async () => {
      const fake = createControllableSession();
      startTurn({ db, sessionId: 'sess-1', session: fake, text: 'hi' });

      const received: ChatStreamEvent[] = [];
      subscribeTurn(
        'sess-1',
        (envelope) => received.push(envelope.event),
        () => undefined,
      );

      const pendingWithMessage = requestApproval('sess-1', {
        callId: 'call_deny_msg',
        toolName: 'bash',
        input: { command: 'git push' },
      });
      resolveApproval('sess-1', 'call_deny_msg', {
        behavior: 'deny',
        message: 'not right now',
      });
      await expect(pendingWithMessage).resolves.toEqual({
        behavior: 'deny',
        message: 'not right now',
      });

      const pendingNoMessage = requestApproval('sess-1', {
        callId: 'call_deny_bare',
        toolName: 'bash',
        input: { command: 'rm -rf x' },
      });
      resolveApproval('sess-1', 'call_deny_bare', { behavior: 'deny' });
      await expect(pendingNoMessage).resolves.toEqual({ behavior: 'deny' });

      const resolvedEvents = received.filter(
        (event) => event.type === 'approval.resolved',
      );
      expect(resolvedEvents).toEqual([
        {
          type: 'approval.resolved',
          callId: 'call_deny_msg',
          behavior: 'deny',
          message: 'not right now',
        },
        {
          type: 'approval.resolved',
          callId: 'call_deny_bare',
          behavior: 'deny',
        },
      ]);

      fake.finish({ items: [], finalResponse: 'ok', usage: {} });
    });

    it('resolving the same callId a second time returns false; unknown callId/unknown session both return false', async () => {
      const fake = createControllableSession();
      startTurn({ db, sessionId: 'sess-1', session: fake, text: 'hi' });

      const pending = requestApproval('sess-1', {
        callId: 'call_1',
        toolName: 'bash',
        input: { command: 'ls' },
      });
      expect(resolveApproval('sess-1', 'call_1', { behavior: 'allow' })).toBe(
        true,
      );
      expect(resolveApproval('sess-1', 'call_1', { behavior: 'allow' })).toBe(
        false,
      );
      expect(
        resolveApproval('sess-1', 'never-requested', { behavior: 'allow' }),
      ).toBe(false);
      expect(
        resolveApproval('sess-does-not-exist', 'call_1', {
          behavior: 'allow',
        }),
      ).toBe(false);

      await pending;
      fake.finish({ items: [], finalResponse: 'ok', usage: {} });
    });

    it('auto-denies via the exact same resolveApproval path once the timeout elapses, with a timeout explanation; resolving it afterward is a no-op', async () => {
      const fake = createControllableSession();
      startTurn({ db, sessionId: 'sess-1', session: fake, text: 'hi' });

      const received: ChatStreamEvent[] = [];
      subscribeTurn(
        'sess-1',
        (envelope) => received.push(envelope.event),
        () => undefined,
      );

      const decision = await requestApproval(
        'sess-1',
        {
          callId: 'call_timeout',
          toolName: 'bash',
          input: { command: 'rm -rf /' },
        },
        { timeoutMs: 10 },
      );

      expect(decision.behavior).toBe('deny');
      if (decision.behavior === 'deny') {
        expect(decision.message).toContain('timed out');
      }

      expect(received.map((event) => event.type)).toEqual([
        'approval.requested',
        'approval.resolved',
      ]);
      const resolvedEvent = received[1];
      expect(resolvedEvent?.type).toBe('approval.resolved');
      if (resolvedEvent?.type === 'approval.resolved') {
        expect(resolvedEvent.behavior).toBe('deny');
        expect(resolvedEvent.message).toContain('timed out');
      }

      // already settled by the timeout — a later manual resolve is a no-op.
      expect(
        resolveApproval('sess-1', 'call_timeout', { behavior: 'allow' }),
      ).toBe(false);

      fake.finish({ items: [], finalResponse: 'ok', usage: {} });
    });
  });

  // ---------------------------------------------------------------------------
  // ask_user bridge (docs/08 §2.2c（审批链）) — structurally the sibling of the
  // approval bridge above; requestUserAnswer/resolveUserAnswer.
  // ---------------------------------------------------------------------------

  describe('requestUserAnswer / resolveUserAnswer', () => {
    it('resolves { outcome: "timeout" } immediately, without registering or emitting anything, when there is no active turn for the session', async () => {
      expect(isTurnActive('sess-1')).toBe(false);
      const outcome = await requestUserAnswer('sess-1', {
        callId: 'call_x',
        question: 'what next?',
      });
      expect(outcome).toEqual({ outcome: 'timeout' });
      expect(isTurnActive('sess-1')).toBe(false);
    });

    it('registers before emitting question.asked (with and without options)', async () => {
      const fake = createControllableSession();
      startTurn({ db, sessionId: 'sess-1', session: fake, text: 'hi' });

      const received: ChatStreamEvent[] = [];
      subscribeTurn(
        'sess-1',
        (envelope) => received.push(envelope.event),
        () => undefined,
      );

      const withOptions = requestUserAnswer('sess-1', {
        callId: 'call_opts',
        question: 'pick a color',
        options: ['red', 'blue'],
      });
      resolveUserAnswer('sess-1', 'call_opts', 'red');
      await withOptions;

      const withoutOptions = requestUserAnswer('sess-1', {
        callId: 'call_no_opts',
        question: 'anything else?',
      });
      resolveUserAnswer('sess-1', 'call_no_opts', 'nope');
      await withoutOptions;

      const askedEvents = received.filter(
        (event) => event.type === 'question.asked',
      );
      expect(askedEvents).toEqual([
        {
          type: 'question.asked',
          callId: 'call_opts',
          question: 'pick a color',
          options: ['red', 'blue'],
        },
        {
          type: 'question.asked',
          callId: 'call_no_opts',
          question: 'anything else?',
        },
      ]);
      expect(askedEvents[1] !== undefined && 'options' in askedEvents[1]).toBe(
        false,
      );

      fake.finish({ items: [], finalResponse: 'ok', usage: {} });
    });

    it('resolveUserAnswer settles the pending promise and emits question.answered (outcome "answered" + the answer); resolving the same callId again returns false', async () => {
      const fake = createControllableSession();
      startTurn({ db, sessionId: 'sess-1', session: fake, text: 'hi' });

      const received: ChatStreamEvent[] = [];
      subscribeTurn(
        'sess-1',
        (envelope) => received.push(envelope.event),
        () => undefined,
      );

      const pending = requestUserAnswer('sess-1', {
        callId: 'call_1',
        question: 'continue?',
      });
      expect(resolveUserAnswer('sess-1', 'call_1', 'yes please')).toBe(true);
      await expect(pending).resolves.toEqual({
        outcome: 'answered',
        answer: 'yes please',
      });
      expect(resolveUserAnswer('sess-1', 'call_1', 'yes again')).toBe(false);

      const answeredEvent = received.find(
        (event) => event.type === 'question.answered',
      );
      expect(answeredEvent).toEqual({
        type: 'question.answered',
        callId: 'call_1',
        outcome: 'answered',
        answer: 'yes please',
      });

      fake.finish({ items: [], finalResponse: 'ok', usage: {} });
    });

    it('auto-times-out via the same settle path when the timeout elapses — outcome "timeout" carries no answer field', async () => {
      const fake = createControllableSession();
      startTurn({ db, sessionId: 'sess-1', session: fake, text: 'hi' });

      const received: ChatStreamEvent[] = [];
      subscribeTurn(
        'sess-1',
        (envelope) => received.push(envelope.event),
        () => undefined,
      );

      const outcome = await requestUserAnswer(
        'sess-1',
        { callId: 'call_timeout', question: 'still there?' },
        { timeoutMs: 10 },
      );
      expect(outcome).toEqual({ outcome: 'timeout' });

      const answeredEvent = received.find(
        (event) => event.type === 'question.answered',
      );
      expect(answeredEvent).toEqual({
        type: 'question.answered',
        callId: 'call_timeout',
        outcome: 'timeout',
      });
      expect(answeredEvent !== undefined && 'answer' in answeredEvent).toBe(
        false,
      );

      expect(resolveUserAnswer('sess-1', 'call_timeout', 'too late')).toBe(
        false,
      );

      fake.finish({ items: [], finalResponse: 'ok', usage: {} });
    });
  });

  // ---------------------------------------------------------------------------
  // Cross-bridge behavior: independent maps, shared seq counter, and the
  // turn-teardown sweep.
  // ---------------------------------------------------------------------------

  describe('approval/question bridges together', () => {
    it('pendingApprovals and pendingQuestions are independent maps — the same callId in both resolves independently without cross-talk', async () => {
      const fake = createControllableSession();
      startTurn({ db, sessionId: 'sess-1', session: fake, text: 'hi' });

      const approvalPromise = requestApproval('sess-1', {
        callId: 'shared-id',
        toolName: 'bash',
        input: { command: 'ls' },
      });
      const questionPromise = requestUserAnswer('sess-1', {
        callId: 'shared-id',
        question: 'pick one',
      });

      // Resolve only the question — the approval (same callId, other map)
      // must remain pending.
      expect(resolveUserAnswer('sess-1', 'shared-id', 'blue')).toBe(true);
      await expect(questionPromise).resolves.toEqual({
        outcome: 'answered',
        answer: 'blue',
      });

      // The approval's own pending entry was untouched by the question's resolve.
      expect(
        resolveApproval('sess-1', 'shared-id', { behavior: 'allow' }),
      ).toBe(true);
      await expect(approvalPromise).resolves.toEqual({ behavior: 'allow' });

      fake.finish({ items: [], finalResponse: 'ok', usage: {} });
    });

    it('seq stays monotonic across user.message, an approval round-trip, a question round-trip, and the terminal sentinel — persisted rows match emitted envelopes exactly', async () => {
      const fake = createControllableSession();
      startTurn({ db, sessionId: 'sess-1', session: fake, text: 'hi' }); // seq 1: user.message (emitted before any subscriber attaches)

      const received: ChatEventEnvelope[] = [];
      subscribeTurn(
        'sess-1',
        (envelope) => received.push(envelope),
        () => undefined,
      );

      const approvalPromise = requestApproval('sess-1', {
        callId: 'call_1',
        toolName: 'bash',
        input: { command: 'ls' },
      }); // seq 2: approval.requested
      resolveApproval('sess-1', 'call_1', { behavior: 'allow' }); // seq 3: approval.resolved
      await approvalPromise;

      const questionPromise = requestUserAnswer('sess-1', {
        callId: 'call_2',
        question: 'ok?',
      }); // seq 4: question.asked
      resolveUserAnswer('sess-1', 'call_2', 'yes'); // seq 5: question.answered
      await questionPromise;

      fake.finish({ items: [], finalResponse: 'done', usage: {} }); // seq 6: turn.result
      await flushMicrotasks();

      expect(received.map((envelope) => envelope.seq)).toEqual([2, 3, 4, 5, 6]);
      expect(received.map((envelope) => envelope.event.type)).toEqual([
        'approval.requested',
        'approval.resolved',
        'question.asked',
        'question.answered',
        'turn.result',
      ]);

      const persisted = listAgentEvents(db, 'sess-1');
      expect(persisted.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(persisted.map((row) => row.type)).toEqual([
        'user.message',
        'approval.requested',
        'approval.resolved',
        'question.asked',
        'question.answered',
        'turn.result',
      ]);
    });

    it('turn teardown sweeps leftover pending approvals/questions (deny/timeout) once the turn ends without them ever being resolved — and emits nothing for that sweep', async () => {
      const fake = createControllableSession();
      startTurn({ db, sessionId: 'sess-1', session: fake, text: 'hi' });

      const received: ChatEventEnvelope[] = [];
      subscribeTurn(
        'sess-1',
        (envelope) => received.push(envelope),
        () => undefined,
      );

      // Registered directly (not via the fake session's own generator) with a
      // timeout far longer than this test's lifetime — the only way they can
      // ever settle is via the turn-teardown sweep below.
      const approvalPromise = requestApproval(
        'sess-1',
        { callId: 'call_1', toolName: 'bash', input: { command: 'ls' } },
        { timeoutMs: 999_999 },
      );
      const questionPromise = requestUserAnswer(
        'sess-1',
        { callId: 'call_2', question: 'ok?' },
        { timeoutMs: 999_999 },
      );
      await flushMicrotasks();
      const beforeSweep = received.length; // requested/asked already landed

      // The controllable session's own generator ends right now — with
      // neither pending request ever resolved through the normal path.
      fake.finish({ items: [], finalResponse: 'done', usage: {} });
      await flushMicrotasks();

      const [approvalDecision, questionOutcome] = await Promise.all([
        approvalPromise,
        questionPromise,
      ]);
      expect(approvalDecision.behavior).toBe('deny');
      expect(questionOutcome).toEqual({ outcome: 'timeout' });

      // Nothing but the terminal sentinel follows the requested/asked pair —
      // the teardown sweep itself is silent (no approval.resolved/question.answered).
      expect(
        received.slice(beforeSweep).map((envelope) => envelope.event.type),
      ).toEqual(['turn.result']);

      // Resolving by hand after the sweep is a no-op — the pending entries
      // (and the whole turn) are already gone.
      expect(resolveApproval('sess-1', 'call_1', { behavior: 'allow' })).toBe(
        false,
      );
      expect(resolveUserAnswer('sess-1', 'call_2', 'too late')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Durable/ephemeral split (docs/08 §2.2d, P13-1) — `createEmitWire`'s
  // `item.updated` branch: broadcast-only, never persisted, never consumes a
  // seq number.
  // ---------------------------------------------------------------------------

  describe('durable/ephemeral split (docs/08 §2.2d) — createEmitWire', () => {
    it('an item.updated envelope carries no `seq` key at all (not merely `undefined`), and no item.updated row is ever appended to agent_events', async () => {
      const fake = createControllableSession();
      startTurn({ db, sessionId: 'sess-1', session: fake, text: 'hi' });

      const received: ChatEventEnvelope[] = [];
      subscribeTurn(
        'sess-1',
        (envelope) => received.push(envelope),
        () => undefined,
      );

      fake.pushEvent({
        type: 'item.updated',
        item: { id: 'm1', type: 'agent_message', text: 'partial text' },
      });
      await flushMicrotasks();

      const updatedEnvelope = received.find(
        (envelope) => envelope.event.type === 'item.updated',
      );
      expect(updatedEnvelope).toBeDefined();
      // The load-bearing assertion (docs/08 §2.2d): the key is *absent*, this
      // is not the same thing as `envelope.seq === undefined` on a key that's
      // present-but-unset — `'in'` is what actually distinguishes the two.
      expect(updatedEnvelope !== undefined && 'seq' in updatedEnvelope).toBe(
        false,
      );

      fake.finish({ items: [], finalResponse: 'done', usage: {} });
      await flushMicrotasks();

      const persisted = listAgentEvents(db, 'sess-1');
      expect(persisted.some((row) => row.type === 'item.updated')).toBe(false);
      expect(persisted.map((row) => row.type)).toEqual([
        'user.message',
        'turn.result',
      ]);
    });

    it('seq stays gap-free across item.updated ticks: started → several ephemeral updated ticks → completed → turn.result — persisted seq climbs by exactly 1 each time, the ticks consuming none of it', async () => {
      const fake = createControllableSession();
      startTurn({ db, sessionId: 'sess-1', session: fake, text: 'hi' }); // seq 1: user.message

      const received: ChatEventEnvelope[] = [];
      subscribeTurn(
        'sess-1',
        (envelope) => received.push(envelope),
        () => undefined,
      );

      fake.pushEvent({
        type: 'item.started',
        item: { id: 'm1', type: 'agent_message', text: '' },
      }); // seq 2
      await flushMicrotasks();
      fake.pushEvent({
        type: 'item.updated',
        item: { id: 'm1', type: 'agent_message', text: 'p' },
      }); // ephemeral
      await flushMicrotasks();
      fake.pushEvent({
        type: 'item.updated',
        item: { id: 'm1', type: 'agent_message', text: 'pa' },
      }); // ephemeral
      await flushMicrotasks();
      fake.pushEvent({
        type: 'item.updated',
        item: { id: 'm1', type: 'agent_message', text: 'par' },
      }); // ephemeral
      await flushMicrotasks();
      fake.pushEvent({
        type: 'item.completed',
        item: { id: 'm1', type: 'agent_message', text: 'part' },
      }); // seq 3
      await flushMicrotasks();
      fake.finish({ items: [], finalResponse: 'part', usage: {} }); // seq 4
      await flushMicrotasks();

      const persisted = listAgentEvents(db, 'sess-1');
      expect(persisted.map((row) => row.seq)).toEqual([1, 2, 3, 4]);
      expect(persisted.map((row) => row.type)).toEqual([
        'user.message',
        'item.started',
        'item.completed',
        'turn.result',
      ]);
      // strictly consecutive — no holes left by the three skipped ticks.
      for (let i = 1; i < persisted.length; i += 1) {
        expect(persisted[i]?.seq).toBe((persisted[i - 1]?.seq ?? 0) + 1);
      }

      const updatedEnvelopes = received.filter(
        (envelope) => envelope.event.type === 'item.updated',
      );
      expect(updatedEnvelopes).toHaveLength(3);
      expect(updatedEnvelopes.every((envelope) => !('seq' in envelope))).toBe(
        true,
      );
    });

    it('cross-turn seq continuation: a turn whose tail is an ephemeral item.updated tick still hands the next turn a seq that continues from the prior turn’s last *persisted* event, not the ephemeral tick', async () => {
      const first = createControllableSession();
      startTurn({ db, sessionId: 'sess-1', session: first, text: 'a' }); // seq 1: user.message
      first.pushEvent({
        type: 'item.started',
        item: { id: 'm1', type: 'agent_message', text: '' },
      }); // seq 2
      await flushMicrotasks();
      first.pushEvent({
        type: 'item.updated',
        item: { id: 'm1', type: 'agent_message', text: 'partial' },
      }); // ephemeral — the very last thing emitted before this turn ends
      await flushMicrotasks();
      first.finish({ items: [], finalResponse: 'first', usage: {} }); // seq 3
      await flushMicrotasks();

      const persistedAfterFirst = listAgentEvents(db, 'sess-1');
      expect(persistedAfterFirst.map((row) => row.seq)).toEqual([1, 2, 3]);

      const second = createControllableSession();
      startTurn({ db, sessionId: 'sess-1', session: second, text: 'b' }); // must be seq 4, not seq 5
      second.finish({ items: [], finalResponse: 'second', usage: {} }); // seq 5
      await flushMicrotasks();

      const persisted = listAgentEvents(db, 'sess-1');
      expect(persisted.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(persisted.map((row) => row.type)).toEqual([
        'user.message',
        'item.started',
        'turn.result',
        'user.message',
        'turn.result',
      ]);
    });

    it('approval/question bridge events stay persisted + seq’d even with ephemeral item.updated ticks interleaved between them', async () => {
      const fake = createControllableSession();
      startTurn({ db, sessionId: 'sess-1', session: fake, text: 'hi' }); // seq 1

      const received: ChatEventEnvelope[] = [];
      subscribeTurn(
        'sess-1',
        (envelope) => received.push(envelope),
        () => undefined,
      );

      const approvalPromise = requestApproval('sess-1', {
        callId: 'c1',
        toolName: 'bash',
        input: {},
      }); // seq 2: approval.requested
      fake.pushEvent({
        type: 'item.updated',
        item: { id: 'm1', type: 'agent_message', text: 'thinking' },
      }); // ephemeral
      await flushMicrotasks();
      resolveApproval('sess-1', 'c1', { behavior: 'allow' }); // seq 3: approval.resolved
      await approvalPromise;

      const questionPromise = requestUserAnswer('sess-1', {
        callId: 'c2',
        question: 'ok?',
      }); // seq 4: question.asked
      fake.pushEvent({
        type: 'item.updated',
        item: { id: 'm1', type: 'agent_message', text: 'thinking more' },
      }); // ephemeral
      await flushMicrotasks();
      resolveUserAnswer('sess-1', 'c2', 'yes'); // seq 5: question.answered
      await questionPromise;

      fake.finish({ items: [], finalResponse: 'done', usage: {} }); // seq 6
      await flushMicrotasks();

      const persisted = listAgentEvents(db, 'sess-1');
      expect(persisted.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(persisted.map((row) => row.type)).toEqual([
        'user.message',
        'approval.requested',
        'approval.resolved',
        'question.asked',
        'question.answered',
        'turn.result',
      ]);

      const updatedEnvelopes = received.filter(
        (envelope) => envelope.event.type === 'item.updated',
      );
      expect(updatedEnvelopes).toHaveLength(2);
      expect(updatedEnvelopes.every((envelope) => !('seq' in envelope))).toBe(
        true,
      );
    });
  });
});
