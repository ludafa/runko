/**
 * Rebuilt for the P13-5-4/P13-5-5 UIMessage-ledger migration (docs/tech/single-ledger.md §5/§6) — this fixture used to record a
 * `ChatStreamEnvelope[]` run against the retired `SessionEvent`/`SessionItem`
 * wire (see git history); it now exports full-conversation `ChatReplayFrame[]`
 * scenarios built from `../__tests__/helpers/nimbo-chunks`'s factories,
 * covering the two human-in-the-loop interaction shapes docs/tech/single-ledger.md §6 defines
 * (a gated tool call that needs `review`, and an `ask-user` question) plus a
 * plain text-only turn and an already-GC'd replay — `timeline-view.test.tsx`/
 * `timeline.test.ts` compose these into render/materialization assertions
 * instead of each test hand-rolling its own chunk sequence from scratch. Every
 * chunk sequence below follows the exact ordering `@nimbo/core`'s `loop.ts`
 * (`runOneStep`/`settleToolCall`/`finalizeTurn`) actually yields — see that
 * file's own doc comments for the rationale of each ordering choice mirrored
 * here (`finish-step` before tool settlement, `finish` only after every
 * pending tool call has settled, turn-end `message-metadata` as its own
 * standalone chunk after the last step's `finish`).
 */
import {
  assistantMessage,
  finishChunk,
  finishStepChunk,
  messageFrame,
  startChunk,
  startStepChunk,
  textDeltaChunk,
  textEndChunk,
  textStartChunk,
  toChunkEnvelopes,
  toolApprovalRequestChunk,
  toolApprovalResponseChunk,
  toolInputAvailableChunk,
  toolOutputAvailableChunk,
  turnEndChunk,
  userMessage,
} from '../__tests__/helpers/nimbo-chunks';
import type { ChatReplayFrame } from '../schema';

function maxSeq(frames: readonly ChatReplayFrame[]): number {
  return frames.reduce(
    (max, frame) => (frame.seq !== undefined ? Math.max(max, frame.seq) : max),
    0,
  );
}

/**
 * Interaction 1: a plain text-only turn, no tool calls — the simplest shape,
 * one step, `finishReason: 'stop'`.
 */
export const plainTextTurnFrames: ChatReplayFrame[] = toChunkEnvelopes([
  startChunk('msg-1'),
  startStepChunk(),
  textStartChunk('msg-1-text'),
  textDeltaChunk('msg-1-text', '你好，'),
  textDeltaChunk('msg-1-text', '有什么可以帮你？'),
  textEndChunk('msg-1-text'),
  finishStepChunk(),
  finishChunk('stop'),
  turnEndChunk({ turn: 1, usage: { totalTokens: 42 }, status: 'completed' }),
]);

/**
 * Interaction 2: a gated `bash` tool call that needs human `review` (docs/10
 * §6.1) — one step carries a leading text part *and* the tool call, gets
 * approved, tool executes, then a second step wraps up with closing text.
 * Turn metadata lands on the second (last) assistant message.
 */
export const approvalTurnFrames: ChatReplayFrame[] = toChunkEnvelopes([
  startChunk('msg-2'),
  startStepChunk(),
  textStartChunk('msg-2-text'),
  textDeltaChunk('msg-2-text', '我需要先跑一下测试。'),
  textEndChunk('msg-2-text'),
  toolInputAvailableChunk('call-bash-1', 'bash', { command: 'pnpm test' }),
  finishStepChunk(),
  toolApprovalRequestChunk('call-bash-1'),
  toolApprovalResponseChunk('call-bash-1', true),
  toolOutputAvailableChunk('call-bash-1', { exitCode: 0, stdout: 'PASS' }),
  finishChunk('tool-calls'),
  startChunk('msg-3'),
  startStepChunk(),
  textStartChunk('msg-3-text'),
  textDeltaChunk('msg-3-text', '测试全部通过。'),
  textEndChunk('msg-3-text'),
  finishStepChunk(),
  finishChunk('stop'),
  turnEndChunk({ turn: 1, usage: { totalTokens: 128 }, status: 'completed' }),
]);

/**
 * Interaction 3: an `ask-user` question — pending (no answer yet, message
 * stays open with no `finish`, since `settleExecution` is still `await`ing
 * the tool's own `execute()`, which blocks on the human's answer) then, after
 * the human answers, the resolving half arrives as its own later batch of
 * frames (`askUserAnsweredFrames`, `seq` continuing from
 * `askUserPendingFrames`'s last one) — mirroring how a real answer arrives
 * over the tail well after the pending state was first seen (docs/tech/single-ledger.md §6,
 * `QuestionCard`'s pending/answered states).
 */
export const askUserPendingFrames: ChatReplayFrame[] = toChunkEnvelopes([
  startChunk('msg-4'),
  startStepChunk(),
  toolInputAvailableChunk('call-ask-1', 'ask-user', {
    question: '用哪个颜色主题？',
    options: ['浅色', '深色'],
  }),
  finishStepChunk(),
]);

export const askUserAnsweredFrames: ChatReplayFrame[] = toChunkEnvelopes(
  [
    toolOutputAvailableChunk('call-ask-1', '深色'),
    finishChunk('stop'),
    turnEndChunk({ turn: 1, usage: { totalTokens: 64 }, status: 'completed' }),
  ],
  maxSeq(askUserPendingFrames),
);

export const askUserTurnFrames: ChatReplayFrame[] = [
  ...askUserPendingFrames,
  ...askUserAnsweredFrames,
];

/**
 * An already-finished turn's replay, GC'd down to `MessageFrame`s only
 * (`apps/node-server`'s `turn-runner.ts` only keeps a finished turn's durable
 * chunks around until `finalizeTurnPersistence` GCs them — replay history
 * ends up as finished messages verbatim, `use-chat-messages.ts`'s
 * `lastFrameIsChunk` doc comment). A `MessageFrame` never goes through chunk
 * materialization on replay — these are hand-assembled already-finished
 * `NimboUIMessage`s directly.
 */
export const gcdReplayFrames: ChatReplayFrame[] = [
  messageFrame(1, userMessage('msg-5-user', '现在几点了？')),
  messageFrame(
    2,
    assistantMessage(
      'msg-5',
      [
        { type: 'step-start' },
        { type: 'text', text: '现在是下午三点。', state: 'done' },
      ],
      { turn: 1, usage: { totalTokens: 12 }, status: 'completed' },
    ),
  ),
];
