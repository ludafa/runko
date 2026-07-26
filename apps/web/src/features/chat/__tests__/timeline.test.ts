import type { NimboUIMessage } from '@nimbo/core';
import { describe, expect, it } from 'vitest';

import {
  approvalTurnFrames,
  askUserAnsweredFrames,
  askUserPendingFrames,
  askUserTurnFrames,
  plainTextTurnFrames,
} from '../fixtures/sample-conversation-events';
import { MessageLedger } from '../materialize';
import type { LedgerFrame } from '../schema';
import {
  askUserInputFrom,
  bashCommandFromInput,
  buildRenderEntries,
  findToolTiming,
  formatClockTime,
  formatDuration,
  isNimboToolPart,
  prettyJson,
  summarizeJson,
  toolPartName,
} from '../timeline';
import {
  assistantMessage,
  collectText,
  dataFileChangeChunk,
  dataToolProgressChunk,
  dataToolTimingChunk,
  finishChunk,
  finishStepChunk,
  flushLedger,
  messageMetadataChunk,
  startChunk,
  startStepChunk,
  steerTextMessageChunks,
  textDeltaChunk,
  textEndChunk,
  textStartChunk,
  toChunkEnvelopes,
  toolInputAvailableChunk,
  toolOutputAvailableChunk,
  toolPartById,
  userMessage,
} from './helpers/nimbo-chunks';

function collectLedger(): {
  ledger: MessageLedger;
  latest: () => NimboUIMessage[];
  turnEndCount: () => number;
  userMessageCount: () => number;
} {
  let latest: NimboUIMessage[] = [];
  let turnEndCount = 0;
  let userMessageCount = 0;
  const ledger = new MessageLedger(
    (messages) => {
      latest = messages;
    },
    () => {
      turnEndCount += 1;
    },
    () => {
      userMessageCount += 1;
    },
  );
  return {
    ledger,
    latest: () => latest,
    turnEndCount: () => turnEndCount,
    userMessageCount: () => userMessageCount,
  };
}

async function applyAllLive(
  ledger: MessageLedger,
  frames: readonly LedgerFrame[],
): Promise<void> {
  for (const frame of frames) {
    ledger.applyFrame(frame);

    await flushLedger(1);
  }
}

describe('MessageLedger (materialize.ts)', () => {
  it('materializes a single-step text turn into one assistant message, with turn metadata attached', async () => {
    // Frame-by-frame with a tick between each ("直播") — see the dedicated
    // "bulk vs live" tests below for the bulk/synchronous ("回放") case,
    // which hits a real materialize.ts defect (reported separately) that
    // would otherwise contaminate this test's actual point (metadata
    // attachment) with an unrelated timing bug.
    const { ledger, latest } = collectLedger();
    await applyAllLive(ledger, plainTextTurnFrames);
    await flushLedger();

    const messages = latest();
    expect(messages).toHaveLength(1);
    const [message] = messages;
    expect(message?.role).toBe('assistant');
    expect(collectText(message)).toBe('你好，有什么可以帮你？');
    expect(message?.metadata?.status).toBe('completed');
    expect(message?.metadata?.usage).toEqual({ totalTokens: 42 });
  });

  it('a one-turn, two-step conversation (gated tool call + wrap-up text) materializes into two separate assistant messages, not merged', async () => {
    const { ledger, latest } = collectLedger();
    await applyAllLive(ledger, approvalTurnFrames);
    await flushLedger();

    const messages = latest();
    expect(messages).toHaveLength(2);
    const [first, second] = messages;
    expect(first?.id).toBe('msg-2');
    expect(second?.id).toBe('msg-3');
    expect(first?.id).not.toBe(second?.id);

    expect(collectText(first)).toBe('我需要先跑一下测试。');
    const toolPart = toolPartById(first as NimboUIMessage, 'call-bash-1');
    expect(toolPart?.state).toBe('output-available');
    expect(collectText(second)).toBe('测试全部通过。');

    // Turn-end metadata lands only on the *last* assistant message, not the first.
    expect(first?.metadata?.status).toBeUndefined();
    expect(second?.metadata?.status).toBe('completed');
  });

  it('a gated tool call goes through approval-requested → approval-responded(allowed) → output-available, in order', async () => {
    const { ledger, latest } = collectLedger();
    for (const frame of approvalTurnFrames.slice(0, 8))
      ledger.applyFrame(frame); // up through tool-approval-request only
    await flushLedger();

    const pending = toolPartById(latest()[0] as NimboUIMessage, 'call-bash-1');
    expect(pending?.state).toBe('approval-requested');
    expect(pending?.state === 'approval-requested' && pending.approval.id).toBe(
      'call-bash-1',
    );

    for (const frame of approvalTurnFrames.slice(8)) ledger.applyFrame(frame);
    await flushLedger();

    const resolved = toolPartById(latest()[0] as NimboUIMessage, 'call-bash-1');
    expect(resolved?.state).toBe('output-available');
  });

  it('a denied gated tool call ends in output-denied with the deny reason on the approval field', async () => {
    const { ledger, latest } = collectLedger();
    const chunks = [
      startChunk('msg-x'),
      startStepChunk(),
      toolInputAvailableChunk('call-x', 'bash', { command: 'rm -rf /' }),
      finishStepChunk(),
    ];
    for (const frame of toChunkEnvelopes(chunks)) ledger.applyFrame(frame);
    await flushLedger();

    // deny path: approval-request → approval-response(denied) → output-denied
    const denyChunks = toChunkEnvelopes(
      [
        {
          type: 'tool-approval-request',
          approvalId: 'call-x',
          toolCallId: 'call-x',
        },
        {
          type: 'tool-approval-response',
          approvalId: 'call-x',
          approved: false,
          reason: '太危险了',
        },
        { type: 'tool-output-denied', toolCallId: 'call-x' },
        finishChunk('tool-calls'),
      ],
      9,
    );
    for (const frame of denyChunks) ledger.applyFrame(frame);
    await flushLedger();

    const part = toolPartById(latest()[0] as NimboUIMessage, 'call-x');
    expect(part?.state).toBe('output-denied');
    expect(part?.state === 'output-denied' && part.approval.reason).toBe(
      '太危险了',
    );
  });

  it('an ask-user tool call stays pending (input-available, no finish yet) until answered, then resolves to output-available', async () => {
    const { ledger, latest } = collectLedger();
    for (const frame of askUserPendingFrames) ledger.applyFrame(frame);
    await flushLedger();

    const pendingMessages = latest();
    expect(pendingMessages).toHaveLength(1);
    const pendingPart = toolPartById(
      pendingMessages[0] as NimboUIMessage,
      'call-ask-1',
    );
    expect(pendingPart?.state).toBe('input-available');

    for (const frame of askUserAnsweredFrames) ledger.applyFrame(frame);
    await flushLedger();

    const answeredPart = toolPartById(
      latest()[0] as NimboUIMessage,
      'call-ask-1',
    );
    expect(answeredPart?.state).toBe('output-available');
    expect(
      answeredPart?.state === 'output-available' && answeredPart.output,
    ).toBe('深色');
  });

  it('a steer-injected user message materializes with role=user and metadata.steered=true (not forced to assistant)', () => {
    const { ledger, latest } = collectLedger();
    const chunks = steerTextMessageChunks({
      messageId: 'steer-1',
      text: '等一下，改用暗色主题',
    });
    for (const frame of toChunkEnvelopes(chunks)) ledger.applyFrame(frame);

    // The steer path is fully synchronous (see materialize.ts's file header) — no flush needed.
    const messages = latest();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
    expect(messages[0]?.metadata?.steered).toBe(true);
    expect(collectText(messages[0])).toBe('等一下，改用暗色主题');
  });

  it('a steer message does not become the ledger\'s "last assistant" — a later standalone message-metadata still merges onto the real prior assistant message', async () => {
    const { ledger, latest } = collectLedger();
    for (const frame of toChunkEnvelopes([
      startChunk('asst-1'),
      startStepChunk(),
      textStartChunk('t'),
      textDeltaChunk('t', '好的'),
      textEndChunk('t'),
      finishStepChunk(),
      finishChunk('stop'),
    ]))
      ledger.applyFrame(frame);
    await flushLedger();

    for (const frame of toChunkEnvelopes(
      steerTextMessageChunks({ messageId: 'steer-2', text: '再加一句' }),
      10,
    ))
      ledger.applyFrame(frame);

    ledger.applyFrame({
      seq: 20,
      chunk: messageMetadataChunk({ turn: 1, usage: {}, status: 'completed' }),
    });

    const messages = latest();
    expect(messages).toHaveLength(2);
    const assistantMessage = messages.find((m) => m.role === 'assistant');
    expect(assistantMessage?.id).toBe('asst-1');
    expect(assistantMessage?.metadata?.status).toBe('completed');
  });

  it('a standalone message-metadata with no prior assistant message synthesizes a placeholder ("turn signal") message, and onTurnEnd fires exactly once', () => {
    const { ledger, latest, turnEndCount } = collectLedger();
    ledger.applyFrame({
      seq: 1,
      chunk: messageMetadataChunk({
        turn: 1,
        usage: {},
        status: 'failed',
        error: { code: 'context_overflow', message: 'too much context' },
      }),
    });

    const messages = latest();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('assistant');
    expect(messages[0]?.parts).toEqual([]);
    expect(messages[0]?.id.startsWith('turn-signal-')).toBe(true);
    expect(messages[0]?.metadata?.status).toBe('failed');
    expect(turnEndCount()).toBe(1);
  });

  it('transient data-tool-progress chunks never reach message.parts', async () => {
    const { ledger, latest } = collectLedger();
    const chunks = [
      startChunk('msg-p'),
      startStepChunk(),
      toolInputAvailableChunk('call-p', 'bash', { command: 'pnpm build' }),
      finishStepChunk(),
      dataToolProgressChunk('call-p', 'building...'),
      dataToolProgressChunk('call-p', 'building... 50%'),
      toolOutputAvailableChunk('call-p', { exitCode: 0 }),
      finishChunk('tool-calls'),
    ];
    for (const frame of toChunkEnvelopes(chunks)) ledger.applyFrame(frame);
    await flushLedger();

    const message = latest()[0] as NimboUIMessage;
    const progressParts = message.parts.filter(
      (part) => part.type === 'data-tool-progress',
    );
    expect(progressParts).toEqual([]);
    // sanity: the tool call itself did materialize (the transient chunk being dropped isn't just "everything dropped")
    expect(toolPartById(message, 'call-p')?.state).toBe('output-available');
  });

  it('a non-transient data part (data-file-change) does reach message.parts', async () => {
    const { ledger, latest } = collectLedger();
    const chunks = [
      startChunk('msg-fc'),
      startStepChunk(),
      toolInputAvailableChunk('call-fc', 'write-file', { path: 'a.txt' }),
      finishStepChunk(),
      toolOutputAvailableChunk('call-fc', 'ok'),
      dataFileChangeChunk('fc-1', {
        changes: [{ path: 'a.txt', kind: 'add' }],
      }),
      finishChunk('tool-calls'),
    ];
    for (const frame of toChunkEnvelopes(chunks)) ledger.applyFrame(frame);
    await flushLedger();

    const message = latest()[0] as NimboUIMessage;
    const fileChangeParts = message.parts.filter(
      (part) => part.type === 'data-file-change',
    );
    expect(fileChangeParts).toHaveLength(1);
  });

  it('a data-tool-timing part (chat 可观测性：工具起止时间戳) is persistent — like data-file-change, unlike the transient data-tool-progress above — and upserts by toolCallId as its two updates (start, then complete) arrive', async () => {
    const { ledger, latest } = collectLedger();
    const chunks = [
      startChunk('msg-timing'),
      startStepChunk(),
      toolInputAvailableChunk('call-timing', 'bash', { command: 'ls' }),
      dataToolTimingChunk('call-timing', 1_700_000_000_000), // start half — startedAt only
      finishStepChunk(),
      toolOutputAvailableChunk('call-timing', { exitCode: 0 }),
      dataToolTimingChunk('call-timing', 1_700_000_000_000, 1_700_000_000_800), // complete half
      finishChunk('tool-calls'),
    ];
    for (const frame of toChunkEnvelopes(chunks)) ledger.applyFrame(frame);
    await flushLedger();

    const message = latest()[0] as NimboUIMessage;
    const timingParts = message.parts.filter(
      (part) => part.type === 'data-tool-timing',
    );
    // upsert by toolCallId — exactly one part in the ledger, not two.
    expect(timingParts).toHaveLength(1);
    expect(findToolTiming(message, 'call-timing')).toEqual({
      toolCallId: 'call-timing',
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_000_800,
    });
  });

  it('BUG (see report): bulk/synchronous frame application ("回放") and one-at-a-time frame application with awaits between ("直播") must materialize the same final NimboUIMessage[] for the same crashed-turn frame sequence', async () => {
    const crashedTurnFrames = toChunkEnvelopes([
      startChunk('crashed-1'),
      startStepChunk(),
      textStartChunk('ct'),
      textDeltaChunk('ct', 'partial answer before crash'),
      textEndChunk('ct'),
      finishStepChunk(),
      finishChunk('stop'),
      messageMetadataChunk({
        turn: 1,
        usage: {},
        status: 'failed',
        error: { code: 'provider_error', message: 'boom' },
      }),
    ]);

    // "回放": apps/web/src/features/chat/use-chat-messages.ts's mount effect
    // applies `initialFrames` in exactly this shape — a plain synchronous
    // `for` loop with no `await` between frames.
    const replay = collectLedger();
    for (const frame of crashedTurnFrames) replay.ledger.applyFrame(frame);
    await flushLedger();

    // "直播": the same frames, arriving one at a time with a real tick
    // between each (the live SSE tail's natural delivery cadence).
    const live = collectLedger();
    await applyAllLive(live.ledger, crashedTurnFrames);
    await flushLedger();

    expect(replay.latest()).toEqual(live.latest());
  });
});

describe('MessageLedger onUserMessage (this ticket’s fix — the FIFO-pop signal use-chat-messages.ts relies on)', () => {
  it('fires exactly once when a role="user" MessageFrame is applied', () => {
    const { ledger, userMessageCount } = collectLedger();
    ledger.applyFrame({ seq: 1, message: userMessage('u1', '你好') });
    expect(userMessageCount()).toBe(1);
  });

  it('fires once per role="user" MessageFrame, not just the first one ever seen', () => {
    const { ledger, userMessageCount } = collectLedger();
    ledger.applyFrame({ seq: 1, message: userMessage('u1', '第一条') });
    ledger.applyFrame({ seq: 2, message: userMessage('u2', '第二条') });
    expect(userMessageCount()).toBe(2);
  });

  it('does NOT fire for a steer-injected user message’s own chunk sequence (start/text-*/finish) — a steer message never produces a turn-start MessageFrame, only onUserMessage’s dedicated signal does', () => {
    const { ledger, userMessageCount } = collectLedger();
    const chunks = steerTextMessageChunks({
      messageId: 'steer-1',
      text: '插一句',
    });
    for (const frame of toChunkEnvelopes(chunks)) ledger.applyFrame(frame);
    expect(userMessageCount()).toBe(0);
  });

  it('does NOT fire when an assistant MessageFrame is applied', () => {
    const { ledger, userMessageCount } = collectLedger();
    ledger.applyFrame({
      seq: 1,
      message: assistantMessage('a1', [
        { type: 'text', text: 'hi', state: 'done' },
      ]),
    });
    expect(userMessageCount()).toBe(0);
  });
});

describe('buildRenderEntries', () => {
  const messages: NimboUIMessage[] = [
    { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
    { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'hello' }] },
  ];

  it('with no pending echoes, returns messages verbatim in order', () => {
    const entries = buildRenderEntries(messages, []);
    expect(entries).toEqual([
      { kind: 'message', message: messages[0] },
      { kind: 'message', message: messages[1] },
    ]);
  });

  it('inserts a pending echo at its afterMessageCount anchor', () => {
    const echo = { id: 1, text: '在吗', afterMessageCount: 1 };
    const entries = buildRenderEntries(messages, [echo]);
    expect(entries).toEqual([
      { kind: 'message', message: messages[0] },
      { kind: 'pending-echo', echo },
      { kind: 'message', message: messages[1] },
    ]);
  });

  it('inserts multiple echoes at different anchors in the correct final order', () => {
    const echoA = { id: 1, text: '第一条', afterMessageCount: 0 };
    const echoB = { id: 2, text: '第二条', afterMessageCount: 2 };
    const entries = buildRenderEntries(messages, [echoA, echoB]);
    expect(
      entries.map((e) =>
        e.kind === 'pending-echo' ? e.echo.text : e.message.id,
      ),
    ).toEqual(['第一条', 'm1', 'm2', '第二条']);
  });

  it('two echoes sharing the same afterMessageCount anchor render in send (ascending-id) order, never reversed, regardless of the order they’re passed in — this is a precise repro of the original "连发两条消息乱序" bug (two same-anchor echoes ending up swapped)', () => {
    const echoSentFirst = { id: 1, text: '第一条', afterMessageCount: 0 };
    const echoSentSecond = { id: 2, text: '第二条', afterMessageCount: 0 };
    const expected = [
      { kind: 'message', message: messages[0] },
      { kind: 'message', message: messages[1] },
    ];
    // Splicing at the shared anchor 0 pushes both echoes ahead of `messages`
    // — send order (ascending id) means echoSentFirst must land before
    // echoSentSecond, whichever order the caller happened to pass them in.
    expect(
      buildRenderEntries(messages, [echoSentFirst, echoSentSecond]),
    ).toEqual([
      { kind: 'pending-echo', echo: echoSentFirst },
      { kind: 'pending-echo', echo: echoSentSecond },
      ...expected,
    ]);
    expect(
      buildRenderEntries(messages, [echoSentSecond, echoSentFirst]),
    ).toEqual([
      { kind: 'pending-echo', echo: echoSentFirst },
      { kind: 'pending-echo', echo: echoSentSecond },
      ...expected,
    ]);
  });

  it('clamps an anchor beyond the current message count to the end (a later turn appended past where an earlier echo anchored)', () => {
    const echo = { id: 1, text: '旧回显', afterMessageCount: 99 };
    const entries = buildRenderEntries(messages, [echo]);
    expect(entries.at(-1)).toEqual({ kind: 'pending-echo', echo });
  });

  it('an empty message list with a pending echo still renders the echo', () => {
    const echo = { id: 1, text: '第一条消息', afterMessageCount: 0 };
    const entries = buildRenderEntries([], [echo]);
    expect(entries).toEqual([{ kind: 'pending-echo', echo }]);
  });
});

describe('tool-part narrowing helpers (timeline.ts)', () => {
  it('isNimboToolPart accepts a tool-<name> part and rejects step-start/data-* parts', async () => {
    const { ledger, latest } = collectLedger();
    await applyAllLive(ledger, approvalTurnFrames);
    await flushLedger();

    const message = latest()[0] as NimboUIMessage;
    const toolParts = message.parts.filter(isNimboToolPart);
    expect(toolParts).toHaveLength(1);
    expect(message.parts.some((p) => p.type === 'step-start')).toBe(true);
    expect(toolParts.some((p) => isNimboToolPart(p))).toBe(true);
    const nonToolParts = message.parts.filter((p) => !isNimboToolPart(p));
    expect(nonToolParts.every((p) => !p.type.startsWith('tool-'))).toBe(true);
  });

  it('toolPartName extracts the tool name from a tool-<name> part', async () => {
    const { ledger, latest } = collectLedger();
    await applyAllLive(ledger, approvalTurnFrames);
    await flushLedger();
    const part = toolPartById(latest()[0] as NimboUIMessage, 'call-bash-1');
    expect(part).toBeDefined();
    if (part === undefined) return;
    expect(toolPartName(part)).toBe('bash');
  });

  it('bashCommandFromInput extracts { command } from a well-formed input', () => {
    expect(bashCommandFromInput({ command: 'ls -la' })).toBe('ls -la');
  });

  it('bashCommandFromInput returns undefined for input missing "command"', () => {
    expect(bashCommandFromInput({ timeout_ms: 500 })).toBeUndefined();
  });

  it('bashCommandFromInput returns undefined for non-object input (array/null/primitive)', () => {
    expect(bashCommandFromInput(['ls'])).toBeUndefined();
    expect(bashCommandFromInput(null)).toBeUndefined();
    expect(bashCommandFromInput('ls')).toBeUndefined();
  });

  it('askUserInputFrom parses { question, options } and tolerates a missing options', () => {
    expect(
      askUserInputFrom({ question: '选哪个？', options: ['A', 'B'] }),
    ).toEqual({
      question: '选哪个？',
      options: ['A', 'B'],
    });
    expect(askUserInputFrom({ question: '选哪个？' })).toEqual({
      question: '选哪个？',
    });
  });

  it('askUserInputFrom returns undefined when "question" is missing (malformed input)', () => {
    expect(askUserInputFrom({ options: ['A'] })).toBeUndefined();
    expect(askUserInputFrom(null)).toBeUndefined();
    expect(askUserInputFrom('not an object')).toBeUndefined();
  });

  it('prettyJson pretty-prints a value that round-trips through the JsonValue guard', () => {
    expect(prettyJson({ a: 1 })).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  it('prettyJson falls back to null for a value that fails the JsonValue guard (e.g. containing a function)', () => {
    // functions aren't valid JsonValue — zod's safeParse fails, prettyJson's parseUnknownJsonValue falls back to null.
    const withFunction = { a: () => 1 };
    expect(prettyJson(withFunction)).toBe(JSON.stringify(null, null, 2));
  });

  it('summarizeJson leaves a short value untouched', () => {
    expect(summarizeJson({ a: 1 })).toBe(JSON.stringify({ a: 1 }));
  });

  it('summarizeJson truncates a long value at 120 chars with an ellipsis', () => {
    const long = { text: 'x'.repeat(200) };
    const summary = summarizeJson(long);
    expect(summary.endsWith('…')).toBe(true);
    expect(summary.length).toBe(121); // 120 chars + the ellipsis character
  });
});

describe('tool timing helpers (timeline.ts) — chat 可观测性：工具起止时间戳', () => {
  describe('findToolTiming', () => {
    it('finds the data-tool-timing part matching toolCallId (by id)', () => {
      const message: NimboUIMessage = {
        id: 'm1',
        role: 'assistant',
        parts: [
          { type: 'step-start' },
          {
            type: 'data-tool-timing',
            id: 'call-1',
            data: { toolCallId: 'call-1', startedAt: 1000, completedAt: 1500 },
          },
        ],
      };
      expect(findToolTiming(message, 'call-1')).toEqual({
        toolCallId: 'call-1',
        startedAt: 1000,
        completedAt: 1500,
      });
    });

    it('returns undefined when no data-tool-timing part exists at all (input still streaming, or a pre-existing message)', () => {
      const message: NimboUIMessage = {
        id: 'm1',
        role: 'assistant',
        parts: [{ type: 'step-start' }],
      };
      expect(findToolTiming(message, 'call-1')).toBeUndefined();
    });

    it('returns undefined for a non-matching toolCallId — does not cross-wire timing across different tool calls in the same message', () => {
      const message: NimboUIMessage = {
        id: 'm1',
        role: 'assistant',
        parts: [
          {
            type: 'data-tool-timing',
            id: 'call-1',
            data: { toolCallId: 'call-1', startedAt: 1000 },
          },
        ],
      };
      expect(findToolTiming(message, 'call-2')).toBeUndefined();
    });

    it('picks the right one out of several data-tool-timing parts for different calls on the same message', () => {
      const message: NimboUIMessage = {
        id: 'm1',
        role: 'assistant',
        parts: [
          {
            type: 'data-tool-timing',
            id: 'call-1',
            data: { toolCallId: 'call-1', startedAt: 1000, completedAt: 1100 },
          },
          {
            type: 'data-tool-timing',
            id: 'call-2',
            data: { toolCallId: 'call-2', startedAt: 2000, completedAt: 2200 },
          },
        ],
      };
      expect(findToolTiming(message, 'call-2')).toEqual({
        toolCallId: 'call-2',
        startedAt: 2000,
        completedAt: 2200,
      });
    });
  });

  describe('formatClockTime', () => {
    it('formats an epoch ms value as local HH:MM:SS, zero-padded', () => {
      const date = new Date(2024, 0, 1, 9, 5, 3);
      expect(formatClockTime(date.getTime())).toBe('09:05:03');
    });

    it('pads single-digit hours/minutes/seconds to two digits', () => {
      const date = new Date(2024, 0, 1, 0, 0, 0);
      expect(formatClockTime(date.getTime())).toBe('00:00:00');
    });
  });

  describe('formatDuration', () => {
    it('renders sub-second durations in ms', () => {
      expect(formatDuration(0)).toBe('0ms');
      expect(formatDuration(230)).toBe('230ms');
      expect(formatDuration(999)).toBe('999ms');
    });

    it('renders 1000ms as one decimal place of seconds', () => {
      expect(formatDuration(1000)).toBe('1.0s');
      expect(formatDuration(12345)).toBe('12.3s');
    });

    it('the 59999ms/60000ms boundary rolls over to "1m 0s" instead of the nonsensical "60.0s" (regression guard)', () => {
      expect(formatDuration(59_999)).toBe('1m 0s');
      expect(formatDuration(60_000)).toBe('1m 0s');
    });

    it('renders minute-scale durations as "Xm Ys"', () => {
      expect(formatDuration(125_000)).toBe('2m 5s');
    });

    it('clamps a negative duration (clock skew) to zero rather than rendering a negative number', () => {
      expect(formatDuration(-500)).toBe('0ms');
    });
  });
});

describe('BUG (see report): replay ("回放", bulk/synchronous applyFrame) vs live ("直播", one frame at a time) must materialize the same NimboUIMessage[] — currently they do not for any turn that ends in the standalone message-metadata chunk', () => {
  it('a plain completed turn materializes the same way whether applied all-at-once or one frame at a time', async () => {
    const replay = collectLedger();
    for (const frame of plainTextTurnFrames) replay.ledger.applyFrame(frame);
    await flushLedger();

    const live = collectLedger();
    await applyAllLive(live.ledger, plainTextTurnFrames);
    await flushLedger();

    expect(replay.latest()).toEqual(live.latest());
  });

  it('a full ask-user turn (pending → answered) materializes the same way for both feed styles', async () => {
    const replay = collectLedger();
    for (const frame of askUserTurnFrames) replay.ledger.applyFrame(frame);
    await flushLedger();

    const live = collectLedger();
    await applyAllLive(live.ledger, askUserTurnFrames);
    await flushLedger();

    expect(replay.latest()).toEqual(live.latest());
  });

  it('a tool-call turn carrying data-tool-timing start/complete updates materializes the same way for both feed styles', async () => {
    const frames = toChunkEnvelopes([
      startChunk('msg-t'),
      startStepChunk(),
      toolInputAvailableChunk('call-t', 'bash', { command: 'ls' }),
      dataToolTimingChunk('call-t', 1000),
      finishStepChunk(),
      toolOutputAvailableChunk('call-t', { exitCode: 0 }),
      dataToolTimingChunk('call-t', 1000, 1500),
      finishChunk('tool-calls'),
      messageMetadataChunk({ turn: 1, usage: {}, status: 'completed' }),
    ]);

    const replay = collectLedger();
    for (const frame of frames) replay.ledger.applyFrame(frame);
    await flushLedger();

    const live = collectLedger();
    await applyAllLive(live.ledger, frames);
    await flushLedger();

    expect(replay.latest()).toEqual(live.latest());
  });
});
