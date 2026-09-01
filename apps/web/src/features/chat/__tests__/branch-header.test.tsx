/**
 * 会话页功能条（docs/features/chat-ui.md「分支是这一页的标题」）。
 *
 * 守的是那次**优先级翻转**：主位给会话标题（用户起的名字，唯一有辨识度的东西），
 * 分支名缩写后退到行尾（它的用途是复制、不是阅读），仓库与 provider 收进详情
 * 弹窗（前者全局唯一、后者建会话时定死，都不该常驻）。缩写必须保留尾号——那是
 * 两条会话分支之间唯一的区别，截掉就全长一样了。
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import {
  abbreviateBranchName,
  BranchHeader,
} from '../components/branch-header';
import type { Conversation } from '../schema';

const LONG_BRANCH = 'nimbo/chat-84302082-770a-4dd3-aa7f-edcf60125fb1';

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1',
    title: 'test',
    repo: 'ludafa/Schulte-Grid',
    branchName: LONG_BRANCH,
    sandboxName: 'nimbo-chat-conv-1',
    provider: 'e2b',
    status: 'active',
    lastActiveAt: '2026-07-25T10:30:00.000Z',
    queuedMessages: [],
    availableSkills: [],
    turnInProgress: false,
    createdAt: '2026-07-24T08:00:00.000Z',
    ...overrides,
  };
}

describe('abbreviateBranchName', () => {
  it('长分支名中间省略，头尾都留着', () => {
    expect(abbreviateBranchName(LONG_BRANCH)).toBe('nimbo/chat-8430…5fb1');
  });

  it('保留尾号——那是两条会话分支唯一的区别，截尾等于让它们长得一样', () => {
    const a = abbreviateBranchName('nimbo/chat-84302082-770a-4dd3-aaaa-1111');
    const b = abbreviateBranchName('nimbo/chat-84302082-770a-4dd3-aaaa-2222');

    expect(a).not.toBe(b);
  });

  it.each(['main', 'feature/login-fix', 'nimbo/chat-abc'])(
    '短名 %s 原样显示，不省略',
    (name) => {
      expect(abbreviateBranchName(name)).toBe(name);
    },
  );
});

describe('BranchHeader', () => {
  it('主位是会话标题，不是分支名', () => {
    render(<BranchHeader conversation={conversation()} />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('test');
  });

  it('标题为空时退回「未命名会话」', () => {
    render(<BranchHeader conversation={conversation({ title: null })} />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      '未命名会话',
    );
  });

  it('分支名以缩写形式出现在行尾', () => {
    render(<BranchHeader conversation={conversation()} />);

    expect(screen.getByText('nimbo/chat-8430…5fb1')).toBeInTheDocument();
  });

  it('hover 分支名时先说清「这是 git 分支」，再给全名——光给全名仍看不出它是什么', async () => {
    const user = userEvent.setup();
    render(<BranchHeader conversation={conversation()} />);

    await user.hover(screen.getByText('nimbo/chat-8430…5fb1'));

    // base-ui 的 tooltip popup 不带 `role="tooltip"`，按内容找
    const tip = await screen.findByText('这个会话的 git 分支');
    expect(tip.closest('[data-slot="tooltip-content"]')).toHaveTextContent(
      LONG_BRANCH,
    );
  });

  it('复制的是完整分支名，不是屏幕上那个缩写', async () => {
    // user-event 的 setup() 自带 clipboard stub（jsdom 本身没有），读回来即可；
    // 整个 stubGlobal('navigator') 会把 user-event 依赖的其余部分一并换掉。
    const user = userEvent.setup();
    render(<BranchHeader conversation={conversation()} />);

    await user.click(screen.getByRole('button', { name: '复制分支名' }));

    await expect(navigator.clipboard.readText()).resolves.toBe(LONG_BRANCH);
  });

  it('仓库与 provider 不在功能条上（全局唯一 / 建会话时定死，都不该常驻）', () => {
    render(<BranchHeader conversation={conversation()} />);

    expect(screen.queryByText('ludafa/Schulte-Grid')).not.toBeInTheDocument();
    expect(screen.queryByText('e2b')).not.toBeInTheDocument();
  });

  it('它们在详情弹窗里——收起来，不是丢掉', async () => {
    const user = userEvent.setup();
    render(<BranchHeader conversation={conversation()} />);

    await user.click(screen.getByRole('button', { name: '会话详情' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('ludafa/Schulte-Grid')).toBeInTheDocument();
    expect(within(dialog).getByText('e2b')).toBeInTheDocument();
    // 弹窗里的分支名是全名，不缩写
    expect(within(dialog).getByText(LONG_BRANCH)).toBeInTheDocument();
    expect(within(dialog).getByText('活跃')).toBeInTheDocument();
  });
});
