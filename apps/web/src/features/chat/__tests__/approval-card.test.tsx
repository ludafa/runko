import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { PendingApprovalPart } from '../components/approval-card';
import { ApprovalCard } from '../components/approval-card';

function pendingBashPart(
  overrides: Partial<PendingApprovalPart> = {},
): PendingApprovalPart {
  return {
    type: 'tool-bash',
    toolCallId: 'call-1',
    state: 'approval-requested',
    input: { command: 'rm -rf /tmp/x' },
    approval: { id: 'call-1' },
    ...overrides,
  };
}

describe('ApprovalCard', () => {
  it('renders the tool name, the bash command, and a "待审批" badge for an approval-requested part', () => {
    render(
      <ApprovalCard
        part={pendingBashPart()}
        submitting={false}
        expired={false}
        onDecide={() => undefined}
      />,
    );
    expect(screen.getByText('bash')).toBeInTheDocument();
    expect(screen.getByText('rm -rf /tmp/x')).toBeInTheDocument();
    expect(screen.getByText('待审批')).toBeInTheDocument();
  });

  it('falls back to a pretty-printed JSON payload for a tool whose input has no "command" field', () => {
    render(
      <ApprovalCard
        part={pendingBashPart({
          type: 'tool-write-file',
          input: { path: 'a.txt', content: 'hi' },
        })}
        submitting={false}
        expired={false}
        onDecide={() => undefined}
      />,
    );
    expect(screen.getByText('write-file')).toBeInTheDocument();
    expect(screen.getByText(/"path": "a.txt"/)).toBeInTheDocument();
  });

  it('clicking 允许 calls onDecide("allow") with the part\'s own callId implicit in the handler', async () => {
    const user = userEvent.setup();
    const onDecide = vi.fn();
    render(
      <ApprovalCard
        part={pendingBashPart()}
        submitting={false}
        expired={false}
        onDecide={onDecide}
      />,
    );
    // 精确名（不用 /允许/ 正则）——否则会同时匹配「会话内都允许」，报多重匹配。
    await user.click(screen.getByRole('button', { name: '允许' }));
    expect(onDecide).toHaveBeenCalledExactlyOnceWith('allow');
  });

  it('clicking 会话内都允许 calls onDecide("allow-session") — 会话级授权（docs/terms.md §四）', async () => {
    const user = userEvent.setup();
    const onDecide = vi.fn();
    render(
      <ApprovalCard
        part={pendingBashPart()}
        submitting={false}
        expired={false}
        onDecide={onDecide}
      />,
    );
    await user.click(screen.getByRole('button', { name: '会话内都允许' }));
    expect(onDecide).toHaveBeenCalledExactlyOnceWith('allow-session');
  });

  it('clicking 拒绝 calls onDecide("deny")', async () => {
    const user = userEvent.setup();
    const onDecide = vi.fn();
    render(
      <ApprovalCard
        part={pendingBashPart()}
        submitting={false}
        expired={false}
        onDecide={onDecide}
      />,
    );
    await user.click(screen.getByRole('button', { name: /拒绝/ }));
    expect(onDecide).toHaveBeenCalledExactlyOnceWith('deny');
  });

  it('disables all decision buttons while submitting', () => {
    render(
      <ApprovalCard
        part={pendingBashPart()}
        submitting={true}
        expired={false}
        onDecide={() => undefined}
      />,
    );
    for (const button of screen.getAllByRole('button')) {
      expect(button).toBeDisabled();
    }
  });

  it('renders an expired notice instead of the allow/deny buttons when expired', () => {
    render(
      <ApprovalCard
        part={pendingBashPart()}
        submitting={false}
        expired={true}
        onDecide={() => undefined}
      />,
    );
    expect(screen.getByText('已失效（超时或轮次已结束）')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /允许/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /拒绝/ }),
    ).not.toBeInTheDocument();
  });

  it('sets data-status="pending" normally and "expired" when expired (for e2e/style hooks)', () => {
    const { rerender } = render(
      <ApprovalCard
        part={pendingBashPart()}
        submitting={false}
        expired={false}
        onDecide={() => undefined}
      />,
    );
    expect(screen.getByTestId('approval-card')).toHaveAttribute(
      'data-status',
      'pending',
    );
    rerender(
      <ApprovalCard
        part={pendingBashPart()}
        submitting={false}
        expired={true}
        onDecide={() => undefined}
      />,
    );
    expect(screen.getByTestId('approval-card')).toHaveAttribute(
      'data-status',
      'expired',
    );
  });
});
