import type { RunkoUIMessage } from '@runko/core';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TimelineView } from '../components/timeline-view';

describe('TimelineView — empty state', () => {
  it('renders the empty-state copy when there are no messages and no pending echoes', () => {
    render(<TimelineView messages={[]} />);
    expect(screen.getByText('这条分支还没有指令')).toBeInTheDocument();
  });

  it('a pending echo alone (no materialized messages yet) is enough to skip the empty state', () => {
    render(
      <TimelineView
        messages={[]}
        pendingUserEchoes={[{ id: 1, text: '你好', afterMessageCount: 0 }]}
      />,
    );
    expect(screen.queryByText('还没有消息')).not.toBeInTheDocument();
    expect(screen.getByText('你好')).toBeInTheDocument();
  });
});

describe('TimelineView — message part rendering', () => {
  it("renders a user message's text", () => {
    const messages: RunkoUIMessage[] = [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: '你好啊' }] },
    ];
    render(<TimelineView messages={messages} />);
    expect(screen.getByText('你好啊')).toBeInTheDocument();
  });

  it('marks a steered user message with the "插话" label', () => {
    const messages: RunkoUIMessage[] = [
      {
        id: 'm1',
        role: 'user',
        parts: [{ type: 'text', text: '等一下' }],
        metadata: { steered: true },
      },
    ];
    render(<TimelineView messages={messages} />);
    expect(screen.getByText('插话')).toBeInTheDocument();
  });

  it('renders assistant text and reasoning parts', () => {
    const messages: RunkoUIMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        parts: [
          { type: 'step-start' },
          { type: 'reasoning', text: '让我想想', state: 'done' },
          { type: 'text', text: '答案是 42', state: 'done' },
        ],
      },
    ];
    render(<TimelineView messages={messages} />);
    expect(screen.getByText('答案是 42')).toBeInTheDocument();
    // A `state: 'done'` reasoning part starts collapsed — its trigger still shows "思考过程".
    expect(screen.getByText('思考过程')).toBeInTheDocument();
  });

  it('renders data-file-change, data-plan-update, and data-error parts', () => {
    const messages: RunkoUIMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        parts: [
          { type: 'step-start' },
          {
            type: 'data-file-change',
            id: 'fc-1',
            data: { changes: [{ path: 'a.txt', kind: 'add' }] },
          },
          {
            type: 'data-plan-update',
            id: 'plan-update',
            data: { items: [{ text: '写测试', completed: false }] },
          },
          { type: 'data-error', id: 'turn-error', data: { message: '出错了' } },
        ],
      },
    ];
    render(<TimelineView messages={messages} />);
    expect(screen.getByTestId('file-change-badges')).toBeInTheDocument();
    expect(screen.getByText('a.txt')).toBeInTheDocument();
    expect(screen.getByTestId('plan-checklist')).toBeInTheDocument();
    expect(screen.getByText('写测试')).toBeInTheDocument();
    expect(screen.getByTestId('error-bar')).toHaveTextContent('出错了');
  });

  // 消息发出到这一轮第一帧到达之间（整段起轮装配，冷启动可达数十秒），AI 侧不该是空的
  // ——用户只看到自己那条消息孤零零挂着，不知道有没有被收到。
  it('awaitingFirstEvent 时在时间线末尾摆一个 AI 侧等待占位', () => {
    render(
      <TimelineView
        messages={[]}
        pendingUserEchoes={[
          { id: 1, text: '帮我改个样式', afterMessageCount: 0 },
        ]}
        awaitingFirstEvent
      />,
    );

    expect(screen.getByTestId('awaiting-first-event')).toBeInTheDocument();
    // 文案刻意不是「思考中…」：那一刻 agent 还没开始跑，说它在思考是假的。
    expect(screen.getByText('正在准备…')).toBeInTheDocument();
    expect(screen.queryByText('思考中…')).not.toBeInTheDocument();
    // 用户那条消息照常在（占位是**追加**在末尾，不是替代）。
    expect(screen.getByText('帮我改个样式')).toBeInTheDocument();
  });

  it('第一帧到达后（awaitingFirstEvent 为假）不再有占位', () => {
    const messages: RunkoUIMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        parts: [
          { type: 'step-start' },
          { type: 'text', text: '好的', state: 'done' },
        ],
      },
    ];
    render(<TimelineView messages={messages} awaitingFirstEvent={false} />);

    expect(
      screen.queryByTestId('awaiting-first-event'),
    ).not.toBeInTheDocument();
  });

  it('a gated tool call in approval-requested state renders ApprovalCard, not ToolCallCard', () => {
    const messages: RunkoUIMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        parts: [
          { type: 'step-start' },
          {
            type: 'tool-bash',
            toolCallId: 'call-1',
            state: 'approval-requested',
            input: { command: 'rm -rf /tmp' },
            approval: { id: 'call-1' },
          },
        ],
      },
    ];
    render(<TimelineView messages={messages} />);
    expect(screen.getByTestId('approval-card')).toBeInTheDocument();
  });

  // 轮结束后，还挂着的审批卡片就已经失效了——服务端那边的挂起项在轮收尾时就被结掉了，
  // 再点任何按钮都只会拿到 404。此前界面要等用户点下去吃了 404 才翻，在那之前一直画着
  // 三个可点的按钮（用户实测报告：一张「待审批」卡片下面就是「服务重启，这一轮已中断」）。
  it('轮已结束时，还停在 approval-requested 的卡片直接显示「已失效」且不给按钮', () => {
    const messages: RunkoUIMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        parts: [
          { type: 'step-start' },
          {
            type: 'tool-bash',
            toolCallId: 'call-1',
            state: 'approval-requested',
            input: { command: 'git commit -m "wip"' },
            approval: { id: 'call-1' },
          },
        ],
      },
    ];
    render(<TimelineView messages={messages} turnInProgress={false} />);

    const card = screen.getByTestId('approval-card');
    expect(card).toHaveAttribute('data-status', 'expired');
    expect(screen.getByText('已失效')).toBeInTheDocument();
    expect(screen.queryByText('待审批')).not.toBeInTheDocument();
    // 三个决策按钮一个都不该在——点了也只会拿到 404。
    expect(
      screen.queryByRole('button', { name: '允许' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '会话内都允许' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '拒绝' }),
    ).not.toBeInTheDocument();
  });

  // 回归（用户实测）：上一轮停掉、卡片已显示「已失效」，用户再发一句「继续」起了新一轮，
  // 那张历史卡片**又活了**——因为判据当时只看「会话里有没有轮在跑」。正确判据是「**这张
  // 卡片自己那一轮**还在跑吗」：账本里每一轮以一条带终态 metadata 的消息收尾，收尾消息
  // 及其之前的一切都属于已结束的轮。
  it('新一轮起来后，上一轮那张卡片仍然是「已失效」，不会跟着复活', () => {
    const messages: RunkoUIMessage[] = [
      // ---- 上一轮：卡片还挂着，就被停止收尾了 ----
      {
        id: 'm1',
        role: 'assistant',
        parts: [
          { type: 'step-start' },
          {
            type: 'tool-bash',
            toolCallId: 'call-1',
            state: 'approval-requested',
            input: { command: 'git commit -m "wip"' },
            approval: { id: 'call-1' },
          },
        ],
        metadata: {
          status: 'interrupted',
          error: { code: 'aborted', message: 'Turn stopped by the user.' },
        },
      },
      // ---- 用户发「继续」，新一轮起来了 ----
      { id: 'm2', role: 'user', parts: [{ type: 'text', text: '继续' }] },
      {
        id: 'm3',
        role: 'assistant',
        parts: [
          { type: 'step-start' },
          { type: 'text', text: '好的，我接着来', state: 'done' },
        ],
      },
    ];
    // 会话级：确实有轮在跑（新那一轮）。
    render(<TimelineView messages={messages} turnInProgress />);

    // 但旧卡片属于已收尾的那一轮，必须仍然是失效态。
    expect(screen.getByTestId('approval-card')).toHaveAttribute(
      'data-status',
      'expired',
    );
    expect(screen.queryByText('待审批')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '允许' }),
    ).not.toBeInTheDocument();
  });

  it('轮还在跑时同一张卡片照常是「待审批」（默认档不受影响）', () => {
    const messages: RunkoUIMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        parts: [
          { type: 'step-start' },
          {
            type: 'tool-bash',
            toolCallId: 'call-1',
            state: 'approval-requested',
            input: { command: 'git commit -m "wip"' },
            approval: { id: 'call-1' },
          },
        ],
      },
    ];
    render(<TimelineView messages={messages} turnInProgress />);

    expect(screen.getByTestId('approval-card')).toHaveAttribute(
      'data-status',
      'pending',
    );
    expect(screen.getByText('待审批')).toBeInTheDocument();
  });

  // 已回答的提问卡片不能被轮结束「追认」成失效——`expired` 在卡片里优先于 `answered`，
  // 叠错了会把一条答完的问题画成「已失效」。
  it('轮已结束不影响已回答的提问卡片（仍是「已回答」）', () => {
    const messages: RunkoUIMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        parts: [
          { type: 'step-start' },
          {
            type: 'tool-ask-user',
            toolCallId: 'call-2',
            state: 'output-available',
            input: { question: '用哪个包管理器？' },
            output: 'pnpm',
          },
        ],
      },
    ];
    render(<TimelineView messages={messages} turnInProgress={false} />);

    expect(screen.getByText('已回答')).toBeInTheDocument();
    expect(screen.queryByText('已失效')).not.toBeInTheDocument();
  });

  it('a gated tool call resolved to approval-responded(denied) renders ToolCallCard with the deny reason, not ApprovalCard', async () => {
    const messages: RunkoUIMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        parts: [
          { type: 'step-start' },
          {
            type: 'tool-bash',
            toolCallId: 'call-1',
            state: 'output-denied',
            input: { command: 'rm -rf /tmp' },
            approval: { id: 'call-1', approved: false, reason: '太危险了' },
          },
        ],
      },
    ];
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    render(<TimelineView messages={messages} />);
    expect(screen.queryByTestId('approval-card')).not.toBeInTheDocument();
    expect(screen.getByText('bash')).toBeInTheDocument();
    expect(screen.getByText('已拒绝')).toBeInTheDocument();

    // The deny reason lives in ToolCallCard's collapsible content, closed by default.
    await user.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText(/拒绝原因：太危险了/)).toBeInTheDocument();
  });

  it('an ask-user tool part in input-available state renders QuestionCard, not ToolCallCard', () => {
    const messages: RunkoUIMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        parts: [
          { type: 'step-start' },
          {
            type: 'tool-ask-user',
            toolCallId: 'call-2',
            state: 'input-available',
            input: { question: '选哪个？', options: ['A', 'B'] },
          },
        ],
      },
    ];
    render(<TimelineView messages={messages} />);
    expect(screen.getByTestId('question-card')).toBeInTheDocument();
    expect(screen.getByText('选哪个？')).toBeInTheDocument();
  });

  it('an ask-user tool part in output-available state also renders QuestionCard (answered), not ToolCallCard', () => {
    const messages: RunkoUIMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        parts: [
          { type: 'step-start' },
          {
            type: 'tool-ask-user',
            toolCallId: 'call-2',
            state: 'output-available',
            input: { question: '选哪个？' },
            output: 'A',
          },
        ],
      },
    ];
    render(<TimelineView messages={messages} />);
    expect(screen.getByTestId('question-card')).toBeInTheDocument();
    expect(screen.getByText('你的回答：A')).toBeInTheDocument();
  });

  it('joins a data-tool-timing part into its matching ToolCallCard by toolCallId (chat 可观测性), coexisting with other data parts on the same message, and never renders it as an independent card of its own', () => {
    const messages: RunkoUIMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        parts: [
          { type: 'step-start' },
          {
            type: 'tool-write-file',
            toolCallId: 'call-1',
            state: 'output-available',
            input: { path: 'a.txt' },
            output: 'ok',
          },
          {
            type: 'data-tool-timing',
            id: 'call-1',
            data: {
              toolCallId: 'call-1',
              startedAt: 1_700_000_000_000,
              completedAt: 1_700_000_001_500,
            },
          },
          {
            type: 'data-plan-update',
            id: 'plan-update',
            data: { items: [{ text: '写测试', completed: false }] },
          },
        ],
      },
    ];
    render(<TimelineView messages={messages} />);

    // The timing strip is joined onto the ToolCallCard, and the sibling
    // data-plan-update part still renders normally alongside it.
    expect(screen.getByTestId('tool-timing')).toBeInTheDocument();
    expect(screen.getByTestId('plan-checklist')).toBeInTheDocument();
    // Exactly one strip — data-tool-timing itself never renders as its own
    // card (message-entry.tsx's switch has no case for it).
    expect(screen.getAllByTestId('tool-timing')).toHaveLength(1);
  });

  it('renders no tool-timing strip at all when the tool part has no matching data-tool-timing (old session, or input still streaming) — no crash, no empty strip', () => {
    const messages: RunkoUIMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        parts: [
          { type: 'step-start' },
          {
            type: 'tool-write-file',
            toolCallId: 'call-1',
            state: 'output-available',
            input: { path: 'a.txt' },
            output: 'ok',
          },
        ],
      },
    ];
    render(<TimelineView messages={messages} />);
    expect(screen.queryByTestId('tool-timing')).not.toBeInTheDocument();
  });

  it('a non-gated, non-ask-user tool call (e.g. write-file, output-available) renders the generic ToolCallCard', () => {
    const messages: RunkoUIMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        parts: [
          { type: 'step-start' },
          {
            type: 'tool-write-file',
            toolCallId: 'call-3',
            state: 'output-available',
            input: { path: 'a.txt' },
            output: 'ok',
          },
        ],
      },
    ];
    render(<TimelineView messages={messages} />);
    expect(screen.getByText('write-file')).toBeInTheDocument();
    expect(screen.queryByTestId('approval-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('question-card')).not.toBeInTheDocument();
  });

  it("routes onSubmitApproval/onSubmitAnswer callbacks through with the part's own toolCallId", async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    const onSubmitApproval = vi.fn();
    const messages: RunkoUIMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        parts: [
          { type: 'step-start' },
          {
            type: 'tool-bash',
            toolCallId: 'call-9',
            state: 'approval-requested',
            input: { command: 'ls' },
            approval: { id: 'call-9' },
          },
        ],
      },
    ];
    render(
      <TimelineView messages={messages} onSubmitApproval={onSubmitApproval} />,
    );
    // 精确名：卡片现在还有「会话内都允许」按钮，/允许/ 正则会多重匹配。
    await user.click(screen.getByRole('button', { name: '允许' }));
    expect(onSubmitApproval).toHaveBeenCalledExactlyOnceWith('call-9', 'allow');
  });
});

describe('TimelineView — turn-stats / turn-failed bar placement', () => {
  it('a completed assistant message shows the turn-stats button after its parts', () => {
    const messages: RunkoUIMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        parts: [
          { type: 'step-start' },
          { type: 'text', text: '完成了', state: 'done' },
        ],
        metadata: { status: 'completed', usage: { totalTokens: 10 } },
      },
    ];
    render(<TimelineView messages={messages} />);
    // 概览格式化（耗时首位、工具/agent 拆分、千分位、旧记录省略）由
    // turn-stats-dialog.test.tsx 直接覆盖；这里只验证集成层的按钮落位。
    expect(screen.getByTestId('turn-stats-button')).toBeInTheDocument();
    expect(screen.queryByTestId('turn-failed-bar')).not.toBeInTheDocument();
  });

  it('a failed assistant message shows TurnFailedBar (not the turn-stats button)', () => {
    const messages: RunkoUIMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        parts: [
          { type: 'step-start' },
          { type: 'text', text: '出错前的部分响应', state: 'done' },
        ],
        metadata: {
          status: 'failed',
          error: { code: 'provider_error', message: '模型服务超时' },
        },
      },
    ];
    render(<TimelineView messages={messages} />);
    expect(screen.getByTestId('turn-failed-bar')).toBeInTheDocument();
    expect(screen.getByText('模型服务超时')).toBeInTheDocument();
    expect(screen.queryByTestId('turn-stats-button')).not.toBeInTheDocument();
  });

  it('一轮被[停止](../../../../../docs/terms.md)（status interrupted / code aborted）走中性的「已停止」标记，不是红色失败条，也不把 core 那句英文 message 抛给用户', () => {
    const messages: RunkoUIMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        parts: [
          { type: 'step-start' },
          { type: 'text', text: '做到一半', state: 'done' },
        ],
        metadata: {
          status: 'interrupted',
          error: { code: 'aborted', message: 'Turn stopped by the user.' },
        },
      },
    ];
    render(<TimelineView messages={messages} />);
    expect(screen.getByTestId('turn-stopped-bar')).toBeInTheDocument();
    expect(screen.getByText('已停止')).toBeInTheDocument();
    expect(screen.queryByTestId('turn-failed-bar')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Turn stopped by the user.'),
    ).not.toBeInTheDocument();
    // 已产出的内容照旧留在时间线上（停止不是撤销）。
    expect(screen.getByText('做到一半')).toBeInTheDocument();
  });

  // 同一个 `code: 'aborted'`，但不是用户按的——服务端[优雅关闭](../../../../../docs/terms.md)
  // 中止的（docs/tech/graceful-shutdown.md §4）。判档靠 message 与服务端那个常量逐字相等，
  // 所以这条用例同时是那个跨端文案契约的哨兵：服务端改了文案而这里没跟，它就会红。
  it('服务重启导致的中断走「服务重启，这一轮已中断」，与用户按停止分开', () => {
    const messages: RunkoUIMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        parts: [
          { type: 'step-start' },
          { type: 'text', text: '迁到一半', state: 'done' },
        ],
        metadata: {
          status: 'interrupted',
          error: {
            code: 'aborted',
            message: 'The server shut down while this turn was running.',
          },
        },
      },
    ];
    render(<TimelineView messages={messages} />);

    // 仍是中性标记（不是红色失败条）——这不是故障。
    expect(screen.getByTestId('turn-stopped-bar')).toBeInTheDocument();
    expect(screen.queryByTestId('turn-failed-bar')).not.toBeInTheDocument();

    expect(screen.getByText('服务重启，这一轮已中断')).toBeInTheDocument();
    // 关键：不能显示成「已停止」，用户没按过任何按钮。
    expect(screen.queryByText('已停止')).not.toBeInTheDocument();
    // core 那句英文同样不抛给用户。
    expect(
      screen.queryByText('The server shut down while this turn was running.'),
    ).not.toBeInTheDocument();
    expect(screen.getByText('迁到一半')).toBeInTheDocument();
  });

  it('a "turn signal" placeholder message (empty parts, only metadata) renders just the trailing bar, no bubble', () => {
    const messages: RunkoUIMessage[] = [
      {
        id: 'turn-signal-1',
        role: 'assistant',
        parts: [],
        metadata: {
          status: 'failed',
          error: { code: 'context_overflow', message: '上下文太长了' },
        },
      },
    ];
    render(<TimelineView messages={messages} />);
    expect(screen.getByTestId('turn-failed-bar')).toBeInTheDocument();
    expect(
      screen.queryByText(/./, { selector: 'pre' }),
    ).not.toBeInTheDocument();
  });

  it('an assistant message with no metadata status shows neither bar', () => {
    const messages: RunkoUIMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        parts: [
          { type: 'step-start' },
          { type: 'text', text: '还在说', state: 'streaming' },
        ],
      },
    ];
    render(<TimelineView messages={messages} />);
    expect(screen.queryByTestId('turn-stats-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('turn-failed-bar')).not.toBeInTheDocument();
  });
});

describe('TimelineView — pending-echo interleaving with real materialized messages', () => {
  it('renders a pending echo between the two turns it was sent between, in document order', () => {
    const messages: RunkoUIMessage[] = [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: '第一轮' }] },
      {
        id: 'm2',
        role: 'assistant',
        parts: [
          { type: 'step-start' },
          { type: 'text', text: '第一轮回复', state: 'done' },
        ],
        metadata: { status: 'completed' },
      },
      { id: 'm3', role: 'user', parts: [{ type: 'text', text: '第二轮' }] },
    ];
    render(
      <TimelineView
        messages={messages}
        pendingUserEchoes={[
          { id: 1, text: '回显：第二轮', afterMessageCount: 2 },
        ]}
      />,
    );

    const log = screen.getByRole('log');
    const texts = within(log)
      .getAllByText(/第一轮|第一轮回复|第二轮|回显：第二轮/)
      .map((el) => el.textContent);
    expect(texts).toEqual(['第一轮', '第一轮回复', '回显：第二轮', '第二轮']);
  });
});
