/**
 * `GithubRepoPicker` 状态机（docs/ingress/features/github-repo-access.md §2.1，
 * docs/ingress/tech/github-repo-access.md §5、§9「前端：新建会话弹窗的四种状态
 * （没配 App / 没连 / 没仓库 / 有仓库）与提交按钮的可用性」）。
 *
 * 只 mock 组件的两个外部边界——`../api`（`fetchGithubStatus`/`fetchGithubRepos`）
 * 与 `@/lib/auth-client`（`authClient.linkSocial`）——不 mock 组件内部逻辑。
 *
 * `GithubRepoPicker` 是受控组件（`value`/`onChange` 由父组件持有），所以这里用一个
 * 小 `Picker` 包装组件自己持有 `useState`，贴近它在 `SessionList` 里的真实用法。
 */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GithubRepo, GithubRepoRef, GithubStatus } from '../schema';

const { fetchGithubStatusMock, fetchGithubReposMock, linkSocialMock } =
  vi.hoisted(() => ({
    fetchGithubStatusMock:
      vi.fn<(signal?: AbortSignal) => Promise<GithubStatus>>(),
    fetchGithubReposMock:
      vi.fn<(signal?: AbortSignal) => Promise<GithubRepo[]>>(),
    linkSocialMock:
      vi.fn<
        (input: { provider: string; callbackURL: string }) => Promise<undefined>
      >(),
  }));

vi.mock('../api', () => ({
  fetchGithubStatus: (signal?: AbortSignal) => fetchGithubStatusMock(signal),
  fetchGithubRepos: (signal?: AbortSignal) => fetchGithubReposMock(signal),
}));

vi.mock('@/lib/auth-client', () => ({
  authClient: {
    linkSocial: (input: { provider: string; callbackURL: string }) =>
      linkSocialMock(input),
  },
}));

const { GithubRepoPicker } = await import('../components/github-repo-picker');
const { ChatApiError } = await import('../api-error');

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
    fullName: 'acme/one',
    private: false,
    defaultBranch: 'main',
    ...overrides,
  };
}

/** 贴近真实用法的受控包装：`GithubRepoPicker` 自己不持有 `value`，父组件才有。 */
function Picker({
  initial,
  onChangeSpy,
}: {
  initial?: GithubRepoRef;
  onChangeSpy: (repo: GithubRepoRef | undefined) => void;
}) {
  const [value, setValue] = useState<GithubRepoRef | undefined>(initial);
  return (
    <GithubRepoPicker
      value={value}
      onChange={(next) => {
        setValue(next);
        onChangeSpy(next);
      }}
    />
  );
}

/** 一个由测试摆布 resolve 时机、且会在 `signal` 被 abort 时自动 reject 的假请求——
 * 贴近真实 `fetch(url, { signal })` 在被中止时的行为（reject 一个 AbortError，
 * 而不是悬着或正常 resolve），组件的 stale-response 丢弃逻辑正是靠这一点成立的。 */
interface Controllable<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function controllableFetch<T>(
  signal: AbortSignal | undefined,
): Controllable<T> {
  let resolveFn: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    resolveFn = resolve;
    signal?.addEventListener(
      'abort',
      () => {
        reject(new DOMException('aborted', 'AbortError'));
      },
      { once: true },
    );
  });
  return { promise, resolve: (value: T) => resolveFn(value) };
}

beforeEach(() => {
  fetchGithubStatusMock.mockReset();
  fetchGithubReposMock.mockReset();
  linkSocialMock.mockReset();
});

describe('GithubRepoPicker — loading', () => {
  it('挂载时先展示「正在检查连接状态」，不发仓库请求', () => {
    fetchGithubStatusMock.mockReturnValue(new Promise<GithubStatus>(() => {}));
    render(<Picker onChangeSpy={vi.fn()} />);

    expect(screen.getByText('正在检查 GitHub 连接状态…')).toBeInTheDocument();
    expect(fetchGithubReposMock).not.toHaveBeenCalled();
  });
});

describe('GithubRepoPicker — status-error（状态查询本身失败）', () => {
  it('展示错误信息与「重试」，不发仓库请求；重试后重新走完整条链路', async () => {
    fetchGithubStatusMock.mockRejectedValueOnce(new Error('网络错误'));
    const user = userEvent.setup();
    render(<Picker onChangeSpy={vi.fn()} />);

    expect(await screen.findByText('网络错误')).toBeInTheDocument();
    expect(fetchGithubReposMock).not.toHaveBeenCalled();

    fetchGithubStatusMock.mockResolvedValueOnce(status());
    fetchGithubReposMock.mockResolvedValueOnce([repo()]);
    await user.click(screen.getByRole('button', { name: '重试' }));

    expect(fetchGithubStatusMock).toHaveBeenCalledTimes(2);
    await waitFor(() => {
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });
  });
});

describe('GithubRepoPicker — not-configured（服务端没配 GitHub App）', () => {
  it('提示未配置，不出现连接/仓库相关控件，不发仓库请求', async () => {
    fetchGithubStatusMock.mockResolvedValueOnce(
      status({ configured: false, linked: false, installUrl: null }),
    );
    render(<Picker onChangeSpy={vi.fn()} />);

    expect(
      await screen.findByText(/服务端还没配置 GitHub App/),
    ).toBeInTheDocument();
    expect(fetchGithubReposMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('GithubRepoPicker — not-linked（配了 App 但没连 GitHub）', () => {
  it('展示「连接 GitHub」，点击调用 linkSocial({provider:"github", callbackURL})', async () => {
    fetchGithubStatusMock.mockResolvedValueOnce(
      status({ configured: true, linked: false, installUrl: null }),
    );
    const user = userEvent.setup();
    render(<Picker onChangeSpy={vi.fn()} />);

    const connectButton = await screen.findByRole('button', {
      name: '连接 GitHub',
    });
    expect(fetchGithubReposMock).not.toHaveBeenCalled();

    await user.click(connectButton);

    expect(linkSocialMock).toHaveBeenCalledWith({
      provider: 'github',
      callbackURL: window.location.href,
    });
  });
});

describe('GithubRepoPicker — repos-error（状态查询成功，仓库列表失败）', () => {
  it('与 status-error 走不同分支，展示安装链接；重试会把两个接口都重新发一遍', async () => {
    fetchGithubStatusMock.mockResolvedValueOnce(
      status({
        installUrl: 'https://github.com/apps/demo-app/installations/new',
      }),
    );
    fetchGithubReposMock.mockRejectedValueOnce(new Error('仓库列表加载失败'));
    const user = userEvent.setup();
    render(<Picker onChangeSpy={vi.fn()} />);

    expect(await screen.findByText('仓库列表加载失败')).toBeInTheDocument();
    const installLink = screen.getByRole('link', { name: '去 GitHub 选仓库' });
    expect(installLink).toHaveAttribute(
      'href',
      'https://github.com/apps/demo-app/installations/new',
    );
    expect(installLink).toHaveAttribute('target', '_blank');
    expect(installLink).toHaveAttribute('rel', 'noreferrer');

    fetchGithubStatusMock.mockResolvedValueOnce(status());
    fetchGithubReposMock.mockResolvedValueOnce([repo()]);
    await user.click(screen.getByRole('button', { name: '重试' }));

    await waitFor(() => {
      expect(fetchGithubStatusMock).toHaveBeenCalledTimes(2);
    });
    expect(fetchGithubReposMock).toHaveBeenCalledTimes(2);
  });
});

describe('GithubRepoPicker — ready 且仓库列表为空', () => {
  it('展示安装链接 + 刷新，不渲染下拉框；刷新后拿到仓库就换成下拉框', async () => {
    fetchGithubStatusMock.mockResolvedValueOnce(status());
    fetchGithubReposMock.mockResolvedValueOnce([]);
    const user = userEvent.setup();
    render(<Picker onChangeSpy={vi.fn()} />);

    expect(await screen.findByText(/还没有勾选过任何仓库/)).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    const installLink = screen.getByRole('link', { name: '去 GitHub 选仓库' });
    expect(installLink).toHaveAttribute('target', '_blank');
    expect(installLink).toHaveAttribute('rel', 'noreferrer');

    fetchGithubStatusMock.mockResolvedValueOnce(status());
    fetchGithubReposMock.mockResolvedValueOnce([repo()]);
    await user.click(screen.getByText('刷新'));

    await waitFor(() => {
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });
  });

  it('installUrl 为 null 时不渲染安装链接（防御：ready 阶段理论上恒有值，但 schema 允许 null）', async () => {
    fetchGithubStatusMock.mockResolvedValueOnce(status({ installUrl: null }));
    fetchGithubReposMock.mockResolvedValueOnce([]);
    render(<Picker onChangeSpy={vi.fn()} />);

    await screen.findByText(/还没有勾选过任何仓库/);
    expect(
      screen.queryByRole('link', { name: '去 GitHub 选仓库' }),
    ).not.toBeInTheDocument();
  });
});

describe('GithubRepoPicker — ready 且有仓库：自动选中与手动切换', () => {
  it('列表到手、value 未选时自动选中第一个', async () => {
    const onChangeSpy = vi.fn();
    fetchGithubStatusMock.mockResolvedValueOnce(status());
    fetchGithubReposMock.mockResolvedValueOnce([
      repo({ repoId: 100, fullName: 'acme/one' }),
      repo({ repoId: 200, fullName: 'acme/two' }),
    ]);
    render(<Picker onChangeSpy={onChangeSpy} />);

    await waitFor(() => {
      expect(onChangeSpy).toHaveBeenCalledWith({
        installationId: 1,
        repoId: 100,
      });
    });
    expect(onChangeSpy).toHaveBeenCalledTimes(1);
  });

  it('下拉框收起时显示仓库名，不显示内部用的 `installationId:repoId`', async () => {
    fetchGithubStatusMock.mockResolvedValueOnce(status());
    fetchGithubReposMock.mockResolvedValueOnce([
      repo({ repoId: 100, fullName: 'acme/one' }),
      repo({ repoId: 200, fullName: 'acme/two' }),
    ]);
    render(
      <Picker
        initial={{ installationId: 1, repoId: 200 }}
        onChangeSpy={vi.fn()}
      />,
    );

    const trigger = await screen.findByRole('combobox');
    await waitFor(() => {
      expect(trigger).toHaveTextContent('acme/two');
    });
    expect(trigger).not.toHaveTextContent('1:200');
  });

  it('已经选过仓库时不会被自动选中覆盖', async () => {
    const onChangeSpy = vi.fn();
    fetchGithubStatusMock.mockResolvedValueOnce(status());
    fetchGithubReposMock.mockResolvedValueOnce([
      repo({ repoId: 100, fullName: 'acme/one' }),
      repo({ repoId: 200, fullName: 'acme/two' }),
    ]);
    render(
      <Picker
        initial={{ installationId: 1, repoId: 200 }}
        onChangeSpy={onChangeSpy}
      />,
    );

    await screen.findByRole('combobox');
    expect(onChangeSpy).not.toHaveBeenCalled();
  });

  it('手动在下拉框里切换会触发 onChange，带上新仓库的 {installationId, repoId}', async () => {
    const onChangeSpy = vi.fn();
    fetchGithubStatusMock.mockResolvedValueOnce(status());
    fetchGithubReposMock.mockResolvedValueOnce([
      repo({ repoId: 100, fullName: 'acme/one' }),
      repo({ repoId: 200, fullName: 'acme/two', private: true }),
    ]);
    const user = userEvent.setup();
    render(<Picker onChangeSpy={onChangeSpy} />);

    // 等自动选中第一个先落地，避免下面这次手动切换跟自动选中的那次调用混在一起断言
    await waitFor(() => {
      expect(onChangeSpy).toHaveBeenCalledWith({
        installationId: 1,
        repoId: 100,
      });
    });

    await user.click(screen.getByRole('combobox'));
    const listbox = await screen.findByRole('listbox');
    await user.click(within(listbox).getByText('acme/two'));

    expect(onChangeSpy).toHaveBeenLastCalledWith({
      installationId: 1,
      repoId: 200,
    });
  });
});

describe('GithubRepoPicker — GitHub 授权失效与选中项失效', () => {
  it('仓库列表回 409（授权被撤销、令牌续不上）：回到「连接 GitHub」这一步', async () => {
    fetchGithubStatusMock.mockResolvedValueOnce(status());
    fetchGithubReposMock.mockRejectedValueOnce(
      new ChatApiError(409, 'github_not_linked'),
    );
    render(<Picker onChangeSpy={vi.fn()} />);

    expect(
      await screen.findByRole('button', { name: '连接 GitHub' }),
    ).toBeInTheDocument();
  });

  it('刷新后选中的仓库不在新列表里：换成新列表的第一个', async () => {
    const onChangeSpy = vi.fn();
    fetchGithubStatusMock.mockResolvedValue(status());
    fetchGithubReposMock
      .mockResolvedValueOnce([
        repo({ repoId: 100, fullName: 'acme/one' }),
        repo({ repoId: 200, fullName: 'acme/two' }),
      ])
      .mockResolvedValueOnce([repo({ repoId: 300, fullName: 'acme/three' })]);
    render(
      <Picker
        initial={{ installationId: 1, repoId: 200 }}
        onChangeSpy={onChangeSpy}
      />,
    );
    await screen.findByRole('combobox');
    expect(onChangeSpy).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => {
      expect(onChangeSpy).toHaveBeenLastCalledWith({
        installationId: 1,
        repoId: 300,
      });
    });
  });

  it('刷新后列表空了：清掉选中项', async () => {
    const onChangeSpy = vi.fn();
    fetchGithubStatusMock.mockResolvedValue(status());
    fetchGithubReposMock
      .mockResolvedValueOnce([repo({ repoId: 100, fullName: 'acme/one' })])
      .mockResolvedValueOnce([]);
    render(
      <Picker
        initial={{ installationId: 1, repoId: 100 }}
        onChangeSpy={onChangeSpy}
      />,
    );
    await screen.findByRole('combobox');

    await userEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => {
      expect(onChangeSpy).toHaveBeenLastCalledWith(undefined);
    });
  });
});

describe('GithubRepoPicker — 刷新的去重竞态', () => {
  it('同一瞬间触发两次刷新：先发的那次被中止，只有后发的落地', async () => {
    fetchGithubStatusMock.mockResolvedValueOnce(status());
    fetchGithubReposMock.mockResolvedValueOnce([
      repo({ repoId: 100, fullName: 'acme/one' }),
    ]);
    render(<Picker onChangeSpy={vi.fn()} />);
    await screen.findByRole('combobox');

    let stale: Controllable<GithubStatus> | undefined;
    let fresh: Controllable<GithubStatus> | undefined;
    fetchGithubStatusMock
      .mockImplementationOnce((signal) => {
        stale = controllableFetch<GithubStatus>(signal);
        return stale.promise;
      })
      .mockImplementationOnce((signal) => {
        fresh = controllableFetch<GithubStatus>(signal);
        return fresh.promise;
      });

    const refreshButton = screen.getByText('刷新');
    // 两次点击必须落在同一个 act() 里：只有这样，第二次点击时组件仍是刷新前的
    // DOM/state（refresh 按钮还在），才谈得上「先发的那次请求正在飞、被后一次中止」——
    // 分两次 fireEvent 调用的话，第一次点击已经把它 flush 成 loading 阶段，
    // 那个阶段没有任何按钮，物理上点不到第二次。
    act(() => {
      fireEvent.click(refreshButton);
      fireEvent.click(refreshButton);
    });

    expect(fetchGithubStatusMock).toHaveBeenCalledTimes(3); // 挂载 1 次 + 这里 2 次

    fresh?.resolve(
      status({ installUrl: 'https://fresh.example/installations/new' }),
    );
    // 仓库 id 与刷新前保持一致（同一个仓库），只改 fullName——模拟「两次刷新之间
    // 仓库改了名」，用来证明落地的是 fresh 这次返回的数据。
    fetchGithubReposMock.mockResolvedValueOnce([
      repo({ repoId: 100, fullName: 'acme/one-renamed' }),
    ]);

    // 断言走「打开下拉框看选项文字」这条路，不看触发器闭合状态下的文本——base-ui
    // 的 `SelectValue` 在 jsdom 里闭合时只回退显示裸的 value 字符串（这里是
    // `"1:100"`），要展开过一次列表才拿得到 `SelectItem` 渲染的 `fullName`。
    const user = userEvent.setup();
    await waitFor(() => {
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('combobox'));
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByText('acme/one-renamed')).toBeInTheDocument();
    await user.keyboard('{Escape}');

    // 先发的那次仓库请求应当从未发生——它的状态请求在到达「再去查仓库」这步之前
    // 就已经被 abort 拒绝掉了。
    expect(fetchGithubReposMock).toHaveBeenCalledTimes(2); // 挂载 1 次 + fresh 这次
    const installLink = screen.getByRole('link', { name: '去 GitHub 选仓库' });
    expect(installLink).toHaveAttribute(
      'href',
      'https://fresh.example/installations/new',
    );

    // 事后才让 stale 的响应“到达”——它已经被 abort 早早 reject 过，这里应当
    // 什么都不会发生（既不报错，也不会把画面翻回 stale 的数据）。
    stale?.resolve(
      status({ installUrl: 'https://stale.example/installations/new' }),
    );
    await Promise.resolve();
    expect(installLink).toHaveAttribute(
      'href',
      'https://fresh.example/installations/new',
    );
  });
});
