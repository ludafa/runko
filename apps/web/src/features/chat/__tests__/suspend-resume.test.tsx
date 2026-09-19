/**
 * [挂起](../../../../../../docs/terms.md)之后，前端怎么认出「还在等人」、怎么让人接着答
 * （docs/ingress/tech/chat-webapp.md §6.2）。按那一节的编号分组：
 *
 * - ① `findWaitingCallIds`：从账本推出还在等人的调用；
 * - ② 卡片与挂起提示：在等的卡片不算失效；
 * - ③ ⑤ `useChatMessages`：答完重开直播流、挂起时发消息走排队；
 * - ④ `MessageLedger`：恢复那一轮开头没有 `start` 的 chunk。
 */
import type { RunkoMessageMetadata, RunkoUIMessage } from '@runko/core';
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TimelineView } from '../components/timeline-view';
import { MessageLedger } from '../materialize';
import type { ChatReplayFrame, QueuedMessage } from '../schema';
import { findWaitingCallIds } from '../timeline';
import { useChatMessages } from '../use-chat-messages';
import { FakeChatFetch } from './helpers/fake-chat-fetch';
import {
  dataToolTimingChunk,
  finishChunk,
  flushLedger,
  messageMetadataChunk,
  startChunk,
  startStepChunk,
  textDeltaChunk,
  textEndChunk,
  textStartChunk,
  toolApprovalResponseChunk,
  toolOutputAvailableChunk,
  toolPartById,
  userMessage,
} from './helpers/runko-chunks';

type Part = RunkoUIMessage['parts'][number];

function pendingBash(callId: string): Part {
  return {
    type: 'tool-bash',
    toolCallId: callId,
    state: 'approval-requested',
    input: { command: 'git push' },
    approval: { id: callId },
  };
}

function finishedBash(callId: string): Part {
  return {
    type: 'tool-bash',
    toolCallId: callId,
    state: 'output-available',
    input: { command: 'git push' },
    output: { exitCode: 0 },
    approval: { id: callId, approved: true },
  };
}

function pendingQuestion(callId: string): Part {
  return {
    type: 'tool-ask-user',
    toolCallId: callId,
    state: 'input-available',
    input: { question: '用哪个包管理器？' },
  };
}

function suspendedMetadata(callIds: string[]): RunkoMessageMetadata {
  return {
    turn: 1,
    usage: {},
    status: 'suspended',
    suspended: { callIds, reason: 'timeout' },
  };
}

/** 挂起那一轮的最后一条消息：悬空调用都在它里面，收尾 metadata 也挂在它上面。 */
function suspendedMessage(
  parts: Part[],
  callIds: string[],
  id = 'a1',
): RunkoUIMessage {
  return {
    id,
    role: 'assistant',
    parts: [{ type: 'step-start' }, ...parts],
    metadata: suspendedMetadata(callIds),
  };
}

function queuedMessage(id: string, text: string): QueuedMessage {
  return { id, text, userId: 'user-1', createdAt: 1_700_000_000_000 };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// ① 哪些调用还在等人
// ---------------------------------------------------------------------------

describe('findWaitingCallIds（§6.2 ①）', () => {
  it('挂起那一轮里列在 suspended.callIds、还停在等人状态的调用算「在等」', () => {
    const messages = [
      userMessage('u1', '推上去'),
      suspendedMessage([pendingBash('call-x')], ['call-x']),
    ];
    expect([...findWaitingCallIds(messages)]).toEqual(['call-x']);
  });

  it('提问卡片（input-available）同样算', () => {
    const messages = [
      suspendedMessage([pendingQuestion('call-q')], ['call-q']),
    ];
    expect([...findWaitingCallIds(messages)]).toEqual(['call-q']);
  });

  // 恢复那一轮原地改写这条消息，metadata 里的 callIds 却留着——只看 metadata 会把答过的也算上。
  it('恢复改写之后部件已经有结果，metadata 里的 callIds 还在，也不算「在等」', () => {
    const messages = [suspendedMessage([finishedBash('call-x')], ['call-x'])];
    expect(findWaitingCallIds(messages).size).toBe(0);
  });

  it('没列在 suspended.callIds 里的部件不算，哪怕它看上去还悬着', () => {
    const messages = [
      suspendedMessage(
        [pendingBash('call-x'), pendingBash('call-other')],
        ['call-x'],
      ),
    ];
    expect([...findWaitingCallIds(messages)]).toEqual(['call-x']);
  });

  it('两次调用一起挂起、答完一个：只剩另一个', () => {
    const messages = [
      suspendedMessage(
        [finishedBash('call-x'), pendingBash('call-y')],
        ['call-x', 'call-y'],
      ),
    ];
    expect([...findWaitingCallIds(messages)]).toEqual(['call-y']);
  });

  it('只看最后一条收尾消息：它不是挂起，就没有在等的', () => {
    const messages: RunkoUIMessage[] = [
      suspendedMessage([pendingBash('call-x')], ['call-x']),
      {
        id: 'a2',
        role: 'assistant',
        parts: [{ type: 'text', text: '好了', state: 'done' }],
        metadata: { turn: 2, usage: {}, status: 'completed' },
      },
    ];
    expect(findWaitingCallIds(messages).size).toBe(0);
  });

  it('恢复那一轮还在跑（后面的新消息还没收尾）：仍按上一条收尾消息算', () => {
    const messages: RunkoUIMessage[] = [
      suspendedMessage(
        [finishedBash('call-x'), pendingBash('call-y')],
        ['call-x', 'call-y'],
      ),
      {
        id: 'a2',
        role: 'assistant',
        parts: [{ type: 'text', text: '接着来', state: 'streaming' }],
      },
    ];
    expect([...findWaitingCallIds(messages)]).toEqual(['call-y']);
  });

  it('没有任何收尾消息（新会话、第一轮还在跑）：空', () => {
    expect(findWaitingCallIds([userMessage('u1', 'hi')]).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ② 卡片与挂起提示
// ---------------------------------------------------------------------------

describe('TimelineView：挂起的卡片（§6.2 ②）', () => {
  it('挂起那一轮的审批卡片：轮已收尾，但在等的就不算失效，按钮都在', () => {
    const messages = [suspendedMessage([pendingBash('call-x')], ['call-x'])];
    render(
      <TimelineView
        messages={messages}
        turnInProgress={false}
        waitingCallIds={new Set(['call-x'])}
      />,
    );
    expect(screen.getByTestId('approval-card')).toHaveAttribute(
      'data-status',
      'pending',
    );
    expect(screen.getByRole('button', { name: '允许' })).toBeInTheDocument();
  });

  it('对照：同一张卡片不在 waitingCallIds 里，照旧「已失效」', () => {
    const messages = [suspendedMessage([pendingBash('call-x')], ['call-x'])];
    render(<TimelineView messages={messages} turnInProgress={false} />);
    expect(screen.getByTestId('approval-card')).toHaveAttribute(
      'data-status',
      'expired',
    );
  });

  it('挂起那一轮的提问卡片：可以作答，不显示「已失效」', () => {
    const messages = [
      suspendedMessage([pendingQuestion('call-q')], ['call-q']),
    ];
    render(
      <TimelineView
        messages={messages}
        turnInProgress={false}
        waitingCallIds={new Set(['call-q'])}
      />,
    );
    expect(screen.queryByText('已失效')).not.toBeInTheDocument();
    expect(screen.getByText('用哪个包管理器？')).toBeInTheDocument();
  });

  it('还有调用在等：尾部是「等待你的答复」', () => {
    const messages = [suspendedMessage([pendingBash('call-x')], ['call-x'])];
    render(
      <TimelineView
        messages={messages}
        turnInProgress={false}
        waitingCallIds={new Set(['call-x'])}
      />,
    );
    expect(screen.getByTestId('turn-suspended-bar')).toBeInTheDocument();
    expect(screen.queryByTestId('turn-resumed-note')).not.toBeInTheDocument();
  });

  it('都答完了（恢复那一轮已改写这条消息）：只留一行「已接着跑」', () => {
    const messages = [suspendedMessage([finishedBash('call-x')], ['call-x'])];
    render(<TimelineView messages={messages} turnInProgress={false} />);
    expect(screen.getByTestId('turn-resumed-note')).toBeInTheDocument();
    expect(screen.queryByTestId('turn-suspended-bar')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// ④ 恢复那一轮开头没有 `start` 的 chunk
// ---------------------------------------------------------------------------

function collectLedger(): {
  ledger: MessageLedger;
  latest: () => RunkoUIMessage[];
  turnEnds: () => RunkoMessageMetadata[];
} {
  let latest: RunkoUIMessage[] = [];
  const turnEnds: RunkoMessageMetadata[] = [];
  const ledger = new MessageLedger(
    (messages) => {
      latest = messages;
    },
    (metadata) => {
      turnEnds.push(metadata);
    },
  );
  return { ledger, latest: () => latest, turnEnds: () => turnEnds };
}

/** 直播：每帧之间隔一个真实的 tick。 */
async function applyLive(
  ledger: MessageLedger,
  frames: readonly ChatReplayFrame[],
): Promise<void> {
  for (const frame of frames) {
    if ('chunk' in frame || 'message' in frame) {
      ledger.applyFrame(frame);
    }
    await flushLedger(1);
  }
  await flushLedger();
}

describe('MessageLedger：恢复那一轮开头的 chunk（§6.2 ④）', () => {
  it('没有 start 的 tool-* chunk 改写原消息：部件拿到结果，位置不变，之后的新消息接在后面', async () => {
    const { ledger, latest, turnEnds } = collectLedger();
    ledger.applyFrame({ seq: 1, message: userMessage('u1', '推上去') });
    ledger.applyFrame({
      seq: 2,
      message: suspendedMessage([pendingBash('call-x')], ['call-x']),
    });

    await applyLive(ledger, [
      { seq: 3, chunk: toolApprovalResponseChunk('call-x', true) },
      { seq: 4, chunk: dataToolTimingChunk('call-x', 100) },
      { seq: 5, chunk: toolOutputAvailableChunk('call-x', { exitCode: 0 }) },
      { seq: 6, chunk: dataToolTimingChunk('call-x', 100, 200) },
      { seq: 7, chunk: startChunk('a2') },
      { seq: 8, chunk: startStepChunk() },
      { seq: 9, chunk: textStartChunk('t1') },
      { chunk: textDeltaChunk('t1', '推好了') },
      { seq: 10, chunk: textEndChunk('t1') },
      { seq: 11, chunk: finishChunk('stop') },
      {
        seq: 12,
        chunk: messageMetadataChunk({
          turn: 2,
          usage: {},
          status: 'completed',
        }),
      },
    ]);

    const messages = latest();
    expect(messages.map((message) => message.id)).toEqual(['u1', 'a1', 'a2']);
    const [, resumed, next] = messages;
    expect(
      resumed === undefined ? undefined : (
        toolPartById(resumed, 'call-x')?.state
      ),
    ).toBe('output-available');
    // 上一轮的收尾 metadata 还留在它自己身上，新一轮的收尾并给了新消息。
    expect(resumed?.metadata?.status).toBe('suspended');
    expect(next?.metadata?.status).toBe('completed');
    expect(turnEnds()).toHaveLength(1);
    expect(findWaitingCallIds(messages).size).toBe(0);
  });

  it('只结清了一个、又以挂起收尾：新的 suspended 并回原消息，onTurnEnd 恰好一次', async () => {
    const { ledger, latest, turnEnds } = collectLedger();
    ledger.applyFrame({
      seq: 1,
      message: suspendedMessage(
        [pendingBash('call-x'), pendingBash('call-y')],
        ['call-x', 'call-y'],
      ),
    });

    await applyLive(ledger, [
      { seq: 2, chunk: toolApprovalResponseChunk('call-x', true) },
      { seq: 3, chunk: toolOutputAvailableChunk('call-x', { exitCode: 0 }) },
      { seq: 4, chunk: messageMetadataChunk(suspendedMetadata(['call-y'])) },
    ]);

    const messages = latest();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.metadata?.suspended?.callIds).toEqual(['call-y']);
    expect(turnEnds()).toHaveLength(1);
    expect([...findWaitingCallIds(messages)]).toEqual(['call-y']);
  });

  it('种子用的是副本：之前交出去的快照不会被就地改掉', async () => {
    const { ledger, latest } = collectLedger();
    ledger.applyFrame({
      seq: 1,
      message: suspendedMessage([pendingBash('call-x')], ['call-x']),
    });
    const before = latest()[0];

    await applyLive(ledger, [
      { seq: 2, chunk: toolApprovalResponseChunk('call-x', true) },
      { seq: 3, chunk: toolOutputAvailableChunk('call-x', { exitCode: 0 }) },
    ]);

    expect(
      before === undefined ? undefined : toolPartById(before, 'call-x')?.state,
    ).toBe('approval-requested');
    const after = latest()[0];
    expect(
      after === undefined ? undefined : toolPartById(after, 'call-x')?.state,
    ).toBe('output-available');
  });

  it('找不到对应消息的 chunk 照旧丢掉，不影响已有内容', async () => {
    const { ledger, latest } = collectLedger();
    ledger.applyFrame({ seq: 1, message: userMessage('u1', 'hi') });

    await applyLive(ledger, [
      { seq: 2, chunk: toolOutputAvailableChunk('call-ghost', 'x') },
    ]);

    expect(latest().map((message) => message.id)).toEqual(['u1']);
  });
});

// ---------------------------------------------------------------------------
// ③ ⑤ useChatMessages
// ---------------------------------------------------------------------------

function setupFetch(): FakeChatFetch {
  const fake = new FakeChatFetch();
  vi.stubGlobal('fetch', fake.fetch);
  return fake;
}

/** 一个以挂起收尾的会话历史：用户说了一句，agent 要推代码，卡片在等。 */
const suspendedHistory: ChatReplayFrame[] = [
  { seq: 1, message: userMessage('u1', '推上去') },
  { seq: 2, message: suspendedMessage([pendingBash('call-x')], ['call-x']) },
];

describe('useChatMessages：挂起（§6.2 ③ ⑤）', () => {
  it('挂载时历史以挂起收尾：交出在等的调用，status 仍是 idle（确实没有轮在跑）', () => {
    const fake = setupFetch();
    const stream = fake.queueStream();
    const { result } = renderHook(() =>
      useChatMessages('sess_1', suspendedHistory),
    );
    expect([...result.current.waitingCallIds]).toEqual(['call-x']);
    expect(result.current.status).toBe('idle');
    stream.close();
  });

  it('答了在等的卡片：重开直播流去接恢复那一轮；部件变了之前按钮一直算「提交中」', async () => {
    const fake = setupFetch();
    const mountStream = fake.queueStream();
    const { result } = renderHook(() =>
      useChatMessages('sess_1', suspendedHistory),
    );
    act(() => {
      mountStream.pushFrame({ turnActive: false });
      mountStream.close();
    });
    await waitFor(() => {
      expect(result.current.waitingCallIds.has('call-x')).toBe(true);
    });

    const resumeStream = fake.queueStream();
    act(() => {
      result.current.submitApproval('call-x', 'allow');
    });

    await waitFor(() => {
      expect(fake.streamRequests).toHaveLength(2);
    });
    expect(fake.approvalPosts).toHaveLength(1);
    expect(fake.streamRequests[1]).toMatchObject({ after: 2 });
    expect(result.current.status).toBe('streaming');
    expect(result.current.awaitingFirstEvent).toBe(true);
    // POST 已经回来了，但恢复那一轮还没改写这张卡片：按钮不能重新亮起来。
    expect(result.current.submittingCallIds.has('call-x')).toBe(true);

    act(() => {
      resumeStream.pushFrame({ turnActive: true });
      resumeStream.pushChunk(toolApprovalResponseChunk('call-x', true), 3);
      resumeStream.pushChunk(
        toolOutputAvailableChunk('call-x', { exitCode: 0 }),
        4,
      );
    });

    await waitFor(() => {
      expect(result.current.waitingCallIds.size).toBe(0);
    });
    expect(result.current.submittingCallIds.has('call-x')).toBe(false);
    expect(result.current.awaitingFirstEvent).toBe(false);
    resumeStream.close();
  });

  it('对照：答一张正在跑的轮里的卡片，不重开直播流', async () => {
    const fake = setupFetch();
    const stream = fake.queueStream();
    const { result } = renderHook(() => useChatMessages('sess_1', []));
    act(() => {
      stream.pushChunk(startChunk('a1'), 1);
      stream.pushChunk(
        {
          type: 'tool-input-available',
          toolCallId: 'call-1',
          toolName: 'bash',
          input: { command: 'ls' },
        },
        2,
      );
      stream.pushChunk(
        {
          type: 'tool-approval-request',
          approvalId: 'call-1',
          toolCallId: 'call-1',
        },
        3,
      );
    });
    await waitFor(() => {
      expect(result.current.messages.length).toBeGreaterThan(0);
    });

    act(() => {
      result.current.submitApproval('call-1', 'allow');
    });
    await waitFor(() => {
      expect(result.current.submittingCallIds.has('call-1')).toBe(false);
    });
    expect(fake.streamRequests).toHaveLength(1);
    stream.close();
  });

  it('在等人时发消息：按排队发出、没有乐观回显、发完重开一次 tail 取队列快照', async () => {
    const fake = setupFetch();
    fake.setMessagePostMode('queued');
    const mountStream = fake.queueStream();
    const { result } = renderHook(() =>
      useChatMessages('sess_1', suspendedHistory),
    );
    act(() => {
      mountStream.pushFrame({ turnActive: false });
      mountStream.close();
    });
    await waitFor(() => {
      expect(result.current.waitingCallIds.size).toBe(1);
    });

    const queueStream = fake.queueStream();
    act(() => {
      result.current.sendMessage('顺便把测试也跑了', 'steer');
    });

    await waitFor(() => {
      expect(fake.streamRequests).toHaveLength(2);
    });
    expect(fake.messagePosts[0]?.body).toEqual({
      text: '顺便把测试也跑了',
      intent: 'queue',
    });
    expect(result.current.pendingUserEchoes).toEqual([]);
    expect(result.current.status).toBe('idle');
    expect(result.current.awaitingFirstEvent).toBe(false);

    act(() => {
      queueStream.pushFrame({
        queue: [queuedMessage('q1', '顺便把测试也跑了')],
      });
      queueStream.pushFrame({ turnActive: false });
      queueStream.close();
    });
    await waitFor(() => {
      expect(result.current.queuedMessages).toHaveLength(1);
    });
  });

  it('挂起那一轮收尾时队列非空：不保持转圈——服务端这时不会出队', async () => {
    const fake = setupFetch();
    const stream = fake.queueStream();
    const { result } = renderHook(() =>
      useChatMessages(
        'sess_1',
        [{ seq: 1, message: userMessage('u1', '推上去') }],
        [queuedMessage('q1', '排着的')],
        true,
      ),
    );
    expect(result.current.status).toBe('streaming');

    act(() => {
      stream.pushChunk(startChunk('a1'), 2);
      stream.pushChunk(
        {
          type: 'tool-input-available',
          toolCallId: 'call-x',
          toolName: 'bash',
          input: { command: 'git push' },
        },
        3,
      );
      stream.pushChunk(
        {
          type: 'tool-approval-request',
          approvalId: 'call-x',
          toolCallId: 'call-x',
        },
        4,
      );
      stream.pushChunk(finishChunk('tool-calls'), 5);
      stream.pushChunk(messageMetadataChunk(suspendedMetadata(['call-x'])), 6);
    });

    await waitFor(() => {
      expect(result.current.status).toBe('idle');
    });
    expect(result.current.awaitingFirstEvent).toBe(false);
    await waitFor(() => {
      expect([...result.current.waitingCallIds]).toEqual(['call-x']);
    });
    stream.close();
  });
});

describe('被拒的中间态与 404 之后', () => {
  it('被拒的 approval-responded 不算在等（与 core 的 pendingCallIds 一致）', () => {
    const denied: Part = {
      type: 'tool-bash',
      toolCallId: 'call-x',
      state: 'approval-responded',
      input: { command: 'git push' },
      approval: { id: 'call-x', approved: false },
    };
    expect(
      findWaitingCallIds([suspendedMessage([denied], ['call-x'])]).size,
    ).toBe(0);
  });

  it('挂起的卡片拿到 404：标成已失效，同时重开一次直播流看看服务端是不是接着跑了', async () => {
    const fake = setupFetch();
    fake.setApprovalStatus(404);
    const mountStream = fake.queueStream();
    const { result } = renderHook(() =>
      useChatMessages('sess_1', suspendedHistory),
    );
    act(() => {
      mountStream.pushFrame({ turnActive: false });
      mountStream.close();
    });
    await waitFor(() => {
      expect(result.current.waitingCallIds.has('call-x')).toBe(true);
    });

    const lookStream = fake.queueStream();
    act(() => {
      result.current.submitApproval('call-x', 'allow');
    });
    await waitFor(() => {
      expect(fake.streamRequests).toHaveLength(2);
    });
    expect(result.current.locallyExpiredCallIds.has('call-x')).toBe(true);
    lookStream.close();
  });
});
