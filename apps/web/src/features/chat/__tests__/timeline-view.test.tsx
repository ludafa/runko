import type { NimboUIMessage } from '@nimbo/core';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TimelineView } from '../components/timeline-view';

describe('TimelineView — empty state', () => {
  it('renders the empty-state copy when there are no messages and no pending echoes', () => {
    render(<TimelineView messages={[]} />);
    expect(screen.getByText('还没有消息')).toBeInTheDocument();
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
    const messages: NimboUIMessage[] = [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: '你好啊' }] },
    ];
    render(<TimelineView messages={messages} />);
    expect(screen.getByText('你好啊')).toBeInTheDocument();
  });

  it('marks a steered user message with the "插话" label', () => {
    const messages: NimboUIMessage[] = [
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
    const messages: NimboUIMessage[] = [
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
    const messages: NimboUIMessage[] = [
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

  it('a gated tool call in approval-requested state renders ApprovalCard, not ToolCallCard', () => {
    const messages: NimboUIMessage[] = [
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

  it('a gated tool call resolved to approval-responded(denied) renders ToolCallCard with the deny reason, not ApprovalCard', async () => {
    const messages: NimboUIMessage[] = [
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
    const messages: NimboUIMessage[] = [
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
    const messages: NimboUIMessage[] = [
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
    const messages: NimboUIMessage[] = [
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
    const messages: NimboUIMessage[] = [
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
    const messages: NimboUIMessage[] = [
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
    const messages: NimboUIMessage[] = [
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
    const messages: NimboUIMessage[] = [
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
    const messages: NimboUIMessage[] = [
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

  it('a "turn signal" placeholder message (empty parts, only metadata) renders just the trailing bar, no bubble', () => {
    const messages: NimboUIMessage[] = [
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
    const messages: NimboUIMessage[] = [
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
    const messages: NimboUIMessage[] = [
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
