/**
 * 建会话的乐观切换（docs/app/chat-ui/feature.md「建会话的等待反馈」）。
 *
 * 这里守的是「乐观」二字：点击后**在 `POST /conversations` 还挂着的时候**会话区
 * 就得已经变成准备中——所以下面的 promise 都是手动控制 resolve 时机的，先断言
 * 「还没 resolve 但界面已经切了」，再放行。以及失败路径：此前 `handleCreate`
 * 只有 `finally` 没有 `catch`，请求一挂就静默吞掉，界面毫无变化。
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Conversation } from '../schema';

const { createConversationMock, listConversationsMock, navigateMock } =
  vi.hoisted(() => ({
    createConversationMock: vi.fn(),
    listConversationsMock: vi.fn(),
    navigateMock: vi.fn(),
  }));

vi.mock('@/features/chat/api', () => ({
  createConversation: (...args: unknown[]) => createConversationMock(...args),
  listConversations: (...args: unknown[]) => listConversationsMock(...args),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
  Link: ({
    children,
    ...rest
  }: {
    children: React.ReactNode;
    className?: string;
  }) => <a {...rest}>{children}</a>,
}));

const { ChatLayout } = await import('@/layouts/chat-layout');

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-new',
    title: '重构登录页',
    repo: 'acme/demo',
    branchName: 'nimbo/conv-new',
    sandboxName: 'nimbo-chat-conv-new',
    provider: 'e2b',
    status: 'active',
    lastActiveAt: new Date(0).toISOString(),
    queuedMessages: [],
    availableSkills: [],
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

/** 一个由测试决定何时 resolve/reject 的 promise。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 打开新建表单并提交。 */
async function submitCreate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '新建会话' }));
  await user.type(
    screen.getByPlaceholderText('这次要做什么？（可选）'),
    '重构登录页',
  );
  await user.click(screen.getByRole('button', { name: '建会话并开分支' }));
}

beforeEach(() => {
  createConversationMock.mockReset();
  listConversationsMock.mockReset();
  navigateMock.mockReset();
  listConversationsMock.mockResolvedValue([]);
  navigateMock.mockResolvedValue(undefined);
});

describe('ChatLayout — 建会话', () => {
  it('新建入口是弹窗，不是挤在 220px 侧栏里的内嵌表单', async () => {
    const user = userEvent.setup();
    render(
      <ChatLayout activeSessionId={undefined}>
        <p>之前的会话内容</p>
      </ChatLayout>,
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '新建会话' })).toBeEnabled();
    });

    // 没点开之前，表单不在 DOM 里
    expect(
      screen.queryByPlaceholderText('这次要做什么？（可选）'),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '新建会话' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('新建会话');
    expect(
      screen.getByPlaceholderText('这次要做什么？（可选）'),
    ).toBeInTheDocument();
    // provider 在弹窗里放得下说明文字了
    expect(screen.getByText(/空闲自动暂停/)).toBeInTheDocument();
  });

  it('提交后弹窗自己关掉（等待反馈在会话区，弹窗留着会挡住它）', async () => {
    createConversationMock.mockReturnValue(deferred<Conversation>().promise);
    const user = userEvent.setup();
    render(
      <ChatLayout activeSessionId={undefined}>
        <p>之前的会话内容</p>
      </ChatLayout>,
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '新建会话' })).toBeEnabled();
    });

    await submitCreate(user);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.getByText('准备工作分支')).toBeInTheDocument();
  });

  it('「取消」关掉弹窗且不发请求', async () => {
    const user = userEvent.setup();
    render(
      <ChatLayout activeSessionId={undefined}>
        <p>之前的会话内容</p>
      </ChatLayout>,
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '新建会话' })).toBeEnabled();
    });
    await user.click(screen.getByRole('button', { name: '新建会话' }));
    await screen.findByRole('dialog');

    await user.click(screen.getByRole('button', { name: '取消' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(createConversationMock).not.toHaveBeenCalled();
    expect(screen.getByText('之前的会话内容')).toBeInTheDocument();
  });

  it('点击后立刻进入准备中，不等服务端返回', async () => {
    const pending = deferred<Conversation>();
    createConversationMock.mockReturnValue(pending.promise);
    const user = userEvent.setup();

    render(
      <ChatLayout activeSessionId={undefined}>
        <p>之前的会话内容</p>
      </ChatLayout>,
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '新建会话' })).toBeEnabled();
    });

    await submitCreate(user);

    // 请求还挂着（没 resolve），但会话区已经换成准备中了——这就是「乐观」
    expect(screen.getByText('准备工作分支')).toBeInTheDocument();
    expect(screen.getByText(/正在准备工作区/)).toBeInTheDocument();
    expect(screen.queryByText('之前的会话内容')).not.toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('返回 201 后跳到新会话，准备中收起', async () => {
    const pending = deferred<Conversation>();
    createConversationMock.mockReturnValue(pending.promise);
    const user = userEvent.setup();

    render(
      <ChatLayout activeSessionId={undefined}>
        <p>之前的会话内容</p>
      </ChatLayout>,
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '新建会话' })).toBeEnabled();
    });
    await submitCreate(user);

    pending.resolve(conversation());

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith({
        to: '/chat/$conversationId',
        params: { conversationId: 'conv-new' },
      });
    });
    expect(screen.queryByText('准备工作分支')).not.toBeInTheDocument();
  });

  it('请求失败时把错误显示出来（此前是静默吞掉的）', async () => {
    const pending = deferred<Conversation>();
    createConversationMock.mockReturnValue(pending.promise);
    const user = userEvent.setup();

    render(
      <ChatLayout activeSessionId={undefined}>
        <p>之前的会话内容</p>
      </ChatLayout>,
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '新建会话' })).toBeEnabled();
    });
    await submitCreate(user);

    pending.reject(new Error('E2B_API_KEY 未配置'));

    await waitFor(() => {
      expect(screen.getByText('E2B_API_KEY 未配置')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('重试用原来的输入再发一次', async () => {
    const first = deferred<Conversation>();
    createConversationMock.mockReturnValueOnce(first.promise);
    const user = userEvent.setup();

    render(
      <ChatLayout activeSessionId={undefined}>
        <p>之前的会话内容</p>
      </ChatLayout>,
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '新建会话' })).toBeEnabled();
    });
    await submitCreate(user);
    first.reject(new Error('boom'));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    });

    const second = deferred<Conversation>();
    createConversationMock.mockReturnValueOnce(second.promise);
    await user.click(screen.getByRole('button', { name: '重试' }));

    expect(createConversationMock).toHaveBeenCalledTimes(2);
    expect(createConversationMock.mock.calls[1]?.[0]).toEqual(
      createConversationMock.mock.calls[0]?.[0],
    );
    // 又回到准备中，而不是停在错误页
    expect(screen.getByText('准备工作分支')).toBeInTheDocument();
  });

  it('「返回」关掉错误、放行原本的会话区内容', async () => {
    const pending = deferred<Conversation>();
    createConversationMock.mockReturnValue(pending.promise);
    const user = userEvent.setup();

    render(
      <ChatLayout activeSessionId={undefined}>
        <p>之前的会话内容</p>
      </ChatLayout>,
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '新建会话' })).toBeEnabled();
    });
    await submitCreate(user);
    pending.reject(new Error('boom'));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '返回' })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: '返回' }));

    expect(screen.getByText('之前的会话内容')).toBeInTheDocument();
  });
});
