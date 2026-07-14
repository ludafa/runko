import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ApprovalCard } from '../components/approval-card';
import type { ApprovalTimelineEntry } from '../timeline';

function makeEntry(
  overrides: Partial<ApprovalTimelineEntry> = {},
): ApprovalTimelineEntry {
  return {
    kind: 'approval',
    callId: 'call_1',
    toolName: 'bash',
    input: { command: 'git push origin main' },
    status: 'pending',
    seq: 1,
    ...overrides,
  };
}

describe('ApprovalCard (docs/08 §2.2c（审批链）)', () => {
  it('renders a pending approval with clickable Allow/Deny buttons that call onDecide', () => {
    const onDecide = vi.fn();
    render(
      <ApprovalCard
        entry={makeEntry()}
        submitting={false}
        onDecide={onDecide}
      />,
    );

    const card = screen.getByTestId('approval-card');
    expect(card).toHaveAttribute('data-status', 'pending');

    const allowButton = screen.getByRole('button', { name: /允许/ });
    const denyButton = screen.getByRole('button', { name: /拒绝/ });
    expect(allowButton).toBeEnabled();
    expect(denyButton).toBeEnabled();

    fireEvent.click(allowButton);
    expect(onDecide).toHaveBeenCalledWith('allow');

    fireEvent.click(denyButton);
    expect(onDecide).toHaveBeenCalledWith('deny');
  });

  it('disables both Allow/Deny buttons while submitting', () => {
    render(<ApprovalCard entry={makeEntry()} submitting onDecide={vi.fn()} />);
    expect(screen.getByRole('button', { name: /允许/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /拒绝/ })).toBeDisabled();
  });

  it('renders an allowed entry with the "已允许" badge and no action buttons', () => {
    render(
      <ApprovalCard
        entry={makeEntry({ status: 'allowed' })}
        submitting={false}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByTestId('approval-card')).toHaveAttribute(
      'data-status',
      'allowed',
    );
    expect(screen.getByText('已允许')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders a denied entry with its deny message and the "已拒绝" badge', () => {
    render(
      <ApprovalCard
        entry={makeEntry({ status: 'denied', message: '太危险了' })}
        submitting={false}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByTestId('approval-card')).toHaveAttribute(
      'data-status',
      'denied',
    );
    expect(screen.getByText('已拒绝')).toBeInTheDocument();
    expect(screen.getByText(/拒绝原因：太危险了/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders an expired entry with its own explanatory text and no action buttons', () => {
    render(
      <ApprovalCard
        entry={makeEntry({ status: 'expired' })}
        submitting={false}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByTestId('approval-card')).toHaveAttribute(
      'data-status',
      'expired',
    );
    expect(screen.getByText(/已失效（超时或轮次已结束）/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders a bash command as a <pre> block, not a generic JSON preview', () => {
    render(
      <ApprovalCard
        entry={makeEntry({ input: { command: 'rm -rf build' } })}
        submitting={false}
        onDecide={vi.fn()}
      />,
    );
    const commandNode = screen.getByText('rm -rf build');
    expect(commandNode.tagName).toBe('PRE');
    expect(screen.queryByText('Parameters')).not.toBeInTheDocument();
  });

  it('renders a non-bash tool input as a pretty-printed JSON preview under a "Parameters" heading', () => {
    render(
      <ApprovalCard
        entry={makeEntry({
          toolName: 'write_file',
          input: { path: 'a.ts', content: 'x' },
        })}
        submitting={false}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByText('Parameters')).toBeInTheDocument();
    expect(screen.getByText(/"path": "a.ts"/)).toBeInTheDocument();
  });
});
