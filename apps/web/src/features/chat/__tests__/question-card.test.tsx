import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { QuestionPart } from '../components/question-card';
import { QuestionCard } from '../components/question-card';

function pendingQuestion(input?: unknown): QuestionPart {
  return {
    type: 'tool-ask-user',
    toolCallId: 'call-1',
    state: 'input-available',
    input: input ?? { question: '用哪个颜色主题？', options: ['浅色', '深色'] },
  };
}

function answeredQuestion(answer: string): QuestionPart {
  return {
    type: 'tool-ask-user',
    toolCallId: 'call-1',
    state: 'output-available',
    input: { question: '用哪个颜色主题？' },
    output: answer,
  };
}

describe('QuestionCard — pending (input-available)', () => {
  it('renders the question text and a "待回答" badge', () => {
    render(
      <QuestionCard
        part={pendingQuestion()}
        submitting={false}
        expired={false}
        onAnswer={() => undefined}
      />,
    );
    expect(screen.getByText('用哪个颜色主题？')).toBeInTheDocument();
    expect(screen.getByText('待回答')).toBeInTheDocument();
  });

  it("renders one quick-option button per option; clicking it answers with that option's text", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    render(
      <QuestionCard
        part={pendingQuestion()}
        submitting={false}
        expired={false}
        onAnswer={onAnswer}
      />,
    );
    await user.click(screen.getByRole('button', { name: '深色' }));
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith('深色');
  });

  it('renders no option buttons when the input has no options (only the free-text send button)', () => {
    render(
      <QuestionCard
        part={pendingQuestion({ question: '你叫什么名字？' })}
        submitting={false}
        expired={false}
        onAnswer={() => undefined}
      />,
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAccessibleName('发送');
  });

  it('free-text submit calls onAnswer with the trimmed text and clears the input', async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    render(
      <QuestionCard
        part={pendingQuestion()}
        submitting={false}
        expired={false}
        onAnswer={onAnswer}
      />,
    );
    const input = screen.getByLabelText('回答');
    await user.type(input, '  自定义答案  ');
    await user.click(screen.getByRole('button', { name: '发送' }));
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith('自定义答案');
    expect(input).toHaveValue('');
  });

  it('the send button is disabled for empty/whitespace-only free text', async () => {
    const user = userEvent.setup();
    render(
      <QuestionCard
        part={pendingQuestion()}
        submitting={false}
        expired={false}
        onAnswer={() => undefined}
      />,
    );
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    await user.type(screen.getByLabelText('回答'), '   ');
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
  });

  it('disables the input, send button, and option buttons while submitting', () => {
    render(
      <QuestionCard
        part={pendingQuestion()}
        submitting={true}
        expired={false}
        onAnswer={() => undefined}
      />,
    );
    expect(screen.getByLabelText('回答')).toBeDisabled();
    expect(screen.getByRole('button', { name: '浅色' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '深色' })).toBeDisabled();
  });

  it('renders an expired notice and hides the answer controls when expired (even though the part itself is still pending)', () => {
    render(
      <QuestionCard
        part={pendingQuestion()}
        submitting={false}
        expired={true}
        onAnswer={() => undefined}
      />,
    );
    expect(screen.getByText('已失效（超时或轮次已结束）')).toBeInTheDocument();
    expect(screen.getByText('已失效')).toBeInTheDocument(); // the badge
    expect(screen.queryByLabelText('回答')).not.toBeInTheDocument();
  });
});

describe('QuestionCard — answered (output-available)', () => {
  it('renders the answer text and an "已回答" badge, with no answer controls', () => {
    render(
      <QuestionCard
        part={answeredQuestion('深色')}
        submitting={false}
        expired={false}
        onAnswer={() => undefined}
      />,
    );
    expect(screen.getByText('已回答')).toBeInTheDocument();
    expect(screen.getByText('你的回答：深色')).toBeInTheDocument();
    expect(screen.queryByLabelText('回答')).not.toBeInTheDocument();
  });

  it("still surfaces the real answer text even if the caller passes expired=true for an already-answered part (an unusual but structurally possible combination — `expired` comes from a separate 404 flag, not the part's own state)", () => {
    render(
      <QuestionCard
        part={answeredQuestion('浅色')}
        submitting={false}
        expired={true}
        onAnswer={() => undefined}
      />,
    );
    expect(screen.getByText('你的回答：浅色')).toBeInTheDocument();
  });

  it('falls back to a placeholder when the tool input is missing the question field', () => {
    render(
      <QuestionCard
        part={{ ...answeredQuestion('浅色'), input: {} }}
        submitting={false}
        expired={false}
        onAnswer={() => undefined}
      />,
    );
    expect(screen.getByText('（问题内容缺失）')).toBeInTheDocument();
  });
});
