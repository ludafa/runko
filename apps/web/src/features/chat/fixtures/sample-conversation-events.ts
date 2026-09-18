/**
 * 整段对话的 `LedgerFrame[]` 样例（docs/logic/orchestration/tech/single-ledger.md §5/§6），
 * 用 `../__tests__/helpers/runko-chunks` 里的工厂函数拼出来。
 *
 * 覆盖四种场景：docs/logic/orchestration/tech/single-ledger.md §6 定义的两种人在回路形态
 * （需要 `review` 的受控工具调用、一次 `ask-user` 提问），外加一轮纯文本、以及一段已经
 * GC 过的回放。`timeline-view.test.tsx` 与 `timeline.test.ts` 直接拿这些拼渲染/物化断言，
 * 不必每个用例自己从零手搓一串 chunk。
 *
 * 下面每串 chunk 的顺序都与 `@runko/core` 的 `loop.ts`（`runOneStep`/`settleToolCall`/
 * `finalizeTurn`）实际产出的顺序一致：`finish-step` 在工具结算之前、`finish` 要等所有
 * 挂起的工具调用都结算完、收尾的 `message-metadata` 是最后一个 step 的 `finish` 之后
 * 一条独立 chunk。每条顺序选择的理由见 `loop.ts` 自己的注释。
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
} from '../__tests__/helpers/runko-chunks';
import type { LedgerFrame } from '../schema';

function maxSeq(frames: readonly LedgerFrame[]): number {
  return frames.reduce(
    (max, frame) => (frame.seq !== undefined ? Math.max(max, frame.seq) : max),
    0,
  );
}

/** 形态 1：纯文本一轮，没有工具调用——最简单的形状，一个 step，`finishReason: 'stop'`。 */
export const plainTextTurnFrames: LedgerFrame[] = toChunkEnvelopes([
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
 * 形态 2：一次需要人工 `review` 的受控 `bash` 调用（docs/10 §6.1）。
 *
 * 第一个 step 里同时带一段开场文本**和**这次工具调用，人批准后工具执行；第二个 step
 * 用一段收尾文本结束。轮的 metadata 落在第二条（也就是最后一条）assistant 消息上。
 */
export const approvalTurnFrames: LedgerFrame[] = toChunkEnvelopes([
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
 * 形态 3：一次 `ask-user` 提问，分两批帧。
 *
 * 第一批是「还在等」：没有答案，消息也没有 `finish` 就一直开着——`settleExecution`
 * 还在 `await` 工具自己的 `execute()`，而它阻塞在人的回答上。
 *
 * 人回答之后，收尾那一半作为**后到的另一批**帧出现（`askUserAnsweredFrames`，`seq`
 * 接着 `askUserPendingFrames` 的最后一个往下排），对应真实情况下答案要在「等待中」
 * 状态被看到之后好一会儿才经 tail 到达（docs/logic/orchestration/tech/single-ledger.md §6，
 * 以及 `QuestionCard` 的等待/已回答两态）。
 */
export const askUserPendingFrames: LedgerFrame[] = toChunkEnvelopes([
  startChunk('msg-4'),
  startStepChunk(),
  toolInputAvailableChunk('call-ask-1', 'ask-user', {
    question: '用哪个颜色主题？',
    options: ['浅色', '深色'],
  }),
  finishStepChunk(),
]);

export const askUserAnsweredFrames: LedgerFrame[] = toChunkEnvelopes(
  [
    toolOutputAvailableChunk('call-ask-1', '深色'),
    finishChunk('stop'),
    turnEndChunk({ turn: 1, usage: { totalTokens: 64 }, status: 'completed' }),
  ],
  maxSeq(askUserPendingFrames),
);

export const askUserTurnFrames: LedgerFrame[] = [
  ...askUserPendingFrames,
  ...askUserAnsweredFrames,
];

/**
 * 一轮已经结束的回放，GC 之后只剩 `MessageFrame`。
 *
 * `apps/node-server` 的 `turn-runner/persistence.ts` 只把一轮的可持久 chunk 留到
 * `finalizeTurnPersistence` 把它们 GC 掉为止，所以回放出来的历史就是一条条已完成消息
 * 的原文。回放里的 `MessageFrame` 不走 chunk 物化，下面这些是直接手写好的已完成
 * `RunkoUIMessage`。
 */
export const gcdReplayFrames: LedgerFrame[] = [
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
