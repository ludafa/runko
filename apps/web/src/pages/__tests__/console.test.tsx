/**
 * [集群控制台](../../../../../docs/terms.md)页面（`../console.tsx`）。用户可见行为见
 * docs/host/node/features/cluster-console.md §3；数据形状见
 * docs/host/node/tech/cluster-console.md §8、§9；施工验收见
 * docs/host/node/plans/cluster-console.md O5。
 *
 * `../../features/console/api` 整个被 mock 掉：这里测的是页面怎么把
 * `ConsoleOverview` 翻成界面（状态→按钮、确认框文案、倒计时、分组、busy），
 * 不测真的 fetch/zod 校验（那些是 `api.ts` 自己的事，manifest 走的是同一套生成
 * schema，已经在 `apps/node-server` 一侧连同 wire 形状一起测过）。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ConsoleConversation,
  ConsoleNode,
  ConsoleOverview,
} from '../../features/console/api';

const { fetchConsoleOverviewMock, postNodeOfflineMock, postNodeOnlineMock } =
  vi.hoisted(() => ({
    fetchConsoleOverviewMock: vi.fn(),
    postNodeOfflineMock: vi.fn(),
    postNodeOnlineMock: vi.fn(),
  }));

vi.mock('../../features/console/api', () => ({
  fetchConsoleOverview: (...args: unknown[]) =>
    fetchConsoleOverviewMock(...args),
  postNodeOffline: (...args: unknown[]) => postNodeOfflineMock(...args),
  postNodeOnline: (...args: unknown[]) => postNodeOnlineMock(...args),
}));

const { ConsolePage } = await import('../console');

const NOW = 1_700_000_000_000;

/** 功能手册 §3.3：下线确认框要把三个时间点写清楚，一字不差。 */
const OFFLINE_CONFIRM_TEXT =
  '这个节点将不再接新请求；正在跑的轮最多再给 1 分 30 秒自然跑完，之后会被中止；2 分钟后进程还在就强杀。';

function node(overrides: Partial<ConsoleNode> = {}): ConsoleNode {
  return {
    id: 'node-1',
    index: 1,
    url: 'http://node-1:3900',
    state: 'online',
    dockerState: 'running',
    offlineDeadline: null,
    ...overrides,
  };
}

function conversation(
  overrides: Partial<ConsoleConversation> = {},
): ConsoleConversation {
  return {
    id: 'conv-1',
    title: '重构登录页',
    ownerEmail: 'alice@example.com',
    holder: 'http://node-1:3900',
    heartbeatAt: NOW,
    stale: false,
    ...overrides,
  };
}

function overview(overrides: Partial<ConsoleOverview> = {}): ConsoleOverview {
  return {
    controllable: true,
    nodes: [node()],
    conversations: [],
    now: NOW,
    ...overrides,
  };
}

/** 一个由测试决定何时 resolve 的 promise——造「mutation 还在飞」的中间状态。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ConsolePage />
    </QueryClientProvider>,
  );
}

/** 从整页文本里抠倒计时——`meta.label` 是「图标 + 文字」混排，逐元素找容易被
 * testing-library 的多重匹配坑到，直接读渲染出来的纯文本更稳。 */
function readCountdownSeconds(): number {
  const text = document.body.textContent ?? '';
  const match = /下线中\s*(\d+):(\d{2})/.exec(text);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error('页面上没找到下线倒计时文案');
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

beforeEach(() => {
  fetchConsoleOverviewMock.mockReset();
  postNodeOfflineMock.mockReset();
  postNodeOnlineMock.mockReset();
  postNodeOfflineMock.mockResolvedValue({ ok: true, offlineDeadline: NOW });
  postNodeOnlineMock.mockResolvedValue({ ok: true });
});

describe('ConsolePage — 状态到按钮的映射', () => {
  it('online 节点：下线要二次确认，文案与功能手册 §3.3 一致', async () => {
    fetchConsoleOverviewMock.mockResolvedValue(
      overview({ nodes: [node({ state: 'online' })] }),
    );
    const user = userEvent.setup();
    renderPage();

    const trigger = await screen.findByRole('button', { name: '下线' });
    await user.click(trigger);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(OFFLINE_CONFIRM_TEXT);
    expect(postNodeOfflineMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '确认下线' }));
    expect(postNodeOfflineMock).toHaveBeenCalledWith('node-1');
  });

  it('unknown 节点：同样是下线要二次确认（不是直接执行）', async () => {
    fetchConsoleOverviewMock.mockResolvedValue(
      overview({
        nodes: [node({ state: 'unknown', dockerState: 'restarting' })],
      }),
    );
    const user = userEvent.setup();
    renderPage();

    const trigger = await screen.findByRole('button', { name: '下线' });
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(OFFLINE_CONFIRM_TEXT);
  });

  it('取消不发请求', async () => {
    fetchConsoleOverviewMock.mockResolvedValue(
      overview({ nodes: [node({ state: 'online' })] }),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: '下线' }));
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: '取消' }));

    // base-ui 关闭有退场动画，`role="dialog"` 那个节点不会立刻从 DOM 消失
    // （先进 `data-closed`/`data-ending-style`），得等它真的被卸载。
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(postNodeOfflineMock).not.toHaveBeenCalled();
  });

  it('offline 节点：显示「重新上线」，点了不需要确认框，直接发请求', async () => {
    fetchConsoleOverviewMock.mockResolvedValue(
      overview({ nodes: [node({ state: 'offline', dockerState: 'exited' })] }),
    );
    const user = userEvent.setup();
    renderPage();

    const trigger = await screen.findByRole('button', { name: '重新上线' });
    await user.click(trigger);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(postNodeOnlineMock).toHaveBeenCalledWith('node-1');
  });

  it('下线请求失败：页面上显示错误，不是静默', async () => {
    fetchConsoleOverviewMock.mockResolvedValue(
      overview({ nodes: [node({ state: 'online' })] }),
    );
    postNodeOfflineMock.mockRejectedValue(new Error('连不上运维容器'));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: '下线' }));
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: '确认下线' }));

    expect(await screen.findByText('下线失败')).toBeInTheDocument();
    expect(screen.getByText('连不上运维容器')).toBeInTheDocument();
  });

  it('上线请求失败：页面上显示错误', async () => {
    fetchConsoleOverviewMock.mockResolvedValue(
      overview({ nodes: [node({ state: 'offline', dockerState: 'exited' })] }),
    );
    postNodeOnlineMock.mockRejectedValue(new Error('没有这个节点'));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: '重新上线' }));

    expect(await screen.findByText('上线失败')).toBeInTheDocument();
    expect(screen.getByText('没有这个节点')).toBeInTheDocument();
  });

  it('going_offline 节点：不显示任何按钮，只有 m:ss 倒计时，且每秒往下走', async () => {
    fetchConsoleOverviewMock.mockResolvedValue(
      overview({
        nodes: [
          node({
            state: 'going_offline',
            offlineDeadline: NOW + 65_000, // 1:05
          }),
        ],
      }),
    );
    renderPage();

    await waitFor(() => {
      expect(readCountdownSeconds()).toBe(65);
    });
    expect(
      screen.queryByRole('button', { name: '下线' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '重新上线' }),
    ).not.toBeInTheDocument();

    // 真等它走一秒以上（`useServerClock` 用的是真的 `setInterval`），
    // 不掺假计时器，避免跟 react-query 的异步刷新互相打架。
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    await waitFor(() => {
      expect(readCountdownSeconds()).toBeLessThan(65);
    });
  }, 10_000);
});

describe('ConsolePage — controllable: false', () => {
  it('按钮全部 disabled，并显示说明条', async () => {
    fetchConsoleOverviewMock.mockResolvedValue(
      overview({ controllable: false, nodes: [node({ state: 'online' })] }),
    );
    renderPage();

    const trigger = await screen.findByRole('button', { name: '下线' });
    expect(trigger).toBeDisabled();
    expect(screen.getByText('这台服务端不能控制节点')).toBeInTheDocument();
    expect(screen.getByText(/这台服务端没有配置运维容器/)).toBeInTheDocument();
  });
});

describe('ConsolePage — opsError 提示条优先于「不可控」提示条', () => {
  it('opsError 存在时只显示 opsError 那条，不显示「不能控制节点」', async () => {
    fetchConsoleOverviewMock.mockResolvedValue(
      overview({
        controllable: false,
        nodes: [node({ state: 'online' })],
        opsError: '连不上运维容器：ECONNREFUSED',
      }),
    );
    renderPage();

    await screen.findByText('连不上运维容器');
    expect(screen.getByText(/ECONNREFUSED/)).toBeInTheDocument();
    expect(
      screen.queryByText('这台服务端不能控制节点'),
    ).not.toBeInTheDocument();
  });
});

describe('ConsolePage — 未知节点分组', () => {
  it('holder 对不上任何节点 url 的会话，进「未知节点」分组，不挂在任何节点卡片下', async () => {
    fetchConsoleOverviewMock.mockResolvedValue(
      overview({
        nodes: [node({ id: 'node-1', url: 'http://node-1:3900' })],
        conversations: [
          conversation({
            id: 'conv-ghost',
            title: '孤儿会话',
            holder: 'http://ghost-node:3900',
          }),
        ],
      }),
    );
    renderPage();

    await screen.findByText('未知节点');
    expect(screen.getByText('孤儿会话')).toBeInTheDocument();
    // 已知节点卡片下面没有会话（显示的是空态文案）。
    expect(screen.getByText('没有会话挂在这个节点下')).toBeInTheDocument();
  });
});

describe('ConsolePage — 点 A 下线时只有 A 的按钮 busy', () => {
  it('B 的下线按钮照常可点', async () => {
    fetchConsoleOverviewMock.mockResolvedValue(
      overview({
        nodes: [
          node({ id: 'node-a', index: 1, url: 'http://node-a:3900' }),
          node({ id: 'node-b', index: 2, url: 'http://node-b:3900' }),
        ],
      }),
    );
    const pendingOffline = deferred<{ ok: true; offlineDeadline: number }>();
    postNodeOfflineMock.mockReturnValue(pendingOffline.promise);

    const user = userEvent.setup();
    renderPage();

    const triggers = await screen.findAllByRole('button', { name: '下线' });
    expect(triggers).toHaveLength(2);

    await user.click(triggers[0] as HTMLElement);
    await user.click(await screen.findByRole('button', { name: '确认下线' }));

    await waitFor(() => {
      const [triggerA, triggerB] = screen.getAllByRole('button', {
        name: '下线',
      });
      expect(triggerA).toBeDisabled();
      expect(triggerB).not.toBeDisabled();
    });

    expect(postNodeOfflineMock).toHaveBeenCalledWith('node-a');
    expect(postNodeOfflineMock).not.toHaveBeenCalledWith('node-b');
  });
});
