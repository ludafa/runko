import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { QuestionCard } from '../components/question-card';
import type { QuestionTimelineEntry } from '../timeline';

function makeEntry(
  overrides: Partial<QuestionTimelineEntry> = {},
): QuestionTimelineEntry {
  return {
    kind: 'question',
    callId: 'q1',
    question: '要不要继续？',
    status: 'pending',
    seq: 1,
    ...overrides,
  };
}

describe('QuestionCard (docs/08 §2.2c（审批链）)', () => {
  it('renders a pending question with quick-reply option buttons', () => {
    render(
      <QuestionCard
        entry={makeEntry({ options: ['继续', '停止'] })}
        submitting={false}
        onAnswer={vi.fn()}
      />,
    );
    expect(screen.getByTestId('question-card')).toHaveAttribute(
      'data-status',
      'pending',
    );
    expect(screen.getByRole('button', { name: '继续' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '停止' })).toBeInTheDocument();
  });

  it('clicking an option button answers immediately, with no need to type into the free-text input first', () => {
    const onAnswer = vi.fn();
    render(
      <QuestionCard
        entry={makeEntry({ options: ['继续', '停止'] })}
        submitting={false}
        onAnswer={onAnswer}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '继续' }));

    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith('继续');
  });

  it('renders no quick-reply buttons when the question has no options — only the free-text input', () => {
    render(
      <QuestionCard
        entry={makeEntry()}
        submitting={false}
        onAnswer={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole('button', { name: '继续' }),
    ).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('输入你的回答…')).toBeInTheDocument();
  });

  it('typing free text and submitting answers with the trimmed text', () => {
    const onAnswer = vi.fn();
    render(
      <QuestionCard
        entry={makeEntry()}
        submitting={false}
        onAnswer={onAnswer}
      />,
    );

    const input = screen.getByPlaceholderText('输入你的回答…');
    fireEvent.change(input, { target: { value: '  用主题色吧。  ' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith('用主题色吧。');
  });

  it('disables the send button while the free-text input is empty', () => {
    render(
      <QuestionCard
        entry={makeEntry()}
        submitting={false}
        onAnswer={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
  });

  it('disables option buttons and the free-text input/send button while submitting', () => {
    render(
      <QuestionCard
        entry={makeEntry({ options: ['继续'] })}
        submitting
        onAnswer={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: '继续' })).toBeDisabled();
    expect(screen.getByPlaceholderText('输入你的回答…')).toBeDisabled();
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
  });

  it('renders an answered entry with its answer text, the "已回答" badge, and no interactive controls', () => {
    render(
      <QuestionCard
        entry={makeEntry({ status: 'answered', answer: '用主题色吧。' })}
        submitting={false}
        onAnswer={vi.fn()}
      />,
    );
    const card = screen.getByTestId('question-card');
    expect(card).toHaveAttribute('data-status', 'answered');
    expect(screen.getByText('已回答')).toBeInTheDocument();
    expect(card).toHaveTextContent('你的回答：用主题色吧。');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText('输入你的回答…'),
    ).not.toBeInTheDocument();
  });

  it('renders a timeout entry with the "已超时" badge and its own explanatory text', () => {
    render(
      <QuestionCard
        entry={makeEntry({ status: 'timeout' })}
        submitting={false}
        onAnswer={vi.fn()}
      />,
    );
    expect(screen.getByTestId('question-card')).toHaveAttribute(
      'data-status',
      'timeout',
    );
    expect(screen.getByText('已超时')).toBeInTheDocument();
    expect(
      screen.getByText(/未在时限内回答，agent 已继续/),
    ).toBeInTheDocument();
  });

  it('renders an expired entry with the "已失效" badge and its own explanatory text', () => {
    render(
      <QuestionCard
        entry={makeEntry({ status: 'expired' })}
        submitting={false}
        onAnswer={vi.fn()}
      />,
    );
    expect(screen.getByTestId('question-card')).toHaveAttribute(
      'data-status',
      'expired',
    );
    expect(screen.getByText('已失效')).toBeInTheDocument();
    expect(screen.getByText(/已失效（超时或轮次已结束）/)).toBeInTheDocument();
  });
});
