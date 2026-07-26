import { randomUUID } from 'node:crypto';

import type {
  HumanDecision,
  NimboChunk,
  NimboUIMessage,
  SessionState,
} from '@nimbo/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConversationEventRow, Db } from '../../src/agent/store.js';
import {
  appendConversationEvent,
  createConversation,
  getConversation,
  getMaxEventSeq,
  listConversationEvents,
} from '../../src/agent/store.js';
import type { TurnDrivenSession } from '../../src/agent/turn-runner.js';
import {
  abortTurn,
  isTurnActive,
  requestReview,
  requestUserAnswer,
  resolveReview,
  resolveUserAnswer,
  startTurn,
  steerTurn,
  subscribeTurn,
} from '../../src/agent/turn-runner.js';
import { createLogger } from '../../src/logger.js';
import type {
  ChatReplayFrame,
  ChunkEnvelope,
  MessageFrame,
} from '../../src/schemas/chat.js';
import { messageFrameSchema } from '../../src/schemas/chat.js';
import {
  createControllableSession,
  createSteerableControllableSession,
} from '../helpers/controllable-session.js';
import {
  assistantTextMessage,
  collectText,
  dataErrorChunk,
  dataFileChangeChunk,
  dataPlanUpdateChunk,
  dataToolProgressChunk,
  dataToolTimingChunk,
  finishChunk,
  finishStepChunk,
  messageMetadataChunk,
  reasoningDeltaChunk,
  reasoningEndChunk,
  reasoningStartChunk,
  startChunk,
  startStepChunk,
  textDeltaChunk,
  textEndChunk,
  textStartChunk,
  toolApprovalRequestChunk,
  toolApprovalResponseChunk,
  toolInputAvailableChunk,
  toolInputStartChunk,
  toolOutputAvailableChunk,
  toolOutputDeniedChunk,
  toolOutputErrorChunk,
  userTextMessage,
} from '../helpers/nimbo-chunks.js';
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

/** Narrows a `ChatReplayFrame` list down to its `MessageFrame`s — same structural discrimination `routes/chat.ts`'s own `frameEventName` uses (`'message' in frame`). */
function messageFrames(frames: ChatReplayFrame[]): MessageFrame[] {
  return frames.filter((frame): frame is MessageFrame => 'message' in frame);
}

/** Narrows a `ChatReplayFrame` list down to its `ChunkEnvelope`s. */
function chunkEnvelopes(frames: ChatReplayFrame[]): ChunkEnvelope[] {
  return frames.filter((frame): frame is ChunkEnvelope => 'chunk' in frame);
}

/**
 * Parses a persisted `conversation_events` row's `payloadJson` back into its typed
 * `NimboUIMessage` (only meaningful for a `kind = 'message'` row) — reuses
 * `messageFrameSchema`'s own `z.ZodType<NimboUIMessage>` typing
 * (`schemas/chat.ts`) instead of a bare `JSON.parse`, which would otherwise
 * leak an implicit `any` into the caller. `undefined` in, `undefined` out —
 * lets callers chain straight off a possibly-out-of-bounds array index
 * (`row[i]`, `noUncheckedIndexedAccess`) without a non-null assertion.
 */
function parseMessageRow(
  row: ConversationEventRow | undefined,
): NimboUIMessage | undefined {
  if (row === undefined) return undefined;
  return messageFrameSchema.parse({
    seq: row.seq,
    message: JSON.parse(row.payloadJson) as unknown,
  }).message;
}

describe('agent/turn-runner', () => {
  let db: Db;
  let conversationId: string;

  // Every test below gets its own fresh, never-before-used chat session id
  // (rather than a shared literal like 'sess-1') — `activeTurns`
  // (turn-runner.ts) is a module-level `Map` that outlives any single test,
  // so if one test's assertions throw before it ever reaches
  // `fake.finish()`/`fake.fail()`, that turn is left dangling, active
  // forever, under whatever conversationId it used. A unique id per test means a
  // leftover dangling turn from a failed test can never collide with (and
  // silently poison) a later, unrelated test's `startTurn` call.
  beforeEach(() => {
    db = createTestDb();
    seedUser(db, 'user-1');
    conversationId = randomUUID();
    createConversation(db, {
      id: conversationId,
      userId: 'user-1',
      title: 'Session',
      repo: 'acme/demo',
      branchName: `nimbo/chat-${conversationId}`,
      sandboxName: `nimbo-chat-${conversationId}`,
    });
  });

  it('drives a turn end to end: the turn-start user message is persisted+broadcast synchronously before startTurn returns (this ticket’s fix — docs/tech/single-ledger.md §5 引言), so a late subscriber only ever sees the subsequent durable chunks; finalize then appends just the assistant message (skipping over core’s own already-persisted copy of the user message), and isTurnActive/"done" flip once drained', async () => {
    const fake = createControllableSession();

    const result = startTurn({
      db,
      conversationId,
      session: fake,
      text: '你好',
      priorMessageCount: 0,
    });
    expect(result).toEqual({ started: true });
    expect(isTurnActive(conversationId)).toBe(true);

    // The turn-start user message is already persisted — driveTurn's very
    // first synchronous act (before it ever starts consuming
    // session.stream()) is emit.emitMessage(...), which runs to completion
    // before startTurn itself returns.
    const afterStart = listConversationEvents(db, conversationId);
    expect(afterStart).toHaveLength(1);
    expect(afterStart[0]?.kind).toBe('message');
    expect(afterStart[0]?.seq).toBe(1);
    const startMessage = parseMessageRow(afterStart[0]);
    expect(startMessage?.role).toBe('user');
    expect(collectText(startMessage)).toBe('你好');

    // Subscribing only now — after the turn-start message has already been
    // broadcast — is a late subscriber that missed it; only the subsequent
    // chunks reach `received`.
    const received: ChatReplayFrame[] = [];
    let doneCalls = 0;
    const unsubscribe = subscribeTurn(
      conversationId,
      (envelope) => received.push(envelope),
      () => {
        doneCalls += 1;
      },
    );

    fake.pushChunk(startChunk('m1'));
    await flushMicrotasks();
    fake.pushChunk(startStepChunk());
    await flushMicrotasks();
    fake.setState({
      id: 'nimbo-sess-1',
      turn: 1,
      createdAt: 1000,
      messages: [
        userTextMessage('u1', '你好'),
        assistantTextMessage('m1', 'hi there', {
          turn: 1,
          usage: {},
          status: 'completed',
        }),
      ],
    });
    fake.finish({ finalResponse: 'hi there', usage: {} });
    await flushMicrotasks();

    expect(isTurnActive(conversationId)).toBe(false);
    expect(doneCalls).toBe(1);
    expect(messageFrames(received)).toEqual([]); // the turn-start message was missed — it fired before this listener subscribed
    expect(chunkEnvelopes(received).map((e) => e.chunk.type)).toEqual([
      'start',
      'start-step',
    ]);
    expect(chunkEnvelopes(received).map((e) => e.seq)).toEqual([2, 3]); // seq 1 was already spent on the turn-start message

    // finalizeTurnPersistence appends only the ASSISTANT message (the user
    // message it would otherwise re-derive from state.messages[0] is
    // skipped — it was already persisted above, under its own synthesized
    // id), then GCs every chunk row this turn produced (docs/tech/single-ledger.md §5 单-3) —
    // only message rows survive past a gracefully-finished turn.
    const persisted = listConversationEvents(db, conversationId);
    expect(persisted.map((r) => r.seq)).toEqual([1, 4]);
    expect(persisted.map((r) => r.kind)).toEqual(['message', 'message']);
    expect(parseMessageRow(persisted[1])).toEqual(
      assistantTextMessage('m1', 'hi there', {
        turn: 1,
        usage: {},
        status: 'completed',
      }),
    );

    const row = getConversation(db, conversationId, 'user-1');
    expect(row?.agentSessionId).toBe('nimbo-sess-1');
    expect(row?.agentSessionTurn).toBe(1);
    expect(row?.agentSessionCreatedAt?.getTime()).toBe(1000);

    unsubscribe();
  });

  // [skill 提及](../../../../docs/terms.md)的核心不变量
  // （docs/tech/composer-skill-mention.md §2.2）：界面/账本拿用户原话，模型拿加料版。
  it('modelText and text are separate: the ledger + wire carry the user’s own words while the model receives the augmented text', async () => {
    const fake = createControllableSession();
    const displayText = '/frontend-design 帮我看看首页排版';
    const modelText = `${displayText}\n\n[系统提示] 用户在本条消息中显式指定了 skill：frontend-design。`;

    startTurn({
      db,
      conversationId,
      session: fake,
      text: displayText,
      modelText,
      priorMessageCount: 0,
    });

    // 账本里那条 turn-start 用户消息 = 用户原话，**不含**系统提示行。
    const rows = listConversationEvents(db, conversationId);
    expect(collectText(parseMessageRow(rows[0]))).toBe(displayText);

    // 而 core 的 `session.stream()` 收到的是加料版。
    await flushMicrotasks();
    expect(fake.streamInputs).toEqual([modelText]);

    fake.finish({ finalResponse: 'ok', usage: {} });
    await flushMicrotasks();
  });

  it('modelText defaults to text — a turn with no skill mention feeds the model the exact same string it persists', async () => {
    const fake = createControllableSession();

    startTurn({
      db,
      conversationId,
      session: fake,
      text: '帮我看看首页排版',
      priorMessageCount: 0,
    });

    await flushMicrotasks();
    expect(fake.streamInputs).toEqual(['帮我看看首页排版']);
    expect(
      collectText(
        parseMessageRow(listConversationEvents(db, conversationId)[0]),
      ),
    ).toBe('帮我看看首页排版');

    fake.finish({ finalResponse: 'ok', usage: {} });
    await flushMicrotasks();
  });

  it('rejects a second startTurn while one is already active for the same session', () => {
    const fake = createControllableSession();
    const first = startTurn({
      db,
      conversationId,
      session: fake,
      text: 'a',
      priorMessageCount: 0,
    });
    expect(first).toEqual({ started: true });

    const second = startTurn({
      db,
      conversationId,
      session: fake,
      text: 'b',
      priorMessageCount: 0,
    });
    expect(second).toEqual({ started: false });

    fake.finish({ finalResponse: 'ok', usage: {} });
  });

  it('allows starting a new turn once the previous one has finished, with seq continuing to climb (past the prior turn’s now-GC’d chunk rows) across turns', async () => {
    const first = createControllableSession();
    startTurn({
      db,
      conversationId,
      session: first,
      text: 'a',
      priorMessageCount: 0,
    });
    first.pushChunk(startChunk('m1'));
    await flushMicrotasks();
    first.setState({
      id: 'nimbo-sess-1',
      turn: 1,
      createdAt: 1000,
      messages: [
        userTextMessage('u1', 'a'),
        assistantTextMessage('m1', 'first'),
      ],
    });
    first.finish({ finalResponse: 'first', usage: {} });
    await flushMicrotasks();
    expect(isTurnActive(conversationId)).toBe(false);
    // seq 1: the turn-start user message; seq 2 (the start chunk) got GC'd; seq 3: the assistant message.
    expect(
      listConversationEvents(db, conversationId).map((r) => r.seq),
    ).toEqual([1, 3]);

    const second = createControllableSession();
    const result = startTurn({
      db,
      conversationId,
      session: second,
      text: 'b',
      priorMessageCount: 2,
    });
    expect(result).toEqual({ started: true });
    expect(isTurnActive(conversationId)).toBe(true);
    second.setState({
      id: 'nimbo-sess-1',
      turn: 2,
      createdAt: 1000,
      messages: [
        userTextMessage('u1', 'a'),
        assistantTextMessage('m1', 'first'),
        userTextMessage('u2', 'b'),
        assistantTextMessage('m2', 'second'),
      ],
    });
    second.finish({ finalResponse: 'second', usage: {} });
    await flushMicrotasks();

    // Continues from seq 3 (the prior turn's last persisted row), not from 0.
    const persisted = listConversationEvents(db, conversationId);
    expect(persisted.map((r) => r.seq)).toEqual([1, 3, 4, 5]);
    expect(persisted.every((r) => r.kind === 'message')).toBe(true);
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
    startTurn({
      db,
      conversationId,
      session: fake,
      text: 'hi',
      priorMessageCount: 0,
    });

    const a: ChatReplayFrame[] = [];
    const b: ChatReplayFrame[] = [];
    const unsubscribeA = subscribeTurn(
      conversationId,
      (envelope) => a.push(envelope),
      () => undefined,
    );
    subscribeTurn(
      conversationId,
      (envelope) => b.push(envelope),
      () => undefined,
    );

    fake.pushChunk(startChunk('m1'));
    await flushMicrotasks();
    unsubscribeA();
    fake.pushChunk(startStepChunk());
    await flushMicrotasks();
    fake.finish({ finalResponse: 'done', usage: {} });
    await flushMicrotasks();

    expect(chunkEnvelopes(a).map((e) => e.chunk.type)).toEqual(['start']); // unsubscribed before start-step
    expect(chunkEnvelopes(b).map((e) => e.chunk.type)).toEqual([
      'start',
      'start-step',
    ]);
  });

  // ---------------------------------------------------------------------------
  // Turn-start user MessageFrame (this ticket's fix — docs/tech/single-ledger.md §5 引言's
  // "用户消息乱序/叠在一起" bug): driveTurn synthesizes+emits it exactly once,
  // strictly before it ever starts consuming session.stream(), sharing the
  // turn's own seq counter — see turn-runner.ts's file header/createTurnEmitter.
  // ---------------------------------------------------------------------------

  describe('turn-start user MessageFrame', () => {
    it('is persisted at seq = turnStartSeq + 1, strictly before any chunk this turn produces — role "user", text verbatim; no subscriber can ever observe its broadcast live (activeTurns only registers this turn, and driveTurn broadcasts it, in the very same synchronous tick startTurn itself runs in — there is no yield point in between for an external subscribeTurn call to land on, so only a direct ledger query, or a later replay, ever sees it; a subscriber attached right after startTurn returns only ever catches this turn’s subsequent chunks)', async () => {
      // Seed some unrelated prior history so turnStartSeq isn't trivially 0 —
      // proves the "+1" is relative to wherever the ledger already was, not
      // hardcoded to a fresh session's first turn.
      appendConversationEvent(db, {
        conversationId,
        seq: 1,
        kind: 'message',
        payloadJson: JSON.stringify(userTextMessage('prior', 'previous turn')),
      });
      const turnStartSeq = getMaxEventSeq(db, conversationId);
      expect(turnStartSeq).toBe(1);

      const fake = createControllableSession();
      const result = startTurn({
        db,
        conversationId,
        session: fake,
        text: 'second turn’s message',
        priorMessageCount: 1,
      });
      expect(result).toEqual({ started: true });

      // Already persisted, synchronously, before startTurn even returned —
      // subscribeTurn itself is a no-op until activeTurns already has this
      // turn registered (see the "no active turn" test above), which only
      // happens moments before driveTurn's synchronous emitMessage call, with
      // no gap for any external subscriber to attach into.
      const afterStart = listConversationEvents(db, conversationId);
      expect(afterStart).toHaveLength(2); // the seeded row, plus this turn's turn-start message
      const startRow = afterStart[1];
      expect(startRow?.kind).toBe('message');
      expect(startRow?.seq).toBe(turnStartSeq + 1);
      const startMessage = parseMessageRow(startRow);
      expect(startMessage?.role).toBe('user');
      expect(collectText(startMessage)).toBe('second turn’s message');

      // A subscriber attached only now (after startTurn returned) never sees
      // the turn-start message live — only this turn's subsequent chunks,
      // strictly after its seq.
      const liveFrames: ChatReplayFrame[] = [];
      subscribeTurn(
        conversationId,
        (envelope) => liveFrames.push(envelope),
        () => undefined,
      );
      fake.pushChunk(startChunk('m1'));
      await flushMicrotasks();

      expect(messageFrames(liveFrames)).toEqual([]); // never delivered live to any subscriber
      expect(chunkEnvelopes(liveFrames)).toHaveLength(1);
      expect(chunkEnvelopes(liveFrames)[0]?.seq).toBe(turnStartSeq + 2); // strictly after the message's own seq
      expect(chunkEnvelopes(liveFrames)[0]?.chunk.type).toBe('start');

      fake.finish({ finalResponse: 'ok', usage: {} });
      await flushMicrotasks();
    });

    it('this turn’s ledger slice has exactly one user message row (never core’s own duplicate copy), with the assistant’s message immediately following it', async () => {
      const fake = createControllableSession();
      startTurn({
        db,
        conversationId,
        session: fake,
        text: 'only once, right?',
        priorMessageCount: 0,
      });
      fake.setState({
        id: 'nimbo-sess-1',
        turn: 1,
        createdAt: 1000,
        messages: [
          // core's own internal copy — finalizeTurnPersistence must skip
          // this, not persist it a second time under a second id.
          userTextMessage('core-own-copy', 'only once, right?'),
          assistantTextMessage('m1', 'yep, once'),
        ],
      });
      fake.finish({ finalResponse: 'yep, once', usage: {} });
      await flushMicrotasks();

      const persisted = listConversationEvents(db, conversationId);
      expect(persisted).toHaveLength(2);
      const userRows = persisted.filter(
        (row) => parseMessageRow(row)?.role === 'user',
      );
      expect(userRows).toHaveLength(1);
      expect(parseMessageRow(persisted[1])?.role).toBe('assistant');
      expect(collectText(parseMessageRow(persisted[1]))).toBe('yep, once');
    });
  });

  // ---------------------------------------------------------------------------
  // isDurableChunk classification boundary (docs/tech/single-ledger.md §5 单-3, private to
  // turn-runner.ts — asserted here purely via its observable effect: does the
  // broadcast envelope carry a `seq`, and is a row persisted for it. Blanket
  // rule: text-delta/reasoning-delta/`transient: true` are ephemeral,
  // everything else is durable.
  // ---------------------------------------------------------------------------

  describe('isDurableChunk classification (observable via seq presence + persistence)', () => {
    const ephemeralCases: { name: string; chunk: NimboChunk }[] = [
      { name: 'text-delta', chunk: textDeltaChunk('t1', 'hi') },
      { name: 'reasoning-delta', chunk: reasoningDeltaChunk('r1', 'hmm') },
      {
        name: 'data-tool-progress (transient: true — the shape @nimbo/core actually emits)',
        chunk: dataToolProgressChunk('call_1', 'partial', true),
      },
    ];

    const durableCases: { name: string; chunk: NimboChunk }[] = [
      { name: 'text-start', chunk: textStartChunk('t1') },
      { name: 'text-end', chunk: textEndChunk('t1') },
      { name: 'reasoning-start', chunk: reasoningStartChunk('r1') },
      { name: 'reasoning-end', chunk: reasoningEndChunk('r1') },
      {
        name: 'tool-input-start',
        chunk: toolInputStartChunk('call_1', 'bash'),
      },
      {
        name: 'tool-input-available',
        chunk: toolInputAvailableChunk('call_1', 'bash', { command: 'ls' }),
      },
      {
        name: 'tool-approval-request',
        chunk: toolApprovalRequestChunk('call_1'),
      },
      {
        name: 'tool-approval-response',
        chunk: toolApprovalResponseChunk('call_1', true),
      },
      {
        name: 'tool-output-available',
        chunk: toolOutputAvailableChunk('call_1', 'ok'),
      },
      {
        name: 'tool-output-error',
        chunk: toolOutputErrorChunk('call_1', 'boom'),
      },
      { name: 'tool-output-denied', chunk: toolOutputDeniedChunk('call_1') },
      {
        name: 'data-file-change',
        chunk: dataFileChangeChunk('fc1', {
          changes: [{ path: '/a.txt', kind: 'add' }],
        }),
      },
      {
        name: 'data-plan-update',
        chunk: dataPlanUpdateChunk({
          items: [{ text: 'do x', completed: false }],
        }),
      },
      { name: 'data-error', chunk: dataErrorChunk({ message: 'oops' }) },
      { name: 'start-step', chunk: startStepChunk() },
      { name: 'finish-step', chunk: finishStepChunk() },
      { name: 'start', chunk: startChunk('m1') },
      { name: 'finish', chunk: finishChunk() },
      {
        name: 'message-metadata',
        chunk: messageMetadataChunk({ status: 'completed', usage: {} }),
      },
      {
        name: 'data-tool-progress (transient omitted — blanket-rule edge case: classification keys off the literal `transient` field, not the chunk’s type)',
        chunk: dataToolProgressChunk('call_1', 'partial', false),
      },
    ];

    it.each(ephemeralCases)(
      '$name is ephemeral: no seq on the envelope, no row persisted',
      async ({ chunk }) => {
        const fake = createControllableSession();
        startTurn({
          db,
          conversationId,
          session: fake,
          text: 'hi',
          priorMessageCount: 0,
        });
        const received: ChatReplayFrame[] = [];
        subscribeTurn(
          conversationId,
          (envelope) => received.push(envelope),
          () => undefined,
        );

        fake.pushChunk(chunk);
        await flushMicrotasks();

        expect(received).toHaveLength(1);
        expect('seq' in (received[0] ?? {})).toBe(false);
        // Only the turn-start user message (seq 1) — the ephemeral chunk
        // itself persisted nothing.
        expect(
          listConversationEvents(db, conversationId).map((r) => r.kind),
        ).toEqual(['message']);

        fake.finish({ finalResponse: '', usage: {} });
        await flushMicrotasks();
      },
    );

    it.each(durableCases)(
      '$name is durable: envelope carries an integer seq, and a chunk-kind row is persisted with the same type',
      async ({ chunk }) => {
        const fake = createControllableSession();
        startTurn({
          db,
          conversationId,
          session: fake,
          text: 'hi',
          priorMessageCount: 0,
        });
        const received: ChatReplayFrame[] = [];
        subscribeTurn(
          conversationId,
          (envelope) => received.push(envelope),
          () => undefined,
        );

        fake.pushChunk(chunk);
        await flushMicrotasks();

        expect(received).toHaveLength(1);
        // `ChatReplayFrame` 现在是三支联合（多了无 seq 的 `QueueFrame`，
        // docs/tech/steer-and-queue.md §4.3）——先按结构收窄到 chunk 帧再读 seq。
        const firstFrame = received[0];
        expect(
          firstFrame !== undefined && 'chunk' in firstFrame ?
            firstFrame.seq
          : undefined,
        ).toBe(2); // seq 1 was already spent on the turn-start message
        const persisted = listConversationEvents(db, conversationId);
        expect(persisted.map((r) => r.kind)).toEqual(['message', 'chunk']);
        // 旧 type 列已删（payload 判别字段的冗余镜像）——从 payload 里读回验证。
        expect(
          (JSON.parse(persisted[1]?.payloadJson ?? '{}') as { type?: string })
            .type,
        ).toBe(chunk.type);
        expect(persisted[1]?.seq).toBe(2);

        fake.finish({ finalResponse: '', usage: {} });
        await flushMicrotasks();
      },
    );

    it('several ephemeral ticks between two durable chunks never consume a seq — durable seq stays gap-free while the turn is still in progress', async () => {
      const fake = createControllableSession();
      startTurn({
        db,
        conversationId,
        session: fake,
        text: 'hi',
        priorMessageCount: 0,
      });

      fake.pushChunk(textStartChunk('t1')); // durable seq 2 (seq 1 is the turn-start message)
      await flushMicrotasks();
      fake.pushChunk(textDeltaChunk('t1', 'p')); // ephemeral
      await flushMicrotasks();
      fake.pushChunk(textDeltaChunk('t1', 'ar')); // ephemeral
      await flushMicrotasks();
      fake.pushChunk(textDeltaChunk('t1', 't')); // ephemeral
      await flushMicrotasks();
      fake.pushChunk(textEndChunk('t1')); // durable seq 3

      await flushMicrotasks();
      const midTurn = listConversationEvents(db, conversationId);
      const chunkRows = midTurn.filter((r) => r.kind === 'chunk');
      expect(chunkRows.map((r) => r.seq)).toEqual([2, 3]);
      expect(
        chunkRows.map(
          (r) => (JSON.parse(r.payloadJson) as { type?: string }).type,
        ),
      ).toEqual(['text-start', 'text-end']);

      fake.finish({ finalResponse: 'part', usage: {} });
      await flushMicrotasks();
    });
  });

  // ---------------------------------------------------------------------------
  // finalizeTurnPersistence + GC (docs/tech/single-ledger.md §5 单-3): success and graceful
  // failure (status failed/interrupted, session.stream() returning rather
  // than throwing) both append message rows and GC this turn's chunk rows;
  // an unexpected thrown exception (driveTurn's catch branch) does neither —
  // it only ever emits one synthetic failed message-metadata chunk (but the
  // turn-start user message it already persisted synchronously survives —
  // finalizeTurnPersistence never runs to skip/GC it either way).
  // ---------------------------------------------------------------------------

  describe('finalizeTurnPersistence + GC', () => {
    it('success: appends exactly the messages past priorMessageCount as message rows, then GCs every chunk row this turn produced, and updates the conversations nimbo header', async () => {
      const fake = createControllableSession();
      startTurn({
        db,
        conversationId,
        session: fake,
        text: 'hi',
        priorMessageCount: 0,
      });
      fake.pushChunk(startChunk('m1'));
      fake.pushChunk(
        toolInputAvailableChunk('call_1', 'bash', { command: 'ls' }),
      );
      await flushMicrotasks();
      fake.setState({
        id: 'nimbo-sess-1',
        turn: 1,
        createdAt: 5000,
        messages: [
          userTextMessage('u1', 'hi'),
          assistantTextMessage('m1', 'ok', {
            turn: 1,
            usage: {},
            status: 'completed',
          }),
        ],
      });
      fake.finish({ finalResponse: 'ok', usage: {} });
      await flushMicrotasks();

      const persisted = listConversationEvents(db, conversationId);
      expect(persisted.every((r) => r.kind === 'message')).toBe(true);
      expect(persisted).toHaveLength(2);
      const firstMessage = parseMessageRow(persisted[0]);
      expect(firstMessage?.role).toBe('user');
      expect(collectText(firstMessage)).toBe('hi');
      expect(parseMessageRow(persisted[1])).toEqual(
        assistantTextMessage('m1', 'ok', {
          turn: 1,
          usage: {},
          status: 'completed',
        }),
      );

      const row = getConversation(db, conversationId, 'user-1');
      expect(row?.agentSessionId).toBe('nimbo-sess-1');
      expect(row?.agentSessionTurn).toBe(1);
      expect(row?.status).toBe('active');
    });

    it.each(['failed', 'interrupted'] as const)(
      'graceful degrade (status "%s", session.stream() returning a TurnResult rather than throwing) still appends message rows and GCs chunk rows, same as success',
      async (status) => {
        const fake = createControllableSession();
        startTurn({
          db,
          conversationId,
          session: fake,
          text: 'hi',
          priorMessageCount: 0,
        });
        fake.pushChunk(startChunk('m1'));
        fake.pushChunk(
          messageMetadataChunk({
            turn: 1,
            usage: {},
            status,
            error: {
              code: status === 'interrupted' ? 'aborted' : 'max_turns',
              message: 'stopped',
            },
          }),
        );
        await flushMicrotasks();
        fake.setState({
          id: 'nimbo-sess-1',
          turn: 1,
          createdAt: 1000,
          messages: [
            userTextMessage('u1', 'hi'),
            assistantTextMessage('m1', '', { turn: 1, usage: {}, status }),
          ],
        });
        fake.finish({ finalResponse: '', usage: {} });
        await flushMicrotasks();

        const persisted = listConversationEvents(db, conversationId);
        expect(persisted.every((r) => r.kind === 'message')).toBe(true);
        expect(persisted).toHaveLength(2);
        expect(
          getConversation(db, conversationId, 'user-1')?.agentSessionId,
        ).toBe('nimbo-sess-1');
      },
    );

    it('a genuinely thrown exception (driveTurn’s catch branch) still leaves the turn-start user message persisted (never GC’d — finalizeTurnPersistence never runs on this path) but appends NO further message rows, never touches the conversations header, and emits exactly one synthetic failed message-metadata chunk carrying bestEffortTurn (one toJSON() call)', async () => {
      const fake = createControllableSession({
        id: 'fake-session',
        turn: 7,
        messages: [],
        createdAt: 0,
      });
      startTurn({
        db,
        conversationId,
        session: fake,
        text: 'boom',
        priorMessageCount: 0,
      });

      const received: ChatReplayFrame[] = [];
      subscribeTurn(
        conversationId,
        (envelope) => received.push(envelope),
        () => undefined,
      );

      fake.pushChunk(
        toolInputAvailableChunk('call_1', 'bash', { command: 'ls' }),
      );
      await flushMicrotasks();
      fake.fail(new Error('provider exploded'));
      await flushMicrotasks();

      expect(isTurnActive(conversationId)).toBe(false);
      const last = chunkEnvelopes(received).at(-1);
      expect(last?.chunk).toEqual({
        type: 'message-metadata',
        messageMetadata: {
          turn: 7,
          usage: {},
          status: 'failed',
          error: { code: 'provider_error', message: 'provider exploded' },
        },
      });

      // The turn-start user message (seq 1) survives the crash — driveTurn's
      // catch branch never runs finalizeTurnPersistence, so nothing GCs it —
      // plus the durable chunk pushed before the throw, plus the synthetic
      // failure chunk.
      const persisted = listConversationEvents(db, conversationId);
      expect(persisted.map((r) => r.kind)).toEqual([
        'message',
        'chunk',
        'chunk',
      ]);
      expect(
        persisted.map((r) =>
          r.kind === 'message' ?
            'message'
          : (JSON.parse(r.payloadJson) as { type?: string }).type,
        ),
      ).toEqual(['message', 'tool-input-available', 'message-metadata']);
      const startMessage = parseMessageRow(persisted[0]);
      expect(startMessage?.role).toBe('user');
      expect(collectText(startMessage)).toBe('boom');

      const row = getConversation(db, conversationId, 'user-1');
      expect(row?.agentSessionId).toBeNull(); // never touched
      expect(fake.toJSONCalls).toHaveLength(1); // bestEffortTurn's one lookup
    });

    it('multi-turn GC boundary: a crashed turn’s residue rows are never deleted by a later turn’s own GC (afterSeq is the later turn’s own start seq, not the earlier one’s) — including that crashed turn’s own turn-start user message', async () => {
      // Turn 1: success — turn-start user message (seq 1) + 1 assistant
      // message (seq 3) survive; its own chunk row (seq 2) gets GC'd.
      const turn1 = createControllableSession();
      startTurn({
        db,
        conversationId,
        session: turn1,
        text: 'a',
        priorMessageCount: 0,
      });
      turn1.pushChunk(startChunk('m1'));
      await flushMicrotasks();
      turn1.setState({
        id: 'nimbo-sess-1',
        turn: 1,
        createdAt: 1000,
        messages: [
          userTextMessage('u1', 'a'),
          assistantTextMessage('m1', 'first'),
        ],
      });
      turn1.finish({ finalResponse: 'first', usage: {} });
      await flushMicrotasks();
      expect(
        listConversationEvents(db, conversationId).map((r) => r.seq),
      ).toEqual([1, 3]);

      // Turn 2: crashes mid-flight — its own turn-start user message (seq 4)
      // persists and is never GC'd (finalizeTurnPersistence never runs), and
      // its chunk rows (seq 5, 6) are residue, also never GC'd; it appends no
      // further message rows at all.
      const turn2 = createControllableSession();
      startTurn({
        db,
        conversationId,
        session: turn2,
        text: 'b',
        priorMessageCount: 2, // 2 message rows exist so far (seq 1, 3)
      });
      turn2.pushChunk(
        toolInputAvailableChunk('call_1', 'bash', { command: 'ls' }),
      ); // seq 5
      await flushMicrotasks();
      turn2.fail(new Error('boom')); // synthetic failed chunk, seq 6
      await flushMicrotasks();
      const afterTurn2 = listConversationEvents(db, conversationId);
      expect(afterTurn2.map((r) => r.seq)).toEqual([1, 3, 4, 5, 6]);
      expect(afterTurn2.map((r) => r.kind)).toEqual([
        'message',
        'message',
        'message',
        'chunk',
        'chunk',
      ]);

      // Turn 3: starts from turnStartSeq = 6 (includes turn 2's residue),
      // succeeds — its own chunk rows (seq 8, 9) get GC'd, but turn 2's
      // residue (seq 4, 5, 6 — its turn-start message plus its two crash
      // chunks) must survive untouched.
      const turn3 = createControllableSession();
      startTurn({
        db,
        conversationId,
        session: turn3,
        // 3 message rows exist now (turn 2's own dangling turn-start user
        // message, seq 4, counts too — it was persisted even though the
        // turn crashed) — a real resumed session would see it as history.
        priorMessageCount: 3,
        text: 'c',
      });
      turn3.pushChunk(startChunk('m2')); // seq 8
      turn3.pushChunk(startStepChunk()); // seq 9
      await flushMicrotasks();
      turn3.setState({
        id: 'nimbo-sess-1',
        turn: 2,
        createdAt: 1000,
        messages: [
          userTextMessage('u1', 'a'),
          assistantTextMessage('m1', 'first'),
          userTextMessage('u2', 'b'), // turn 2's dangling message — it crashed before ever getting a reply
          userTextMessage('u3', 'c'), // core's own turn-start copy for turn 3 — skipped by the +1 slice
          assistantTextMessage('m2', 'third'),
        ],
      });
      turn3.finish({ finalResponse: 'third', usage: {} });
      await flushMicrotasks();

      const final = listConversationEvents(db, conversationId);
      // seq 4,5,6 (turn 2's crash residue, including its own turn-start
      // message) survive; seq 8,9 (turn 3's own chunks) are GC'd; seq 7 is
      // turn 3's own turn-start message; seq 10 is turn 3's newly-appended
      // assistant message.
      expect(final.map((r) => r.seq)).toEqual([1, 3, 4, 5, 6, 7, 10]);
      expect(final.map((r) => r.kind)).toEqual([
        'message',
        'message',
        'message',
        'chunk',
        'chunk',
        'message',
        'message',
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // steerTurn (STEER-3B, this module's header comment) — the four states
  // `routes/chat.ts`'s `POST .../messages` branches on.
  // ---------------------------------------------------------------------------

  describe('steerTurn', () => {
    it('returns false when there is no active turn for the session at all', () => {
      expect(isTurnActive(conversationId)).toBe(false);
      expect(steerTurn(conversationId, 'hello')).toBe(false);
    });

    it('returns true and forwards the text to session.steer() when a turn is active and steer() reports success', () => {
      const steerable = createSteerableControllableSession();
      const { started } = startTurn({
        db,
        conversationId,
        session: steerable,
        text: 'first',
        priorMessageCount: 0,
      });
      expect(started).toBe(true);

      expect(steerTurn(conversationId, 'also check the tests')).toBe(true);
      expect(steerable.steerCalls).toEqual(['also check the tests']);

      steerable.finish({ finalResponse: 'ok', usage: {} });
    });

    it('returns false when the active turn’s session has no steer() method at all (e.g. a plain createControllableSession fixture)', () => {
      const plain = createControllableSession();
      const { started } = startTurn({
        db,
        conversationId,
        session: plain,
        text: 'first',
        priorMessageCount: 0,
      });
      expect(started).toBe(true);

      expect(steerTurn(conversationId, 'hello')).toBe(false);

      plain.finish({ finalResponse: 'ok', usage: {} });
    });

    it('returns false when session.steer() itself reports failure (the narrow race: the turn finished between steerTurn finding it active and steer() checking its own in-flight state)', () => {
      const steerable = createSteerableControllableSession();
      steerable.setSteerResult(false);
      const { started } = startTurn({
        db,
        conversationId,
        session: steerable,
        text: 'first',
        priorMessageCount: 0,
      });
      expect(started).toBe(true);

      expect(steerTurn(conversationId, 'too late')).toBe(false);
      // steer() was still actually called — it's the *result* that's false, not a short-circuit.
      expect(steerable.steerCalls).toEqual(['too late']);

      steerable.finish({ finalResponse: 'ok', usage: {} });
    });

    it('steerTurn itself never emits a MessageFrame (or anything else) and never appends a ledger row for the steered text — a steered message only ever reaches the wire via session.steer()’s own real chunk sequence (loop.ts’s drainSteerMessages), never turn-runner’s turn-start emitMessage path', () => {
      const steerable = createSteerableControllableSession();
      const { started } = startTurn({
        db,
        conversationId,
        session: steerable,
        text: 'first',
        priorMessageCount: 0,
      });
      expect(started).toBe(true);

      // seq 1: the turn-start user message for 'first', already persisted.
      const beforeSteer = listConversationEvents(db, conversationId);
      expect(beforeSteer).toHaveLength(1);

      const received: ChatReplayFrame[] = [];
      subscribeTurn(
        conversationId,
        (envelope) => received.push(envelope),
        () => undefined,
      );

      expect(steerTurn(conversationId, 'steered text')).toBe(true);
      expect(steerable.steerCalls).toEqual(['steered text']);

      // steerTurn is a pure forward to session.steer() (turn-runner.ts's own
      // implementation: `(input) => session.steer?.(input) ?? false`) — no
      // emitMessage, no emitChunk, no ledger row of its own for the steered
      // text. Whatever the steered message's own start/text-*/finish
      // sequence ends up looking like is entirely `@nimbo/core`'s doing, not
      // turn-runner.ts's.
      expect(received).toEqual([]);
      expect(listConversationEvents(db, conversationId)).toEqual(beforeSteer);

      steerable.finish({ finalResponse: 'ok', usage: {} });
    });
  });

  // ---------------------------------------------------------------------------
  // requestReview / resolveReview (docs/tech/single-ledger.md §6.4's 人审通道) — pure in-memory
  // promise routing now: neither function emits/persists anything of its own
  // (visibility comes entirely from `@nimbo/core`'s own
  // tool-approval-request/tool-approval-response chunks flowing through the
  // normal `emit` path — see turn-runner.ts's file header).
  // ---------------------------------------------------------------------------

  describe('requestReview / resolveReview', () => {
    it('denies immediately, without registering anything, when there is no active turn for the session', async () => {
      expect(isTurnActive(conversationId)).toBe(false);
      const decision = await requestReview(conversationId, {
        callId: 'call_x',
        toolName: 'bash',
        input: { command: 'ls' },
      });
      expect(decision).toEqual({
        behavior: 'deny',
        message: 'No active turn to route this approval request to.',
      });
      expect(isTurnActive(conversationId)).toBe(false);
    });

    it('resolveReview("allow") settles the pending promise', async () => {
      const fake = createControllableSession();
      startTurn({
        db,
        conversationId,
        session: fake,
        text: 'hi',
        priorMessageCount: 0,
      });

      const pending = requestReview(conversationId, {
        callId: 'call_1',
        toolName: 'bash',
        input: { command: 'ls' },
      });
      expect(
        resolveReview(conversationId, 'call_1', { behavior: 'allow' }),
      ).toBe(true);
      await expect(pending).resolves.toEqual({ behavior: 'allow' });

      fake.finish({ finalResponse: 'ok', usage: {} });
    });

    it('resolveReview("deny", message) carries the message through the settled decision; a deny with no message resolves with the field simply absent', async () => {
      const fake = createControllableSession();
      startTurn({
        db,
        conversationId,
        session: fake,
        text: 'hi',
        priorMessageCount: 0,
      });

      const withMessage = requestReview(conversationId, {
        callId: 'call_deny_msg',
        toolName: 'bash',
        input: { command: 'git push' },
      });
      resolveReview(conversationId, 'call_deny_msg', {
        behavior: 'deny',
        message: 'not right now',
      });
      await expect(withMessage).resolves.toEqual({
        behavior: 'deny',
        message: 'not right now',
      });

      const noMessage = requestReview(conversationId, {
        callId: 'call_deny_bare',
        toolName: 'bash',
        input: { command: 'rm -rf x' },
      });
      resolveReview(conversationId, 'call_deny_bare', { behavior: 'deny' });
      const settled = await noMessage;
      expect(settled).toEqual({ behavior: 'deny' });
      expect('message' in settled).toBe(false);

      fake.finish({ finalResponse: 'ok', usage: {} });
    });

    it('resolving the same callId a second time returns false; unknown callId/unknown session both return false', async () => {
      const fake = createControllableSession();
      startTurn({
        db,
        conversationId,
        session: fake,
        text: 'hi',
        priorMessageCount: 0,
      });

      const pending = requestReview(conversationId, {
        callId: 'call_1',
        toolName: 'bash',
        input: { command: 'ls' },
      });
      expect(
        resolveReview(conversationId, 'call_1', { behavior: 'allow' }),
      ).toBe(true);
      expect(
        resolveReview(conversationId, 'call_1', { behavior: 'allow' }),
      ).toBe(false);
      expect(
        resolveReview(conversationId, 'never-requested', { behavior: 'allow' }),
      ).toBe(false);
      expect(
        resolveReview('sess-does-not-exist', 'call_1', { behavior: 'allow' }),
      ).toBe(false);

      await pending;
      fake.finish({ finalResponse: 'ok', usage: {} });
    });

    it('auto-denies via the exact same resolveReview path once the timeout elapses, with a timeout explanation; resolving it afterward is a no-op', async () => {
      const fake = createControllableSession();
      startTurn({
        db,
        conversationId,
        session: fake,
        text: 'hi',
        priorMessageCount: 0,
      });

      const decision = await requestReview(
        conversationId,
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

      // already settled by the timeout — a later manual resolve is a no-op.
      expect(
        resolveReview(conversationId, 'call_timeout', { behavior: 'allow' }),
      ).toBe(false);

      fake.finish({ finalResponse: 'ok', usage: {} });
    });

    it('turn-runner never emits/persists anything for requestReview/resolveReview themselves — only the turn-start user message and whatever chunks the session’s own generator happens to yield', async () => {
      const fake = createControllableSession();
      startTurn({
        db,
        conversationId,
        session: fake,
        text: 'hi',
        priorMessageCount: 0,
      });
      const received: ChatReplayFrame[] = [];
      subscribeTurn(
        conversationId,
        (envelope) => received.push(envelope),
        () => undefined,
      );

      const pending = requestReview(conversationId, {
        callId: 'call_1',
        toolName: 'bash',
        input: { command: 'ls' },
      });
      resolveReview(conversationId, 'call_1', { behavior: 'allow' });
      await pending;

      expect(received).toEqual([]); // no chunks were ever pushed
      // Only the turn-start user message — requestReview/resolveReview
      // persisted nothing of their own.
      const persisted = listConversationEvents(db, conversationId);
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.kind).toBe('message');

      fake.finish({ finalResponse: 'ok', usage: {} });
    });

    it('ordering invariant (docs/tech/single-ledger.md §6.1): a hand-written generator that mimics @nimbo/core’s loop — yield tool-approval-request, THEN await onReview (requestReview) — has that request already persisted+broadcast before requestReview’s promise can possibly be observed as pending by a caller', async () => {
      const decisions: HumanDecision[] = [];
      const session: TurnDrivenSession = {
        toJSON(): SessionState {
          return { id: 'fake', turn: 1, messages: [], createdAt: 0 };
        },
        async *stream(): AsyncGenerator<
          NimboChunk,
          { finalResponse: string; usage: object }
        > {
          yield toolApprovalRequestChunk('call_1');
          const decision = await requestReview(conversationId, {
            callId: 'call_1',
            toolName: 'bash',
            input: { command: 'git push' },
          });
          decisions.push(decision);
          yield toolApprovalResponseChunk(
            'call_1',
            decision.behavior === 'allow',
            decision.behavior === 'deny' ? decision.message : undefined,
          );
          return { finalResponse: 'done', usage: {} };
        },
      };

      startTurn({
        db,
        conversationId,
        session,
        text: 'push my branch',
        priorMessageCount: 0,
      });
      const received: ChatReplayFrame[] = [];
      subscribeTurn(
        conversationId,
        (envelope) => received.push(envelope),
        () => undefined,
      );

      await flushMicrotasks();
      // The request chunk is already persisted+broadcast — before this test
      // even calls resolveReview — precisely because driveTurn's `emit(step.value)`
      // for it runs (and completes) strictly before the next `gen.next()` call
      // resumes the generator far enough to reach `await requestReview(...)`.
      expect(chunkEnvelopes(received).map((e) => e.chunk.type)).toEqual([
        'tool-approval-request',
      ]);
      // seq 1: the turn-start user message; seq 2: the approval-request chunk.
      expect(listConversationEvents(db, conversationId)).toHaveLength(2);

      expect(
        resolveReview(conversationId, 'call_1', { behavior: 'allow' }),
      ).toBe(true);
      await flushMicrotasks();

      expect(decisions).toEqual([{ behavior: 'allow' }]);
      expect(chunkEnvelopes(received).map((e) => e.chunk.type)).toEqual([
        'tool-approval-request',
        'tool-approval-response',
      ]);
      expect(isTurnActive(conversationId)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // requestUserAnswer / resolveUserAnswer — structural sibling of the review
  // bridge above, also pure in-memory promise routing now.
  // ---------------------------------------------------------------------------

  describe('requestUserAnswer / resolveUserAnswer', () => {
    it('resolves { outcome: "timeout" } immediately, without registering anything, when there is no active turn for the session', async () => {
      expect(isTurnActive(conversationId)).toBe(false);
      const outcome = await requestUserAnswer(conversationId, {
        callId: 'call_x',
        question: 'what next?',
      });
      expect(outcome).toEqual({ outcome: 'timeout' });
      expect(isTurnActive(conversationId)).toBe(false);
    });

    it('resolveUserAnswer settles the pending promise with the answer; resolving the same callId again returns false', async () => {
      const fake = createControllableSession();
      startTurn({
        db,
        conversationId,
        session: fake,
        text: 'hi',
        priorMessageCount: 0,
      });

      const pending = requestUserAnswer(conversationId, {
        callId: 'call_1',
        question: 'continue?',
      });
      expect(resolveUserAnswer(conversationId, 'call_1', 'yes please')).toBe(
        true,
      );
      await expect(pending).resolves.toEqual({
        outcome: 'answered',
        answer: 'yes please',
      });
      expect(resolveUserAnswer(conversationId, 'call_1', 'yes again')).toBe(
        false,
      );

      fake.finish({ finalResponse: 'ok', usage: {} });
    });

    it('auto-times-out via the same settle path when the timeout elapses — outcome "timeout" carries no answer field; a later resolve is a no-op', async () => {
      const fake = createControllableSession();
      startTurn({
        db,
        conversationId,
        session: fake,
        text: 'hi',
        priorMessageCount: 0,
      });

      const outcome = await requestUserAnswer(
        conversationId,
        { callId: 'call_timeout', question: 'still there?' },
        { timeoutMs: 10 },
      );
      expect(outcome).toEqual({ outcome: 'timeout' });
      expect(
        resolveUserAnswer(conversationId, 'call_timeout', 'too late'),
      ).toBe(false);

      fake.finish({ finalResponse: 'ok', usage: {} });
    });

    it('turn-runner never emits/persists anything for requestUserAnswer/resolveUserAnswer themselves', async () => {
      const fake = createControllableSession();
      startTurn({
        db,
        conversationId,
        session: fake,
        text: 'hi',
        priorMessageCount: 0,
      });
      const received: ChatReplayFrame[] = [];
      subscribeTurn(
        conversationId,
        (envelope) => received.push(envelope),
        () => undefined,
      );

      const pending = requestUserAnswer(conversationId, {
        callId: 'call_1',
        question: 'pick a color',
        options: ['red', 'blue'],
      });
      resolveUserAnswer(conversationId, 'call_1', 'red');
      await pending;

      expect(received).toEqual([]);
      const persisted = listConversationEvents(db, conversationId);
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.kind).toBe('message');

      fake.finish({ finalResponse: 'ok', usage: {} });
    });
  });

  // ---------------------------------------------------------------------------
  // Cross-bridge behavior: independent maps, and the turn-teardown sweep.
  // ---------------------------------------------------------------------------

  describe('review/question bridges together', () => {
    it('pendingReviews and pendingQuestions are independent maps — the same callId in both resolves independently without cross-talk', async () => {
      const fake = createControllableSession();
      startTurn({
        db,
        conversationId,
        session: fake,
        text: 'hi',
        priorMessageCount: 0,
      });

      const reviewPromise = requestReview(conversationId, {
        callId: 'shared-id',
        toolName: 'bash',
        input: { command: 'ls' },
      });
      const questionPromise = requestUserAnswer(conversationId, {
        callId: 'shared-id',
        question: 'pick one',
      });

      // Resolve only the question — the review (same callId, other map)
      // must remain pending.
      expect(resolveUserAnswer(conversationId, 'shared-id', 'blue')).toBe(true);
      await expect(questionPromise).resolves.toEqual({
        outcome: 'answered',
        answer: 'blue',
      });

      // The review's own pending entry was untouched by the question's resolve.
      expect(
        resolveReview(conversationId, 'shared-id', { behavior: 'allow' }),
      ).toBe(true);
      await expect(reviewPromise).resolves.toEqual({ behavior: 'allow' });

      fake.finish({ finalResponse: 'ok', usage: {} });
    });

    it('turn teardown sweeps leftover pending reviews/questions (deny/timeout) once the turn ends without them ever being resolved', async () => {
      const fake = createControllableSession();
      startTurn({
        db,
        conversationId,
        session: fake,
        text: 'hi',
        priorMessageCount: 0,
      });

      // Registered with a timeout far longer than this test's lifetime — the
      // only way they can ever settle is via the turn-teardown sweep below.
      const reviewPromise = requestReview(
        conversationId,
        { callId: 'call_1', toolName: 'bash', input: { command: 'ls' } },
        { timeoutMs: 999_999 },
      );
      const questionPromise = requestUserAnswer(
        conversationId,
        { callId: 'call_2', question: 'ok?' },
        { timeoutMs: 999_999 },
      );
      await flushMicrotasks();

      // The controllable session's own generator ends right now — with
      // neither pending request ever resolved through the normal path.
      fake.finish({ finalResponse: 'done', usage: {} });
      await flushMicrotasks();

      const [reviewDecision, questionOutcome] = await Promise.all([
        reviewPromise,
        questionPromise,
      ]);
      expect(reviewDecision.behavior).toBe('deny');
      expect(questionOutcome).toEqual({ outcome: 'timeout' });

      // Resolving by hand after the sweep is a no-op — the pending entries
      // (and the whole turn) are already gone.
      expect(
        resolveReview(conversationId, 'call_1', { behavior: 'allow' }),
      ).toBe(false);
      expect(resolveUserAnswer(conversationId, 'call_2', 'too late')).toBe(
        false,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 停止本轮（docs/tech/turn-abort.md §3.1）——`abortTurn`。这里断言的是 chat 层
  // 那一半：signal 确实交给了 core、挂起的人审/提问被就地结掉、幂等。core 那一半
  // （「看到 abort 就在 step 边界优雅收尾」）由 packages/core 的 loop.test.ts 覆盖，
  // 这里的 fake session 只扮演它的产出（`message-metadata` + `finish`）。
  // ---------------------------------------------------------------------------

  describe('abortTurn', () => {
    it('returns false when there is no active turn for the session (routes/chat.ts turns that into a 409)', () => {
      expect(isTurnActive(conversationId)).toBe(false);
      expect(abortTurn(conversationId)).toBe(false);
    });

    it('passes this turn’s own signal into session.stream() and aborts it — the same signal @nimbo/core’s loop checks at each step boundary', async () => {
      const fake = createControllableSession();
      startTurn({
        db,
        conversationId,
        session: fake,
        text: 'hi',
        priorMessageCount: 0,
      });
      await flushMicrotasks();

      const signal = fake.turnSignal;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);

      expect(abortTurn(conversationId)).toBe(true);
      expect(signal?.aborted).toBe(true);

      fake.finish({ finalResponse: '', usage: {} });
      await flushMicrotasks();
    });

    it('is idempotent: a second abort (a double-clicked stop key) returns true without re-running the teardown, and the turn still finalizes exactly once', async () => {
      const fake = createControllableSession();
      startTurn({
        db,
        conversationId,
        session: fake,
        text: 'hi',
        priorMessageCount: 0,
      });
      await flushMicrotasks();

      expect(abortTurn(conversationId)).toBe(true);
      expect(abortTurn(conversationId)).toBe(true);
      expect(abortTurn(conversationId)).toBe(true);

      // 停止后 core 走优雅收尾：一条 interrupted 的 message-metadata + 正常 return。
      fake.setState({
        id: 'fake-session',
        turn: 1,
        messages: [
          userTextMessage('u1', 'hi'),
          assistantTextMessage('a1', '半截'),
        ],
        createdAt: 0,
      });
      fake.pushChunk(
        messageMetadataChunk({
          turn: 1,
          usage: {},
          status: 'interrupted',
          error: { code: 'aborted', message: 'Turn stopped by the user.' },
        }),
      );
      fake.finish({ finalResponse: '半截', usage: {} });
      await flushMicrotasks();

      // 优雅收尾这条路走的是既有的 finalizeTurnPersistence（本功能不新增落盘路径）：
      // 已产出的内容留着，chunk 行被 GC，会话 header 更新。
      expect(isTurnActive(conversationId)).toBe(false);
      const rows = listConversationEvents(db, conversationId);
      expect(rows.map((row) => row.kind)).toEqual(['message', 'message']);
      expect(
        getConversation(db, conversationId, 'user-1')?.agentSessionTurn,
      ).toBe(1);
    });

    it('settles every pending review/question on the spot (deny/timeout) — a turn parked on an approval card stops now, not after CHAT_APPROVAL_TIMEOUT_MS', async () => {
      const fake = createControllableSession();
      startTurn({
        db,
        conversationId,
        session: fake,
        text: 'hi',
        priorMessageCount: 0,
      });

      // Timeouts far beyond this test's lifetime: the only thing that can settle
      // these is `abortTurn` itself (the same discipline the teardown-sweep test
      // above uses).
      const reviewPromise = requestReview(
        conversationId,
        {
          callId: 'call_1',
          toolName: 'bash',
          input: { command: 'rm -rf build' },
        },
        { timeoutMs: 999_999 },
      );
      const questionPromise = requestUserAnswer(
        conversationId,
        { callId: 'call_2', question: 'which one?' },
        { timeoutMs: 999_999 },
      );
      await flushMicrotasks();

      expect(abortTurn(conversationId)).toBe(true);

      const [decision, outcome] = await Promise.all([
        reviewPromise,
        questionPromise,
      ]);
      expect(decision).toEqual({
        behavior: 'deny',
        message:
          'The user stopped this turn, so this tool call was not approved.',
      });
      expect(outcome).toEqual({ outcome: 'timeout' });

      fake.finish({ finalResponse: '', usage: {} });
      await flushMicrotasks();
    });

    it('a review/question requested AFTER the abort is refused immediately instead of registering a new pending entry (the other parallel tool calls of the step being stopped)', async () => {
      const fake = createControllableSession();
      startTurn({
        db,
        conversationId,
        session: fake,
        text: 'hi',
        priorMessageCount: 0,
      });
      await flushMicrotasks();

      expect(abortTurn(conversationId)).toBe(true);

      // 999_999ms 的超时仍在，所以「立刻 resolve」只可能来自 aborted 闸门本身。
      const decision = await requestReview(
        conversationId,
        { callId: 'call_late', toolName: 'bash', input: { command: 'ls' } },
        { timeoutMs: 999_999 },
      );
      expect(decision).toEqual({
        behavior: 'deny',
        message:
          'The user stopped this turn, so this tool call was not approved.',
      });

      const outcome = await requestUserAnswer(
        conversationId,
        { callId: 'q_late', question: 'still there?' },
        { timeoutMs: 999_999 },
      );
      expect(outcome).toEqual({ outcome: 'timeout' });

      // 没有注册挂起项：手动解也解不到（本来就不在 Map 里）。
      expect(
        resolveReview(conversationId, 'call_late', { behavior: 'allow' }),
      ).toBe(false);
      expect(resolveUserAnswer(conversationId, 'q_late', 'yes')).toBe(false);

      fake.finish({ finalResponse: '', usage: {} });
      await flushMicrotasks();
    });

    it('logs one "turn abort requested" line carrying how many pending reviews/questions it had to settle', async () => {
      const lines: string[] = [];
      const logger = createLogger({
        sink: (line) => lines.push(line),
        level: 'debug',
      });
      const fake = createControllableSession();
      startTurn({
        db,
        conversationId,
        session: fake,
        text: 'hi',
        priorMessageCount: 0,
        logger,
      });
      void requestReview(
        conversationId,
        { callId: 'call_1', toolName: 'bash', input: { command: 'ls' } },
        { timeoutMs: 999_999 },
      );
      await flushMicrotasks();

      abortTurn(conversationId, logger);

      const abortLine = lines.find((line) =>
        line.includes('turn abort requested'),
      );
      expect(abortLine).toBeDefined();
      expect(abortLine).toContain('"pendingReviews":1');
      expect(abortLine).toContain('"pendingQuestions":0');

      fake.finish({ finalResponse: '', usage: {} });
      await flushMicrotasks();
    });
  });

  // ---------------------------------------------------------------------------
  // 起轮装配打点的通知点（docs/tech/telemetry.md §2.4）——`onMilestone` 与
  // `onTurnSettled` 同款：纯报告，不改变任何 chunk 流转/持久化行为。
  // ---------------------------------------------------------------------------

  describe('onMilestone', () => {
    interface Reported {
      milestone: string;
      sessionId: string;
      turn: number;
    }

    /** 记下每次报告（丢掉 `sinceStartMs`——真实墙钟，断言它的具体值只会得到一个 flaky 测试；「有这个字段且是非负数」在下面单独断言一次）。 */
    function collectingMilestones(): {
      reported: Reported[];
      elapsed: number[];
      onMilestone: (
        milestone: string,
        info: { sessionId: string; turn: number; sinceStartMs: number },
      ) => void;
    } {
      const reported: Reported[] = [];
      const elapsed: number[] = [];
      return {
        reported,
        elapsed,
        onMilestone: (milestone, info) => {
          reported.push({
            milestone,
            sessionId: info.sessionId,
            turn: info.turn,
          });
          elapsed.push(info.sinceStartMs);
        },
      };
    }

    it('reports first-chunk on the very first chunk and first-output on the first *visible* one, each exactly once, keyed by the session’s own id/turn', async () => {
      const fake = createControllableSession({
        id: 'nimbo-sess-9',
        turn: 3,
        messages: [],
        createdAt: 0,
      });
      const { reported, elapsed, onMilestone } = collectingMilestones();

      startTurn({
        db,
        conversationId,
        session: fake,
        text: 'hi',
        priorMessageCount: 0,
        onMilestone,
      });

      // `start`/`start-step` 是空气泡——只算 first-chunk，不算 first-output。
      fake.pushChunk(startChunk('m1'));
      await flushMicrotasks();
      expect(reported).toEqual([
        { milestone: 'first-chunk', sessionId: 'nimbo-sess-9', turn: 3 },
      ]);

      fake.pushChunk(startStepChunk());
      await flushMicrotasks();
      expect(reported).toHaveLength(1); // 仍然只有 first-chunk

      // 第一段文字 = 用户第一次真的看见东西。
      fake.pushChunk(textStartChunk('t1'));
      await flushMicrotasks();
      expect(reported).toEqual([
        { milestone: 'first-chunk', sessionId: 'nimbo-sess-9', turn: 3 },
        { milestone: 'first-output', sessionId: 'nimbo-sess-9', turn: 3 },
      ]);

      // 后续可见 chunk 不再触发（两个闸门都是一次性的）。
      fake.pushChunk(textDeltaChunk('t1', 'a'));
      fake.pushChunk(textEndChunk('t1'));
      fake.pushChunk(toolInputAvailableChunk('c1', 'bash', { command: 'ls' }));
      await flushMicrotasks();
      expect(reported).toHaveLength(2);
      expect(elapsed).toHaveLength(2);
      expect(elapsed.every((ms) => Number.isFinite(ms) && ms >= 0)).toBe(true);

      fake.finish({ finalResponse: 'ok', usage: {} });
      await flushMicrotasks();
    });

    it('reports first-output on a tool call when the model calls a tool before writing any text (no text/reasoning at all)', async () => {
      const fake = createControllableSession();
      const { reported, onMilestone } = collectingMilestones();

      startTurn({
        db,
        conversationId,
        session: fake,
        text: 'hi',
        priorMessageCount: 0,
        onMilestone,
      });

      fake.pushChunk(startChunk('m1'));
      fake.pushChunk(startStepChunk());
      fake.pushChunk(toolInputAvailableChunk('c1', 'bash', { command: 'ls' }));
      await flushMicrotasks();

      expect(reported.map((r) => r.milestone)).toEqual([
        'first-chunk',
        'first-output',
      ]);

      fake.finish({ finalResponse: 'ok', usage: {} });
      await flushMicrotasks();
    });

    it('reports first-chunk but never first-output for a turn that produces no visible chunk at all (failed before the model said anything)', async () => {
      const fake = createControllableSession();
      const { reported, onMilestone } = collectingMilestones();

      startTurn({
        db,
        conversationId,
        session: fake,
        text: 'hi',
        priorMessageCount: 0,
        onMilestone,
      });

      fake.pushChunk(
        messageMetadataChunk({
          turn: 1,
          usage: {},
          status: 'failed',
          error: { code: 'provider_error', message: 'boom' },
        }),
      );
      await flushMicrotasks();
      fake.finish({ finalResponse: '', usage: {} });
      await flushMicrotasks();

      expect(reported.map((r) => r.milestone)).toEqual(['first-chunk']);
    });

    it('swallows a throwing callback (and a throwing toJSON) — the turn still drives and persists exactly as it would without any callback', async () => {
      const { lines, logger } = (() => {
        const collected: string[] = [];
        return {
          lines: collected,
          logger: createLogger({
            level: 'debug',
            sink: (line) => {
              collected.push(line);
            },
          }),
        };
      })();
      const fake = createControllableSession();

      startTurn({
        db,
        conversationId,
        session: fake,
        text: 'hi',
        priorMessageCount: 0,
        logger,
        onMilestone: () => {
          throw new Error('observer blew up');
        },
      });

      fake.pushChunk(startChunk('m1'));
      fake.pushChunk(textStartChunk('t1'));
      fake.pushChunk(textDeltaChunk('t1', 'ok'));
      fake.pushChunk(textEndChunk('t1'));
      await flushMicrotasks();
      fake.setState({
        id: 'fake-session',
        turn: 1,
        createdAt: 0,
        messages: [
          userTextMessage('u1', 'hi'),
          assistantTextMessage('m1', 'ok', {
            turn: 1,
            usage: {},
            status: 'completed',
          }),
        ],
      });
      fake.finish({ finalResponse: 'ok', usage: {} });
      await flushMicrotasks();

      // 轮照常跑完并落盘（回调抛错被吞），只多了两行 error 日志。
      expect(isTurnActive(conversationId)).toBe(false);
      expect(
        listConversationEvents(db, conversationId).filter(
          (row) => row.kind === 'message',
        ),
      ).toHaveLength(2);
      expect(
        lines.filter((line) => line.includes('onMilestone threw')),
      ).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Logging tap (chat 可观测性工单: step / tool call 级别日志) — a pure旁路
  // tap threaded through `StartTurnParams.logger`: asserts the emitted log
  // line sequence via an injected `createLogger({ sink })`, and separately
  // asserts the tap changes NOTHING about persistence (same `conversation_events`
  // shape with or without a logger injected).
  // ---------------------------------------------------------------------------

  describe('logging tap (StartTurnParams.logger)', () => {
    interface ParsedLine {
      level: string;
      scope: string;
      message: string;
      fields: Record<string, unknown>;
    }

    function collectingLogger(): {
      lines: string[];
      logger: ReturnType<typeof createLogger>;
    } {
      const lines: string[] = [];
      const logger = createLogger({
        level: 'debug',
        sink: (line) => {
          lines.push(line);
        },
      });
      return { lines, logger };
    }

    /** `<ISO timestamp> <LEVEL> [<scope>] <message> <fields-json>?` — same format `logger.test.ts` pins. */
    function parseLine(line: string): ParsedLine {
      const match = /^\S+ (\w+) \[([\w-]+)\] (.*?)(?: (\{.*\}))?$/.exec(line);
      const level = match?.[1] ?? '';
      const scope = match?.[2] ?? '';
      const message = match?.[3] ?? '';
      const fieldsJson = match?.[4];
      const fields: Record<string, unknown> =
        fieldsJson === undefined ?
          {}
        : (JSON.parse(fieldsJson) as Record<string, unknown>);
      return { level, scope, message, fields };
    }

    it('logs "turn started" (INFO, with conversationId + a truncated text preview) as driveTurn’s very first line', async () => {
      const { lines, logger } = collectingLogger();
      const fake = createControllableSession();
      startTurn({
        db,
        conversationId,
        session: fake,
        text: 'hello there',
        priorMessageCount: 0,
        logger,
      });

      const first = parseLine(lines[0] ?? '');
      expect(first.level).toBe('INFO');
      expect(first.scope).toBe('turn-runner');
      expect(first.message).toBe('turn started');
      expect(first.fields).toMatchObject({
        conversationId,
        text: 'hello there',
      });

      fake.finish({ finalResponse: 'ok', usage: {} });
    });

    it('truncates the turn-started text preview at 120 chars', async () => {
      const { lines, logger } = collectingLogger();
      const fake = createControllableSession();
      const longText = 'x'.repeat(200);
      startTurn({
        db,
        conversationId,
        session: fake,
        text: longText,
        priorMessageCount: 0,
        logger,
      });

      const first = parseLine(lines[0] ?? '');
      expect(typeof first.fields.text).toBe('string');
      const preview = first.fields.text as string;
      expect(preview.length).toBeLessThan(longText.length);
      expect(preview).toContain('+80'); // 200 - 120 omitted chars

      fake.finish({ finalResponse: 'ok', usage: {} });
    });

    it('logs "step started"/"step finished" with a shared, incrementing step counter across two steps', async () => {
      const { lines, logger } = collectingLogger();
      const fake = createControllableSession();
      startTurn({
        db,
        conversationId,
        session: fake,
        text: 'hi',
        priorMessageCount: 0,
        logger,
      });

      fake.pushChunk(startStepChunk());
      await flushMicrotasks();
      fake.pushChunk(finishStepChunk());
      await flushMicrotasks();
      fake.pushChunk(startStepChunk());
      await flushMicrotasks();
      fake.pushChunk(finishStepChunk());
      await flushMicrotasks();
      fake.finish({ finalResponse: 'ok', usage: {} });
      await flushMicrotasks();

      const stepLines = lines
        .filter(
          (l) => l.includes('step started') || l.includes('step finished'),
        )
        .map(parseLine);
      expect(stepLines.map((l) => [l.message, l.fields.step])).toEqual([
        ['step started', 1],
        ['step finished', 1],
        ['step started', 2],
        ['step finished', 2],
      ]);
    });

    it('logs "tool call started" (INFO) with toolName/callId/an input preview truncated at 200 chars', async () => {
      const { lines, logger } = collectingLogger();
      const fake = createControllableSession();
      startTurn({
        db,
        conversationId,
        session: fake,
        text: 'hi',
        priorMessageCount: 0,
        logger,
      });

      const longCommand = 'echo '.concat('y'.repeat(250));
      fake.pushChunk(
        toolInputAvailableChunk('call_1', 'bash', { command: longCommand }),
      );
      await flushMicrotasks();
      fake.finish({ finalResponse: 'ok', usage: {} });
      await flushMicrotasks();

      const started = parseLine(
        lines.find((l) => l.includes('tool call started')) ?? '',
      );
      expect(started.level).toBe('INFO');
      expect(started.fields).toMatchObject({
        conversationId,
        toolName: 'bash',
        callId: 'call_1',
      });
      expect(typeof started.fields.input).toBe('string');
      expect((started.fields.input as string).length).toBeLessThan(
        JSON.stringify({ command: longCommand }).length,
      );
    });

    it('does NOT log anything for a data-tool-timing update that only carries startedAt (the "start" half — already covered by "tool call started")', async () => {
      const { lines, logger } = collectingLogger();
      const fake = createControllableSession();
      startTurn({
        db,
        conversationId,
        session: fake,
        text: 'hi',
        priorMessageCount: 0,
        logger,
      });

      fake.pushChunk(
        toolInputAvailableChunk('call_1', 'bash', { command: 'ls' }),
      );
      await flushMicrotasks();
      const beforeTiming = lines.length;
      fake.pushChunk(dataToolTimingChunk('call_1', 1000)); // startedAt only, no completedAt
      await flushMicrotasks();

      expect(lines.length).toBe(beforeTiming); // no new line at all

      fake.finish({ finalResponse: 'ok', usage: {} });
      await flushMicrotasks();
    });

    it('logs "tool call completed" (INFO) only once the matching data-tool-timing completedAt update arrives, with durationMs read from that chunk (single source of truth, not a second Date.now() clock)', async () => {
      const { lines, logger } = collectingLogger();
      const fake = createControllableSession();
      startTurn({
        db,
        conversationId,
        session: fake,
        text: 'hi',
        priorMessageCount: 0,
        logger,
      });

      fake.pushChunk(
        toolInputAvailableChunk('call_1', 'bash', { command: 'ls' }),
      );
      await flushMicrotasks();
      fake.pushChunk(dataToolTimingChunk('call_1', 1000)); // start
      await flushMicrotasks();
      fake.pushChunk(
        toolOutputAvailableChunk('call_1', { exitCode: 0, stdout: 'a.txt' }),
      );
      await flushMicrotasks();
      // Not logged yet — waiting on the matching completedAt update.
      expect(lines.some((l) => l.includes('tool call completed'))).toBe(false);

      fake.pushChunk(dataToolTimingChunk('call_1', 1000, 1750)); // complete: durationMs must be exactly 750
      await flushMicrotasks();
      fake.finish({ finalResponse: 'ok', usage: {} });
      await flushMicrotasks();

      const completed = parseLine(
        lines.find((l) => l.includes('tool call completed')) ?? '',
      );
      expect(completed.level).toBe('INFO');
      expect(completed.fields).toMatchObject({
        conversationId,
        callId: 'call_1',
        durationMs: 750,
      });
      expect(typeof completed.fields.outputSize).toBe('number');
    });

    it('splits the two clocks once executionStartedAt is present: "tool call executing" (DEBUG) carries queueMs, and the settle line’s durationMs is execution-only (completedAt - executionStartedAt) with queueMs alongside', async () => {
      const { lines, logger } = collectingLogger();
      const fake = createControllableSession();
      startTurn({
        db,
        conversationId,
        session: fake,
        text: 'hi',
        priorMessageCount: 0,
        logger,
      });

      fake.pushChunk(
        toolInputAvailableChunk('call_1', 'bash', { command: 'ls' }),
      );
      fake.pushChunk(dataToolTimingChunk('call_1', 1000)); // 成形入队
      await flushMicrotasks();
      // 排队/审批结束、真正开始执行——queueMs = 1400 - 1000。
      fake.pushChunk(dataToolTimingChunk('call_1', 1000, undefined, 1400));
      await flushMicrotasks();

      const executing = parseLine(
        lines.find((l) => l.includes('tool call executing')) ?? '',
      );
      expect(executing.level).toBe('DEBUG');
      expect(executing.fields).toMatchObject({
        conversationId,
        callId: 'call_1',
        queueMs: 400,
      });

      fake.pushChunk(
        toolOutputAvailableChunk('call_1', { exitCode: 0, stdout: 'a.txt' }),
      );
      fake.pushChunk(dataToolTimingChunk('call_1', 1000, 1750, 1400));
      await flushMicrotasks();
      fake.finish({ finalResponse: 'ok', usage: {} });
      await flushMicrotasks();

      const completed = parseLine(
        lines.find((l) => l.includes('tool call completed')) ?? '',
      );
      // durationMs 是真实执行耗时（1750-1400），排队等待单列——两者相加才是
      // 用户在界面上看到的全程等待（2026-07-16 定案）。
      expect(completed.fields).toMatchObject({
        callId: 'call_1',
        durationMs: 350,
        queueMs: 400,
      });
    });

    it('logs "tool call errored" (WARN) with errorText, gated the same way behind data-tool-timing’s completedAt', async () => {
      const { lines, logger } = collectingLogger();
      const fake = createControllableSession();
      startTurn({
        db,
        conversationId,
        session: fake,
        text: 'hi',
        priorMessageCount: 0,
        logger,
      });

      fake.pushChunk(
        toolInputAvailableChunk('call_1', 'bash', { command: 'ls' }),
      );
      await flushMicrotasks();
      fake.pushChunk(dataToolTimingChunk('call_1', 1000));
      await flushMicrotasks();
      fake.pushChunk(toolOutputErrorChunk('call_1', 'command not found'));
      await flushMicrotasks();
      expect(lines.some((l) => l.includes('tool call errored'))).toBe(false);

      fake.pushChunk(dataToolTimingChunk('call_1', 1000, 1200));
      await flushMicrotasks();
      fake.finish({ finalResponse: 'ok', usage: {} });
      await flushMicrotasks();

      const errored = parseLine(
        lines.find((l) => l.includes('tool call errored')) ?? '',
      );
      expect(errored.level).toBe('WARN');
      expect(errored.fields).toMatchObject({
        conversationId,
        callId: 'call_1',
        errorText: 'command not found',
        durationMs: 200,
      });
    });

    it('logs "tool call denied" (WARN), gated the same way behind data-tool-timing’s completedAt', async () => {
      const { lines, logger } = collectingLogger();
      const fake = createControllableSession();
      startTurn({
        db,
        conversationId,
        session: fake,
        text: 'hi',
        priorMessageCount: 0,
        logger,
      });

      fake.pushChunk(
        toolInputAvailableChunk('call_1', 'bash', { command: 'rm -rf /' }),
      );
      await flushMicrotasks();
      fake.pushChunk(dataToolTimingChunk('call_1', 1000));
      await flushMicrotasks();
      fake.pushChunk(toolOutputDeniedChunk('call_1'));
      await flushMicrotasks();
      expect(lines.some((l) => l.includes('tool call denied'))).toBe(false);

      fake.pushChunk(dataToolTimingChunk('call_1', 1000, 1050));
      await flushMicrotasks();
      fake.finish({ finalResponse: 'ok', usage: {} });
      await flushMicrotasks();

      const denied = parseLine(
        lines.find((l) => l.includes('tool call denied')) ?? '',
      );
      expect(denied.level).toBe('WARN');
      expect(denied.fields).toMatchObject({
        conversationId,
        callId: 'call_1',
        durationMs: 50,
      });
    });

    it('logs "tool approval requested"/"tool approval resolved" (INFO), with waitMs on the resolved line reflecting real elapsed time between the two', async () => {
      const { lines, logger } = collectingLogger();
      const fake = createControllableSession();
      startTurn({
        db,
        conversationId,
        session: fake,
        text: 'hi',
        priorMessageCount: 0,
        logger,
      });

      fake.pushChunk(toolApprovalRequestChunk('call_1'));
      await flushMicrotasks();
      await new Promise((resolve) => setTimeout(resolve, 5)); // a little real elapsed time
      fake.pushChunk(toolApprovalResponseChunk('call_1', true));
      await flushMicrotasks();
      fake.finish({ finalResponse: 'ok', usage: {} });
      await flushMicrotasks();

      const requested = parseLine(
        lines.find((l) => l.includes('tool approval requested')) ?? '',
      );
      expect(requested.level).toBe('INFO');
      expect(requested.fields).toMatchObject({
        conversationId,
        approvalId: 'call_1',
        callId: 'call_1',
      });

      const resolved = parseLine(
        lines.find((l) => l.includes('tool approval resolved')) ?? '',
      );
      expect(resolved.level).toBe('INFO');
      expect(resolved.fields).toMatchObject({
        conversationId,
        approvalId: 'call_1',
        approved: true,
      });
      expect(typeof resolved.fields.waitMs).toBe('number');
      expect(resolved.fields.waitMs as number).toBeGreaterThanOrEqual(0);
    });

    it('"tool approval resolved" carries no waitMs field at all (JSON.stringify drops it) when there was no matching prior request', async () => {
      const { lines, logger } = collectingLogger();
      const fake = createControllableSession();
      startTurn({
        db,
        conversationId,
        session: fake,
        text: 'hi',
        priorMessageCount: 0,
        logger,
      });

      // No toolApprovalRequestChunk pushed first — a defensive branch that
      // shouldn't happen in real @nimbo/core-driven traffic, but the tap must
      // not throw.
      fake.pushChunk(toolApprovalResponseChunk('call_1', false, 'denied'));
      await flushMicrotasks();
      fake.finish({ finalResponse: 'ok', usage: {} });
      await flushMicrotasks();

      const resolved = parseLine(
        lines.find((l) => l.includes('tool approval resolved')) ?? '',
      );
      expect('waitMs' in resolved.fields).toBe(false);
    });

    it('logs "turn finished" (INFO) with status read off the last message-metadata chunk and a durationMs for the whole turn', async () => {
      const { lines, logger } = collectingLogger();
      const fake = createControllableSession();
      startTurn({
        db,
        conversationId,
        session: fake,
        text: 'hi',
        priorMessageCount: 0,
        logger,
      });

      fake.pushChunk(
        messageMetadataChunk({ turn: 1, usage: {}, status: 'completed' }),
      );
      await flushMicrotasks();
      fake.setState({
        id: 'nimbo-sess-1',
        turn: 1,
        createdAt: 1000,
        messages: [
          userTextMessage('u1', 'hi'),
          assistantTextMessage('m1', 'ok', {
            turn: 1,
            usage: {},
            status: 'completed',
          }),
        ],
      });
      fake.finish({ finalResponse: 'ok', usage: {} });
      await flushMicrotasks();

      const finished = parseLine(
        lines.find((l) => l.includes('turn finished')) ?? '',
      );
      expect(finished.level).toBe('INFO');
      expect(finished.fields).toMatchObject({
        conversationId,
        status: 'completed',
      });
      expect(typeof finished.fields.durationMs).toBe('number');
    });

    it('"turn finished" has no status field at all when no message-metadata chunk was ever observed (theoretical — every real turn produces exactly one)', async () => {
      const { lines, logger } = collectingLogger();
      const fake = createControllableSession();
      startTurn({
        db,
        conversationId,
        session: fake,
        text: 'hi',
        priorMessageCount: 0,
        logger,
      });

      fake.pushChunk(startChunk('m1'));
      await flushMicrotasks();
      fake.finish({ finalResponse: 'ok', usage: {} });
      await flushMicrotasks();

      const finished = parseLine(
        lines.find((l) => l.includes('turn finished')) ?? '',
      );
      expect('status' in finished.fields).toBe(false);
    });

    it('logs "turn threw unexpectedly" (ERROR) with the error message and durationMs on the genuine-throw path', async () => {
      const { lines, logger } = collectingLogger();
      const fake = createControllableSession();
      startTurn({
        db,
        conversationId,
        session: fake,
        text: 'hi',
        priorMessageCount: 0,
        logger,
      });

      fake.pushChunk(
        toolInputAvailableChunk('call_1', 'bash', { command: 'ls' }),
      );
      await flushMicrotasks();
      fake.fail(new Error('provider exploded'));
      await flushMicrotasks();

      const thrown = parseLine(
        lines.find((l) => l.includes('turn threw unexpectedly')) ?? '',
      );
      expect(thrown.level).toBe('ERROR');
      expect(thrown.fields).toMatchObject({
        conversationId,
        error: 'provider exploded',
      });
      expect(typeof thrown.fields.durationMs).toBe('number');
    });

    it('logs "turn persistence finalized" (DEBUG) with the count of newly-appended messages, only on the graceful-finish path', async () => {
      const { lines, logger } = collectingLogger();
      const fake = createControllableSession();
      startTurn({
        db,
        conversationId,
        session: fake,
        text: 'hi',
        priorMessageCount: 0,
        logger,
      });

      fake.setState({
        id: 'nimbo-sess-1',
        turn: 1,
        createdAt: 1000,
        messages: [
          userTextMessage('u1', 'hi'),
          assistantTextMessage('m1', 'ok', {
            turn: 1,
            usage: {},
            status: 'completed',
          }),
        ],
      });
      fake.finish({ finalResponse: 'ok', usage: {} });
      await flushMicrotasks();

      const finalized = parseLine(
        lines.find((l) => l.includes('turn persistence finalized')) ?? '',
      );
      expect(finalized.level).toBe('DEBUG');
      expect(finalized.fields).toMatchObject({
        conversationId,
        messageCount: 1,
      }); // just the assistant message — the user message was already counted via priorMessageCount + 1
    });

    it('startTurn without a logger option uses the default singleton (writes to process.stdout) — the 158-strong pre-existing suite already exercises this path with no regressions', async () => {
      const spy = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);
      try {
        const fake = createControllableSession();
        startTurn({
          db,
          conversationId,
          session: fake,
          text: 'hi',
          priorMessageCount: 0,
        }); // no logger
        expect(spy).toHaveBeenCalled();
        expect(
          spy.mock.calls.some((call) =>
            String(call[0]).includes('turn started'),
          ),
        ).toBe(true);
        fake.finish({ finalResponse: 'ok', usage: {} });
        await flushMicrotasks();
      } finally {
        spy.mockRestore();
      }
    });

    it('the logging tap changes nothing about persistence: conversation_events shape (kind/type sequence) is identical whether or not a logger is injected, for the exact same chunk sequence', async () => {
      const withoutLoggerSessionId = conversationId;
      const withLoggerSessionId = randomUUID();
      createConversation(db, {
        id: withLoggerSessionId,
        userId: 'user-1',
        title: 'Session 2',
        repo: 'acme/demo',
        branchName: `nimbo/chat-${withLoggerSessionId}`,
        sandboxName: `nimbo-chat-${withLoggerSessionId}`,
      });

      function driveIdenticalTurn(
        id: string,
        logger?: ReturnType<typeof createLogger>,
      ): ControllableSessionLike {
        const fake = createControllableSession();
        startTurn({
          db,
          conversationId: id,
          session: fake,
          text: 'same input',
          priorMessageCount: 0,
          logger,
        });
        return fake;
      }

      type ControllableSessionLike = ReturnType<
        typeof createControllableSession
      >;

      const without = driveIdenticalTurn(withoutLoggerSessionId);
      without.pushChunk(startChunk('m1'));
      without.pushChunk(
        toolInputAvailableChunk('call_1', 'bash', { command: 'ls' }),
      );
      await flushMicrotasks();
      without.pushChunk(dataToolTimingChunk('call_1', 1000));
      without.pushChunk(toolOutputAvailableChunk('call_1', 'ok'));
      without.pushChunk(dataToolTimingChunk('call_1', 1000, 1100));
      await flushMicrotasks();
      without.setState({
        id: 'nimbo-a',
        turn: 1,
        createdAt: 1000,
        messages: [
          userTextMessage('u1', 'same input'),
          assistantTextMessage('m1', 'ok', {
            turn: 1,
            usage: {},
            status: 'completed',
          }),
        ],
      });
      without.finish({ finalResponse: 'ok', usage: {} });
      await flushMicrotasks();

      const { logger: withLoggerInstance } = collectingLogger();
      const withLogger = driveIdenticalTurn(
        withLoggerSessionId,
        withLoggerInstance,
      );
      withLogger.pushChunk(startChunk('m1'));
      withLogger.pushChunk(
        toolInputAvailableChunk('call_1', 'bash', { command: 'ls' }),
      );
      await flushMicrotasks();
      withLogger.pushChunk(dataToolTimingChunk('call_1', 1000));
      withLogger.pushChunk(toolOutputAvailableChunk('call_1', 'ok'));
      withLogger.pushChunk(dataToolTimingChunk('call_1', 1000, 1100));
      await flushMicrotasks();
      withLogger.setState({
        id: 'nimbo-b',
        turn: 1,
        createdAt: 1000,
        messages: [
          userTextMessage('u1', 'same input'),
          assistantTextMessage('m1', 'ok', {
            turn: 1,
            usage: {},
            status: 'completed',
          }),
        ],
      });
      withLogger.finish({ finalResponse: 'ok', usage: {} });
      await flushMicrotasks();

      // The turn-start user message's own `id` (`driveTurn`'s `randomUUID()`) is
      // the only thing that necessarily differs between two independent runs —
      // normalize it away (a plain string replace, not a JSON-shape assertion)
      // before comparing, same spirit as `@nimbo/core`'s own `fingerprintMessage`
      // dropping random ids for structural-equivalence comparisons.
      const shapeOf = (rows: ConversationEventRow[]) =>
        rows.map((r) => ({
          kind: r.kind,
          payloadJson: r.payloadJson.replace(
            /"id":"[0-9a-fA-F-]{36}"/g,
            '"id":"<rand>"',
          ),
        }));
      expect(shapeOf(listConversationEvents(db, withLoggerSessionId))).toEqual(
        shapeOf(listConversationEvents(db, withoutLoggerSessionId)),
      );
    });
  });
});
