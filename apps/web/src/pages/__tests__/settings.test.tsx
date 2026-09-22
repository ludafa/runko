/**
 * 设置页：选 [直播流](../../../../../docs/terms.md)走 SSE 还是 WebSocket。
 *
 * 守的是**点了真的换**——选择落到这台设备上，并且界面立刻显示新的那一档；不然用户
 * 点完看不出有没有生效，只能刷新页面猜。
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { getChatTransport } from '@/features/chat/transport';

import { SettingsPage } from '../settings';

function option(name: RegExp): HTMLElement {
  return screen.getByRole('radio', { name });
}

describe('设置页', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('默认选中 SSE', () => {
    render(<SettingsPage />);

    expect(option(/SSE/)).toHaveAttribute('aria-checked', 'true');
    expect(option(/WebSocket/)).toHaveAttribute('aria-checked', 'false');
  });

  it('**点 WebSocket 就换过去**，并记在这台设备上', async () => {
    const user = userEvent.setup();
    render(<SettingsPage />);

    await user.click(option(/WebSocket/));

    expect(getChatTransport()).toBe('ws');
    expect(option(/WebSocket/)).toHaveAttribute('aria-checked', 'true');
    expect(option(/SSE/)).toHaveAttribute('aria-checked', 'false');
  });

  it('切回 SSE 也是一样的一下', async () => {
    const user = userEvent.setup();
    render(<SettingsPage />);

    await user.click(option(/WebSocket/));
    await user.click(option(/SSE/));

    expect(getChatTransport()).toBe('sse');
    expect(option(/SSE/)).toHaveAttribute('aria-checked', 'true');
  });

  it('打开时显示的是上次选的那一档，不是永远从 SSE 开始', () => {
    window.localStorage.setItem('runko:chat-transport', 'ws');

    render(<SettingsPage />);

    expect(option(/WebSocket/)).toHaveAttribute('aria-checked', 'true');
  });
});
