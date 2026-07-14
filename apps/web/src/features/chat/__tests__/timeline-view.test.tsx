import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TimelineView } from '../components/timeline-view';
import {
  SAMPLE_APPROVAL_COMMAND,
  SAMPLE_EXPIRED_APPROVAL_COMMAND,
  SAMPLE_QUESTION_ANSWER,
  SAMPLE_QUESTION_TEXT,
  SAMPLE_USER_MESSAGE_TEXT,
  sampleApprovalQuestionEnvelopes,
  sampleChatEnvelopes,
} from '../fixtures/sample-session-events';
import type { ChatStreamEnvelope } from '../schema';

describe('TimelineView', () => {
  it('renders an empty state with zero envelopes and no optimistic messages', () => {
    render(<TimelineView envelopes={[]} />);
    expect(screen.getByText('还没有消息')).toBeInTheDocument();
  });

  it('aggregates agent_message increments into the final full text, with no duplicated fragments', () => {
    const { rerender } = render(<TimelineView envelopes={[]} />);

    // `seq` is `number | undefined` on the envelope type (docs/08 §2.2d) —
    // every fixture envelope here is persisted (has a real seq), so this
    // guard is only to satisfy the narrower type.
    const withDeltas: ChatStreamEnvelope[] = sampleChatEnvelopes.filter(
      (envelope) => envelope.seq !== undefined && envelope.seq <= 18,
    );
    rerender(<TimelineView envelopes={withDeltas} />);
    expect(
      screen.getByText(
        /根据代码分析，登录页面的密码输入框缺少显示\/隐藏切换，$/,
      ),
    ).toBeInTheDocument();

    rerender(<TimelineView envelopes={sampleChatEnvelopes} />);
    const finalText = screen.getByText(
      /由于直接修改文件权限被拒绝，以上是我的建议方案。$/,
    );
    expect(finalText).toBeInTheDocument();
    // no leftover duplicate of the intermediate partial text once the full text has replaced it:
    expect(screen.queryByText(/切换，$/)).not.toBeInTheDocument();
  });

  it('renders each tool_call as a single card whose status reflects the latest lifecycle event', () => {
    render(<TimelineView envelopes={sampleChatEnvelopes} />);
    expect(screen.getAllByText('bash')).toHaveLength(1);
    expect(screen.getAllByText('write_file')).toHaveLength(1);
    expect(screen.getByText('已完成')).toBeInTheDocument();
    expect(screen.getByText('失败')).toBeInTheDocument();
  });

  it('renders file_change as one badge per change', () => {
    render(<TimelineView envelopes={sampleChatEnvelopes} />);
    const badges = screen.getByTestId('file-change-badges');
    expect(within(badges).getByText('src/pages/login.tsx')).toBeInTheDocument();
    expect(within(badges).getByText('src/pages/login.css')).toBeInTheDocument();
  });

  it('renders plan_update as a checklist reflecting the latest completed flags', () => {
    render(<TimelineView envelopes={sampleChatEnvelopes} />);
    const checklist = screen.getByTestId('plan-checklist');
    const checkboxes = within(checklist).getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0]).toHaveAttribute('aria-checked', 'true');
    expect(checkboxes[1]).toHaveAttribute('aria-checked', 'false');
  });

  it('renders the error item as a red alert bar', () => {
    render(<TimelineView envelopes={sampleChatEnvelopes} />);
    expect(screen.getByTestId('error-bar')).toBeInTheDocument();
  });

  it('renders the turn.result sentinel as a usage summary bar', () => {
    render(<TimelineView envelopes={sampleChatEnvelopes} />);
    const bar = screen.getByTestId('turn-result-bar');
    expect(bar).toHaveTextContent('1200');
    expect(bar).toHaveTextContent('340');
    expect(bar).toHaveTextContent('1540');
    // cached prompt tokens shown per turn (fixture: cachedInputTokens 896)
    expect(bar).toHaveTextContent('缓存命中 896');
  });

  it('renders the server-echoed user.message event as a single user bubble (docs/08 §2.2 "契约细化" #1)', () => {
    render(<TimelineView envelopes={sampleChatEnvelopes} />);
    expect(screen.getAllByText(SAMPLE_USER_MESSAGE_TEXT)).toHaveLength(1);
  });

  it('renders a steer()-injected user_message item through the same from="user" bubble as the turn-initiating user.message (local-review Finding 1 / STEER §4.2)', () => {
    const steeredText = '补充：也顺便检查一下登录页的 API 超时时间';
    const envelopes: ChatStreamEnvelope[] = [
      { seq: 1, event: { type: 'session.started', sessionId: 'sess_steer' } },
      { seq: 2, event: { type: 'user.message', text: '先看看登录页面' } },
      { seq: 3, event: { type: 'turn.started', turn: 1 } },
      {
        seq: 4,
        event: {
          type: 'item.completed',
          item: { id: 'u1', type: 'user_message', text: steeredText },
        },
      },
      {
        seq: 5,
        event: {
          type: 'item.completed',
          item: { id: 'a1', type: 'agent_message', text: '好的，都检查一下。' },
        },
      },
      { seq: 6, event: { type: 'turn.completed', usage: {} } },
      {
        seq: 7,
        event: {
          type: 'turn.result',
          finalResponse: '好的，都检查一下。',
          usage: {},
        },
      },
    ];

    render(<TimelineView envelopes={envelopes} />);

    const steeredBubble = screen.getByText(steeredText);
    expect(steeredBubble).toBeInTheDocument();
    // `bg-secondary` is `MessageContent`'s `from="user"`-only styling (message.tsx) — its
    // presence is what actually distinguishes "rendered via the user bubble branch" from,
    // say, an assistant/plain-text rendering that happens to contain the same string.
    expect(steeredBubble.closest('.bg-secondary')).not.toBeNull();
  });

  it('does not duplicate the user bubble once optimisticMessages no longer holds the confirmed entry', () => {
    // Mirrors what useChatMessages does the instant the real `user.message`
    // envelope arrives: it's already in `envelopes` (confirmed) and has been
    // dequeued out of `optimisticMessages` — so passing an *empty* optimistic
    // list alongside the confirmed envelope must render exactly one bubble.
    render(
      <TimelineView envelopes={sampleChatEnvelopes} optimisticMessages={[]} />,
    );
    expect(screen.getAllByText(SAMPLE_USER_MESSAGE_TEXT)).toHaveLength(1);
  });

  it('renders a still-unconfirmed optimistic message alongside (not instead of) the confirmed timeline', () => {
    render(
      <TimelineView
        envelopes={sampleChatEnvelopes}
        optimisticMessages={[{ id: 1, text: '另外这个提交能顺便看一下吗？' }]}
      />,
    );
    expect(screen.getAllByText(SAMPLE_USER_MESSAGE_TEXT)).toHaveLength(1);
    expect(
      screen.getByText('另外这个提交能顺便看一下吗？'),
    ).toBeInTheDocument();
  });

  it('applying the same envelope twice (seq re-delivery) does not duplicate its rendering', () => {
    const duplicated: ChatStreamEnvelope[] = [
      ...sampleChatEnvelopes,
      sampleChatEnvelopes[sampleChatEnvelopes.length - 1],
    ].filter(
      (envelope): envelope is ChatStreamEnvelope => envelope !== undefined,
    );
    render(<TimelineView envelopes={duplicated} />);
    expect(screen.getAllByTestId('turn-result-bar')).toHaveLength(1);
  });

  describe('approval/question cards (docs/08 §2.2c（审批链）, sampleApprovalQuestionEnvelopes)', () => {
    it('renders the resolved approval card (allowed, call_1) with its bash command', () => {
      render(<TimelineView envelopes={sampleApprovalQuestionEnvelopes} />);

      // two bash calls get escalated in the fixture: call_1 (resolved allow)
      // and call_3 (never resolved before turn.result — expired below).
      const approvalCards = screen.getAllByTestId('approval-card');
      expect(approvalCards).toHaveLength(2);

      const allowedCard = approvalCards.find(
        (card) => card.getAttribute('data-status') === 'allowed',
      );
      if (allowedCard === undefined) throw new Error('unreachable');
      expect(
        within(allowedCard).getByText(SAMPLE_APPROVAL_COMMAND),
      ).toBeInTheDocument();
    });

    it("renders the never-resolved approval (call_3) as expired once the turn's terminal turn.result sentinel has been replayed", () => {
      render(<TimelineView envelopes={sampleApprovalQuestionEnvelopes} />);

      const approvalCards = screen.getAllByTestId('approval-card');
      const expiredCard = approvalCards.find(
        (card) => card.getAttribute('data-status') === 'expired',
      );
      if (expiredCard === undefined) throw new Error('unreachable');
      expect(
        within(expiredCard).getByText(SAMPLE_EXPIRED_APPROVAL_COMMAND),
      ).toBeInTheDocument();
    });

    it('renders the answered question card (call_2) with its question and answer', () => {
      render(<TimelineView envelopes={sampleApprovalQuestionEnvelopes} />);

      const questionCard = screen.getByTestId('question-card');
      expect(questionCard).toHaveAttribute('data-status', 'answered');
      expect(
        within(questionCard).getByText(SAMPLE_QUESTION_TEXT),
      ).toBeInTheDocument();
      expect(questionCard).toHaveTextContent(SAMPLE_QUESTION_ANSWER);
    });

    it("suppresses the ask_user tool_call's own card — no 'ask_user' tool name text appears anywhere, the question card is its sole rendering", () => {
      render(<TimelineView envelopes={sampleApprovalQuestionEnvelopes} />);
      expect(screen.queryByText('ask_user')).not.toBeInTheDocument();
      expect(screen.getByTestId('question-card')).toBeInTheDocument();
    });
  });
});
