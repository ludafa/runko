/**
 * 建会话等待反馈（docs/app/chat-ui/feature.md「建会话的等待反馈」）。
 *
 * 两件要守住的事：阶段按已等待时长推进、**最后一阶段不会自己走完**（服务端没有
 * 真进度可推，走完等于骗人）；以及失败态真的显示得出来——此前 `handleCreate`
 * 只有 `finally` 没有 `catch`，建会话失败是完全静默的。
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ProvisioningError,
  ProvisioningView,
} from '../components/provisioning-view';

const T0 = 1_700_000_000_000;

/** 挂载在「已经等了 elapsedMs」的那一刻。 */
function renderAt(elapsedMs: number) {
  vi.setSystemTime(T0 + elapsedMs);
  return render(
    <ProvisioningView title="重构登录页" provider="e2b" startedAt={T0} />,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ProvisioningView', () => {
  it('一挂载就显示标题和 provider（点击那一刻就知道在建什么）', () => {
    renderAt(0);

    expect(screen.getByText('重构登录页')).toBeInTheDocument();
    expect(screen.getByText('e2b')).toBeInTheDocument();
  });

  it('标题为空时退回「新会话」，不显示空白', () => {
    vi.setSystemTime(T0);
    render(<ProvisioningView title="" provider="vercel" startedAt={T0} />);

    expect(screen.getByText('新会话')).toBeInTheDocument();
  });

  it('四个阶段一开始就全列出来（让人看见总共要几步）', () => {
    renderAt(0);

    for (const label of [
      '创建沙盒',
      '拉取仓库代码',
      '安装 frontend-design 技能',
      '准备工作分支',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it.each([
    [0, '创建沙盒'],
    [2_000, '拉取仓库代码'],
    [4_000, '安装 frontend-design 技能'],
    [8_000, '准备工作分支'],
  ])('等了 %i ms 时，当前阶段是「%s」', (elapsedMs, expectedLabel) => {
    renderAt(elapsedMs);

    // 当前阶段是唯一带秒数计时的那一行
    const seconds = `${String(Math.floor(elapsedMs / 1000))}s`;
    const row = screen.getByText(expectedLabel).closest('li');
    expect(row).not.toBeNull();
    expect(row).toHaveTextContent(seconds);
  });

  it('最后一个阶段停在原地，不会自己走完（没有真进度就不假装完成）', () => {
    renderAt(120_000); // 两分钟，远超任何预估

    const row = screen.getByText('准备工作分支').closest('li');
    expect(row).toHaveTextContent('120s');
    // 没有任何「完成/就绪」的说法冒出来
    expect(screen.queryByText(/已就绪|完成/)).not.toBeInTheDocument();
  });

  it('拖太久时承认「比平时久」，而不是继续假装正常', () => {
    renderAt(25_000);

    expect(screen.getByText(/比平时久一些/)).toBeInTheDocument();
  });

  it('正常时长内不提前喊慢', () => {
    renderAt(5_000);

    expect(screen.queryByText(/比平时久一些/)).not.toBeInTheDocument();
  });

  it('秒数随时间自己往前走（等待期间界面不是静止的）', async () => {
    renderAt(1_000);
    expect(screen.getByText('1s')).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(3_000);

    expect(screen.getByText('4s')).toBeInTheDocument();
  });
});

describe('ProvisioningError', () => {
  it('把失败原因显示出来（此前这里完全静默）', () => {
    render(
      <ProvisioningError
        title="重构登录页"
        message="E2B_API_KEY 未配置"
        onRetry={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/没能为「重构登录页」准备好工作区/),
    ).toBeInTheDocument();
    expect(screen.getByText('E2B_API_KEY 未配置')).toBeInTheDocument();
  });

  it('重试与返回各自回调', async () => {
    const onRetry = vi.fn();
    const onDismiss = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <ProvisioningError
        title="x"
        message="boom"
        onRetry={onRetry}
        onDismiss={onDismiss}
      />,
    );

    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: '返回' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
