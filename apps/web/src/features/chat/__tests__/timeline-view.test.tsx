import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TimelineView } from '../components/timeline-view';
import {
  SAMPLE_USER_MESSAGE_TEXT,
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

    const withDeltas: ChatStreamEnvelope[] = sampleChatEnvelopes.filter(
      (envelope) => envelope.seq <= 18,
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
});
