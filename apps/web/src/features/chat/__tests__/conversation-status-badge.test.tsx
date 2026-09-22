/**
 * 会话状态点（docs/ingress/tech/unified-demo.md §4.3「会话状态」）。
 *
 * 守的是一件事：[本地沙盒](../../../../../../docs/terms.md)不会休眠，所以
 * `displayConversationStatus` 要把 `sleeping` 就地折回 `active`——不管服务端
 * 实际给的是什么，展示层不该让本地沙盒显示「休眠」。
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  displayConversationStatus,
  StatusDot,
} from '../components/conversation-status-badge';

describe('displayConversationStatus', () => {
  it('本地沙盒的 sleeping 折回 active', () => {
    expect(displayConversationStatus('sleeping', 'local')).toBe('active');
  });

  it('本地沙盒的 active/expired 原样透传', () => {
    expect(displayConversationStatus('active', 'local')).toBe('active');
    expect(displayConversationStatus('expired', 'local')).toBe('expired');
  });

  it('云沙盒（vercel/e2b）的 sleeping 原样透传，不受影响', () => {
    expect(displayConversationStatus('sleeping', 'vercel')).toBe('sleeping');
    expect(displayConversationStatus('sleeping', 'e2b')).toBe('sleeping');
  });
});

describe('StatusDot', () => {
  it('本地沙盒即使 status=sleeping，也画成「活跃」', () => {
    render(<StatusDot status="sleeping" provider="local" />);

    expect(screen.getByRole('img', { name: '活跃' })).toBeInTheDocument();
  });

  it('云沙盒 status=sleeping 照常画成「休眠」', () => {
    render(<StatusDot status="sleeping" provider="e2b" />);

    expect(screen.getByRole('img', { name: '休眠' })).toBeInTheDocument();
  });
});
