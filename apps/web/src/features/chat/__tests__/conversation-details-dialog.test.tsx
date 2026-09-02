/**
 * 会话详情弹窗（docs/features/chat-ui.md「仓库与沙盒类型收进会话详情弹窗」）。
 *
 * 两件事：**详情 tab 只留会话真正独有的标识**（标题在功能条上已经是主位、沙盒名
 * 是 sandboxName 的实现细节，都不重复放这儿）；**统计 tab 汇总整个会话**——数据
 * 全部来自账本 metadata 现算，不发请求。汇总里最容易写错的是「没有值」与「值是
 * 0」的区别：旧记录不带 `durationMs`，那一行该整行不显示，而不是显示 0ms。
 */
import type { RunkoUIMessage } from '@runko/core';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import {
  ConversationDetailsDialog,
  summarizeConversation,
} from '../components/conversation-details-dialog';
import type { Conversation } from '../schema';

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1',
    title: 'New chat',
    repo: 'ludafa/Schulte-Grid',
    branchName: 'runko/chat-03b0163c-b8cb-474b-b132-ed82c5b1a6e3',
    sandboxName: 'runko-chat-03b0163c-b8cb-474b-b132-ed82c5b1a6e3',
    provider: 'e2b',
    status: 'sleeping',
    lastActiveAt: '2026-07-25T16:37:00.000Z',
    queuedMessages: [],
    availableSkills: [],
    turnInProgress: false,
    createdAt: '2026-07-19T20:23:00.000Z',
    ...overrides,
  };
}

/** 一条收尾的 assistant 消息——会话统计只认带 `metadata.status` 的那些。 */
function turn(
  metadata: NonNullable<RunkoUIMessage['metadata']>,
  id = Math.random().toString(36).slice(2),
): RunkoUIMessage {
  return { id, role: 'assistant', metadata, parts: [] };
}

async function openTab(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: '会话详情' }));
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('tab', { name }));
  return dialog;
}

describe('summarizeConversation', () => {
  it('把多轮的耗时与 token 累加起来', () => {
    const stats = summarizeConversation([
      turn({
        status: 'completed',
        durationMs: 1000,
        toolDurationMs: 400,
        usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
      }),
      turn({
        status: 'completed',
        durationMs: 2000,
        toolDurationMs: 600,
        usage: { inputTokens: 200, outputTokens: 20, totalTokens: 220 },
      }),
    ]);

    expect(stats).toMatchObject({
      completedTurns: 2,
      failedTurns: 0,
      durationMs: 3000,
      toolDurationMs: 1000,
      inputTokens: 300,
      outputTokens: 30,
      totalTokens: 330,
    });
  });

  it('失败轮单独计数，但耗时与 token 照样计入——那些是真花掉的', () => {
    const stats = summarizeConversation([
      turn({
        status: 'completed',
        durationMs: 1000,
        usage: { totalTokens: 5 },
      }),
      turn({
        status: 'failed',
        error: { code: 'provider_error', message: '模型服务返回 429' },
        durationMs: 500,
        usage: { totalTokens: 3 },
      }),
    ]);

    expect(stats.completedTurns).toBe(1);
    expect(stats.failedTurns).toBe(1);
    expect(stats.durationMs).toBe(1500);
    expect(stats.totalTokens).toBe(8);
  });

  it('没有 metadata.status 的消息（用户消息、进行中的轮）不计入', () => {
    const stats = summarizeConversation([
      { id: 'u1', role: 'user', parts: [] },
      turn({ steered: true }),
      turn({ status: 'completed', durationMs: 100 }),
    ]);

    expect(stats.completedTurns).toBe(1);
    expect(stats.failedTurns).toBe(0);
  });

  it('全程没有某个字段就保持 undefined——「旧记录没记」不能显示成 0', () => {
    const stats = summarizeConversation([turn({ status: 'completed' })]);

    expect(stats.durationMs).toBeUndefined();
    expect(stats.totalTokens).toBeUndefined();
  });

  it('空会话就是全 0/undefined，不炸', () => {
    expect(summarizeConversation([])).toMatchObject({
      completedTurns: 0,
      failedTurns: 0,
      durationMs: undefined,
    });
  });
});

describe('ConversationDetailsDialog — 详情 tab', () => {
  it('留下分支、仓库、沙盒 provider、状态与时间', async () => {
    const user = userEvent.setup();
    render(<ConversationDetailsDialog conversation={conversation()} />);

    await user.click(screen.getByRole('button', { name: '会话详情' }));
    const dialog = await screen.findByRole('dialog');

    expect(
      within(dialog).getByText(
        'runko/chat-03b0163c-b8cb-474b-b132-ed82c5b1a6e3',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('ludafa/Schulte-Grid')).toBeInTheDocument();
    expect(within(dialog).getByText('e2b')).toBeInTheDocument();
    expect(within(dialog).getByText('休眠')).toBeInTheDocument();
  });

  it('不再重复会话标题——功能条上它已经是主位了', async () => {
    const user = userEvent.setup();
    render(<ConversationDetailsDialog conversation={conversation()} />);

    await user.click(screen.getByRole('button', { name: '会话详情' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).queryByText('New chat')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('标题')).not.toBeInTheDocument();
  });

  it('不显示沙盒名——那是实现细节，与分支名只差个前缀', async () => {
    const user = userEvent.setup();
    render(<ConversationDetailsDialog conversation={conversation()} />);

    await user.click(screen.getByRole('button', { name: '会话详情' }));
    const dialog = await screen.findByRole('dialog');

    expect(
      within(dialog).queryByText(
        'runko-chat-03b0163c-b8cb-474b-b132-ed82c5b1a6e3',
      ),
    ).not.toBeInTheDocument();
  });
});

describe('ConversationDetailsDialog — 统计 tab', () => {
  it('显示整个会话的汇总，不是单轮', async () => {
    const user = userEvent.setup();
    render(
      <ConversationDetailsDialog
        conversation={conversation()}
        messages={[
          turn({
            status: 'completed',
            durationMs: 60_000,
            toolDurationMs: 20_000,
            usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 },
          }),
          turn({
            status: 'completed',
            durationMs: 30_000,
            toolDurationMs: 10_000,
            usage: { inputTokens: 500, outputTokens: 50, totalTokens: 550 },
          }),
        ]}
      />,
    );

    const dialog = await openTab(user, '统计');

    expect(within(dialog).getByText('2')).toBeInTheDocument(); // 轮数
    expect(within(dialog).getByText('1,650')).toBeInTheDocument(); // 共计 tokens
    // 工具 30s，agent = 90s - 30s = 60s
    expect(within(dialog).getByText('30.0s')).toBeInTheDocument();
    expect(within(dialog).getByText('1m 0s')).toBeInTheDocument();
  });

  it('还没跑过一轮时给一句话，不是一堆 0', async () => {
    const user = userEvent.setup();
    render(
      <ConversationDetailsDialog conversation={conversation()} messages={[]} />,
    );

    const dialog = await openTab(user, '统计');

    expect(
      within(dialog).getByText('这个会话还没有跑完过一轮。'),
    ).toBeInTheDocument();
  });

  it('有失败轮时标出来', async () => {
    const user = userEvent.setup();
    render(
      <ConversationDetailsDialog
        conversation={conversation()}
        messages={[
          turn({ status: 'completed', durationMs: 100 }),
          turn({
            status: 'failed',
            error: { code: 'provider_error', message: '模型服务返回 429' },
            durationMs: 50,
          }),
        ]}
      />,
    );

    const dialog = await openTab(user, '统计');

    expect(within(dialog).getByText(/1 轮失败/)).toBeInTheDocument();
  });
});
