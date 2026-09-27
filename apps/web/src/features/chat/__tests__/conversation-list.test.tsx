/**
 * `SessionList` 新建会话弹窗的「仓库」栏接线（docs/ingress/features/github-repo-access.md
 * §2.1/§2.4，docs/ingress/tech/github-repo-access.md §5、§9「提交按钮的可用性」）：
 *
 * - 仓库这一栏只在选中云沙盒（`e2b`/`vercel`）时出现，本地沙盒没有。
 * - 提交按钮：云沙盒必须选到一个仓库才能提交；本地沙盒不受这一栏影响。
 * - 切到本地会清掉已选的仓库；切回云沙盒是重新挂载 `GithubRepoPicker`
 *   （`{cloud && <GithubRepoPicker .../>}` 条件渲染，不是隐藏），会重新走一遍
 *   状态查询 + 列仓库。
 *
 * 只 mock `GithubRepoPicker` 依赖的 `../api`，不 mock `SessionList` 或
 * `GithubRepoPicker` 本身。
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatConfig, GithubRepo, GithubStatus } from '../schema';

const { fetchGithubStatusMock, fetchGithubReposMock } = vi.hoisted(() => ({
  fetchGithubStatusMock:
    vi.fn<(signal?: AbortSignal) => Promise<GithubStatus>>(),
  fetchGithubReposMock:
    vi.fn<(signal?: AbortSignal) => Promise<GithubRepo[]>>(),
}));

vi.mock('../api', () => ({
  fetchGithubStatus: (signal?: AbortSignal) => fetchGithubStatusMock(signal),
  fetchGithubRepos: (signal?: AbortSignal) => fetchGithubReposMock(signal),
}));

const { SessionList } = await import('../components/conversation-list');

function chatConfig(overrides: Partial<ChatConfig> = {}): ChatConfig {
  return {
    providers: ['vercel', 'e2b', 'local'],
    defaultProvider: 'local',
    model: 'deepseek',
    ...overrides,
  };
}

function status(overrides: Partial<GithubStatus> = {}): GithubStatus {
  return {
    configured: true,
    linked: true,
    installUrl: 'https://github.com/apps/demo-app/installations/new',
    ...overrides,
  };
}

function repo(overrides: Partial<GithubRepo> = {}): GithubRepo {
  return {
    installationId: 1,
    repoId: 100,
    fullName: 'acme/demo',
    private: false,
    defaultBranch: 'main',
    ...overrides,
  };
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '新建会话' }));
  return screen.findByRole('dialog');
}

function submitButton(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByRole('button', { name: '建会话并开分支' });
}

beforeEach(() => {
  fetchGithubStatusMock.mockReset();
  fetchGithubReposMock.mockReset();
});

describe('SessionList — 仓库栏只在云沙盒（e2b/vercel）出现', () => {
  it('默认 provider 是 local 时，弹窗里没有仓库栏，也不发请求', async () => {
    const user = userEvent.setup();
    render(
      <SessionList
        conversations={[]}
        activeSessionId={undefined}
        onCreate={vi.fn()}
        pendingTitle={undefined}
        chatConfig={chatConfig({ defaultProvider: 'local' })}
      />,
    );
    const dialog = await openDialog(user);

    expect(within(dialog).queryByText('仓库')).not.toBeInTheDocument();
    expect(fetchGithubStatusMock).not.toHaveBeenCalled();
    // 本地沙盒不需要选仓库，按钮从一开始就可以提交
    expect(submitButton(dialog)).toBeEnabled();
  });

  it('切到 e2b：仓库栏出现，发起状态查询', async () => {
    fetchGithubStatusMock.mockResolvedValue(status());
    fetchGithubReposMock.mockResolvedValue([repo()]);
    const user = userEvent.setup();
    render(
      <SessionList
        conversations={[]}
        activeSessionId={undefined}
        onCreate={vi.fn()}
        pendingTitle={undefined}
        chatConfig={chatConfig({ defaultProvider: 'local' })}
      />,
    );
    const dialog = await openDialog(user);

    await user.click(within(dialog).getByRole('button', { name: /E2B/ }));

    expect(within(dialog).getByText('仓库')).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchGithubStatusMock).toHaveBeenCalledTimes(1);
    });
  });

  it('切到 vercel：仓库栏同样出现', async () => {
    fetchGithubStatusMock.mockResolvedValue(status());
    fetchGithubReposMock.mockResolvedValue([repo()]);
    const user = userEvent.setup();
    render(
      <SessionList
        conversations={[]}
        activeSessionId={undefined}
        onCreate={vi.fn()}
        pendingTitle={undefined}
        chatConfig={chatConfig({ defaultProvider: 'local' })}
      />,
    );
    const dialog = await openDialog(user);

    await user.click(within(dialog).getByRole('button', { name: /Vercel/ }));

    expect(within(dialog).getByText('仓库')).toBeInTheDocument();
  });
});

describe('SessionList — 提交按钮的可用性矩阵', () => {
  it('云沙盒 + 还没选到仓库（列表为空）：按钮禁用', async () => {
    fetchGithubStatusMock.mockResolvedValue(status());
    fetchGithubReposMock.mockResolvedValue([]); // 空列表——不会自动选中任何仓库
    const user = userEvent.setup();
    render(
      <SessionList
        conversations={[]}
        activeSessionId={undefined}
        onCreate={vi.fn()}
        pendingTitle={undefined}
        chatConfig={chatConfig({ defaultProvider: 'e2b' })}
      />,
    );
    const dialog = await openDialog(user);

    await screen.findByText(/还没有勾选过任何仓库/);
    expect(submitButton(dialog)).toBeDisabled();
  });

  it('云沙盒 + 已经选到仓库（自动选中第一个）：按钮可用', async () => {
    fetchGithubStatusMock.mockResolvedValue(status());
    fetchGithubReposMock.mockResolvedValue([repo()]);
    const user = userEvent.setup();
    render(
      <SessionList
        conversations={[]}
        activeSessionId={undefined}
        onCreate={vi.fn()}
        pendingTitle={undefined}
        chatConfig={chatConfig({ defaultProvider: 'e2b' })}
      />,
    );
    const dialog = await openDialog(user);

    await waitFor(() => {
      expect(submitButton(dialog)).toBeEnabled();
    });
  });

  it('本地沙盒：不管仓库栏（根本没有），按钮恒可用', async () => {
    const user = userEvent.setup();
    render(
      <SessionList
        conversations={[]}
        activeSessionId={undefined}
        onCreate={vi.fn()}
        pendingTitle={undefined}
        chatConfig={chatConfig({ defaultProvider: 'local' })}
      />,
    );
    const dialog = await openDialog(user);

    expect(submitButton(dialog)).toBeEnabled();
  });
});

describe('SessionList — provider 切换对仓库选择的影响', () => {
  it('云沙盒选中仓库后切到本地：仓库栏消失，提交时 repo 参数变回 undefined', async () => {
    fetchGithubStatusMock.mockResolvedValue(status());
    fetchGithubReposMock.mockResolvedValue([repo()]);
    const onCreate = vi.fn();
    const user = userEvent.setup();
    render(
      <SessionList
        conversations={[]}
        activeSessionId={undefined}
        onCreate={onCreate}
        pendingTitle={undefined}
        chatConfig={chatConfig({ defaultProvider: 'e2b' })}
      />,
    );
    const dialog = await openDialog(user);

    // 先等云沙盒自动选中仓库、按钮可用
    await waitFor(() => {
      expect(submitButton(dialog)).toBeEnabled();
    });

    // 切到本地：仓库栏整个消失（GithubRepoPicker 卸载），按钮依旧可用（本地不需要仓库）
    await user.click(within(dialog).getByRole('button', { name: /本地/ }));
    expect(within(dialog).queryByText('仓库')).not.toBeInTheDocument();
    expect(submitButton(dialog)).toBeEnabled();

    // 直接看提交结果——这是「切到本地清掉仓库」这件事唯一要紧的可观察后果：
    // 传给 onCreate 的 repo 参数必须变回 undefined，而不是还带着切走前选的那个。
    await user.click(submitButton(dialog));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith(
      expect.any(String),
      'local',
      undefined,
    );
  });

  it('本地切回云沙盒：GithubRepoPicker 是重新挂载（不是隐藏复显），会重新发一遍请求', async () => {
    fetchGithubStatusMock.mockResolvedValue(status());
    fetchGithubReposMock.mockResolvedValue([repo()]);
    const user = userEvent.setup();
    render(
      <SessionList
        conversations={[]}
        activeSessionId={undefined}
        onCreate={vi.fn()}
        pendingTitle={undefined}
        chatConfig={chatConfig({ defaultProvider: 'e2b' })}
      />,
    );
    const dialog = await openDialog(user);
    await waitFor(() => {
      expect(fetchGithubStatusMock).toHaveBeenCalledTimes(1);
    });

    await user.click(within(dialog).getByRole('button', { name: /本地/ }));
    await user.click(within(dialog).getByRole('button', { name: /E2B/ }));

    // 调用次数证明这是「新的一轮请求」，而不是复用了切走之前挂着的那个实例的结果——
    // 如果 GithubRepoPicker 没被卸载重挂载，这里不会再多发一次。
    await waitFor(() => {
      expect(fetchGithubStatusMock).toHaveBeenCalledTimes(2);
    });
    expect(fetchGithubReposMock).toHaveBeenCalledTimes(2);
    await waitFor(() => {
      expect(submitButton(dialog)).toBeEnabled();
    });
  });
});
