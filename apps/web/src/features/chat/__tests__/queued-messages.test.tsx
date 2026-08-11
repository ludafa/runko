import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { QueuedMessages } from '../components/queued-messages';
import type { QueuedMessage } from '../schema';

function queued(id: string, text: string): QueuedMessage {
  return { id, text, userId: 'user-1', createdAt: 1_700_000_000_000 };
}

/** 待发区（docs/agent/steer-and-queue/feature.md §2.3）：列出、删一条、清空；空队列整块不渲染。 */
describe('QueuedMessages', () => {
  it('队列为空时什么都不渲染（不留占位）', () => {
    const { container } = render(
      <QueuedMessages
        messages={[]}
        onRemove={() => undefined}
        onClear={() => undefined}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('按顺序列出待发消息并显示条数', () => {
    render(
      <QueuedMessages
        messages={[queued('q1', '第一件'), queued('q2', '第二件')]}
        onRemove={() => undefined}
        onClear={() => undefined}
      />,
    );

    expect(screen.getByText(/2 条待发/)).toBeInTheDocument();
    const items = screen.getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('第一件'),
      expect.stringContaining('第二件'),
    ]);
  });

  it('点某条的 × 用它自己的 id 调 onRemove', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(
      <QueuedMessages
        messages={[queued('q1', '第一件'), queued('q2', '第二件')]}
        onRemove={onRemove}
        onClear={() => undefined}
      />,
    );

    await user.click(screen.getByLabelText('删除待发消息：第二件'));

    expect(onRemove).toHaveBeenCalledExactlyOnceWith('q2');
  });

  it('点清空调 onClear', async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    render(
      <QueuedMessages
        messages={[queued('q1', '第一件')]}
        onRemove={() => undefined}
        onClear={onClear}
      />,
    );

    await user.click(screen.getByRole('button', { name: '清空' }));

    expect(onClear).toHaveBeenCalledOnce();
  });
});
