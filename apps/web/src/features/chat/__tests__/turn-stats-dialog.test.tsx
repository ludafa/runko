/**
 * TurnStatsButton（本轮统计按钮 + 弹窗，docs/tech/telemetry.md §4.2）：界面上只有
 * 一枚「统计」按钮，点开弹窗——概览来自账本 metadata（永远在），明细来自遥测端点
 * （首次打开才拉、按 (conversationId, turn) 拉、三态渲染、坏行静默跳过）；无查询键
 * 时弹窗只出概览、不发请求。api 模块整体 mock，不发真实请求。
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchTurnTelemetry } from '../api';
import { TurnStatsButton } from '../components/turn-stats-dialog';
import type { TurnTelemetryEvent } from '../schema';

vi.mock('../api', () => ({
  fetchTurnTelemetry: vi.fn(),
}));

const fetchMock = vi.mocked(fetchTurnTelemetry);

function telemetryEvents(): TurnTelemetryEvent[] {
  return [
    {
      eventType: 'model-call-end',
      ts: 1,
      payloadJson: JSON.stringify({
        modelId: 'deepseek-v4-pro',
        finishReason: 'stop',
        usage: {
          inputTokens: 13372,
          inputTokenDetails: { cacheReadTokens: 11520 },
          outputTokens: 1032,
          outputTokenDetails: { reasoningTokens: 471 },
          totalTokens: 14404,
        },
        performance: {
          responseTimeMs: 15399,
          timeToFirstOutputMs: 606,
          outputTokensPerSecond: 69.8,
          inputTokensPerSecond: 22036,
        },
      }),
    },
    {
      eventType: 'tool-execution-end',
      ts: 2,
      payloadJson: JSON.stringify({
        toolCall: { toolName: 'grep' },
        toolExecutionMs: 2100,
        toolOutput: { type: 'tool-result' },
      }),
    },
    {
      eventType: 'tool-execution-end',
      ts: 3,
      payloadJson: JSON.stringify({
        toolCall: { toolName: 'bash' },
        toolExecutionMs: 300,
        toolOutput: { type: 'tool-error' },
      }),
    },
    // 坏行：解析失败必须静默跳过，不毁掉整个弹窗。
    { eventType: 'model-call-end', ts: 4, payloadJson: 'not-json{' },
  ];
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('TurnStatsButton — 本轮统计弹窗', () => {
  it('无 conversationId/turn 时：按钮仍在，点开只出概览、永不发请求', async () => {
    const user = userEvent.setup();
    render(<TurnStatsButton usage={{ totalTokens: 10 }} durationMs={4200} />);

    await user.click(screen.getByTestId('turn-stats-button'));
    const dialog = await screen.findByTestId('turn-stats-dialog');
    expect(dialog.textContent).toContain('概览');
    expect(dialog.textContent).toContain('10 tokens'); // metadata 概览
    expect(dialog.textContent).toContain('此记录无遥测明细'); // 无明细提示
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('首次打开才按 (conversationId, turn) 拉取，渲染富字段模型调用与工具执行（坏行静默跳过）', async () => {
    fetchMock.mockResolvedValue(telemetryEvents());
    const user = userEvent.setup();
    render(
      <TurnStatsButton
        usage={{
          inputTokens: 72469,
          cachedInputTokens: 60288,
          totalTokens: 76379,
        }}
        durationMs={63000}
        toolDurationMs={7100}
        conversationId="chat-1"
        turn={3}
      />,
    );

    expect(fetchMock).not.toHaveBeenCalled(); // 打开前零请求
    await user.click(screen.getByTestId('turn-stats-button'));
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('chat-1', 3);

    const dialog = await screen.findByTestId('turn-stats-dialog');
    await waitFor(() => {
      expect(dialog.textContent).toContain('模型调用');
    });
    // 概览（账本 metadata）：耗时/工具/agent 拆分 + token 四分
    expect(dialog.textContent).toContain('72,469');
    expect(dialog.textContent).toContain('76,379 tokens');
    // 模型调用富字段
    expect(dialog.textContent).toContain('deepseek-v4-pro');
    expect(dialog.textContent).toContain('stop'); // finishReason
    expect(dialog.textContent).toContain('首 token 606ms'); // TTFT
    expect(dialog.textContent).toContain('69.8 tok/s');
    expect(dialog.textContent).toContain('缓存 11,520'); // 输入 token 三分
    expect(dialog.textContent).toContain('推理 471'); // 输出 token 三分
    // 工具执行
    expect(dialog.textContent).toContain('grep');
    expect(dialog.textContent).toContain('2.1s');
    expect(dialog.textContent).toContain('bash');
    expect(dialog.textContent).toContain('失败'); // tool-error 标记
  });

  it('反复开合不重复拉取（结果缓存在组件里）', async () => {
    fetchMock.mockResolvedValue([]);
    const user = userEvent.setup();
    render(
      <TurnStatsButton
        usage={{ totalTokens: 10 }}
        conversationId="chat-1"
        turn={1}
      />,
    );

    const button = screen.getByTestId('turn-stats-button');
    await user.click(button);
    await screen.findByText('无遥测数据');
    await user.keyboard('{Escape}'); // 关闭
    await waitFor(() => {
      expect(screen.queryByTestId('turn-stats-dialog')).toBeNull();
    });
    await user.click(button); // 再打开
    await screen.findByText('无遥测数据');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('拉取失败显示“遥测数据加载失败”，概览本身不受影响', async () => {
    fetchMock.mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    render(
      <TurnStatsButton
        usage={{ totalTokens: 10 }}
        durationMs={4200}
        conversationId="chat-1"
        turn={1}
      />,
    );

    await user.click(screen.getByTestId('turn-stats-button'));
    const dialog = await screen.findByTestId('turn-stats-dialog');
    await screen.findByText('遥测数据加载失败');
    expect(dialog.textContent).toContain('10 tokens'); // 概览仍在
  });
});

describe('TurnStatsButton — 概览格式化（账本 metadata，无需遥测）', () => {
  it('耗时首位、工具/agent 拆分、token 千分位', async () => {
    const user = userEvent.setup();
    render(
      <TurnStatsButton
        usage={{
          inputTokens: 149_326,
          cachedInputTokens: 122_624,
          outputTokens: 6_212,
          totalTokens: 155_538,
        }}
        durationMs={83_000}
        toolDurationMs={33_000}
      />,
    );
    await user.click(screen.getByTestId('turn-stats-button'));
    const dialog = await screen.findByTestId('turn-stats-dialog');
    const text = dialog.textContent ?? '';
    expect(text).toContain('1m 23s'); // 全 turn 墙钟
    expect(text).toContain('33.0s'); // 工具
    expect(text).toContain('50.0s'); // agent = 83s - 33s
    expect(text).toContain('149,326');
    expect(text).toContain('122,624');
    expect(text).toContain('6,212');
    expect(text).toContain('155,538 tokens');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('纯文本轮（toolDurationMs 0）隐藏工具/agent 拆分', async () => {
    const user = userEvent.setup();
    render(
      <TurnStatsButton
        usage={{ totalTokens: 10 }}
        durationMs={4_200}
        toolDurationMs={0}
      />,
    );
    await user.click(screen.getByTestId('turn-stats-button'));
    const dialog = await screen.findByTestId('turn-stats-dialog');
    const text = dialog.textContent ?? '';
    expect(text).toContain('4.2s');
    expect(text).not.toContain('agent');
    expect(text).toContain('10 tokens');
  });

  it('旧记录（无 durationMs）省略耗时段，只出 token', async () => {
    const user = userEvent.setup();
    render(<TurnStatsButton usage={{ totalTokens: 10 }} />);
    await user.click(screen.getByTestId('turn-stats-button'));
    const dialog = await screen.findByTestId('turn-stats-dialog');
    const text = dialog.textContent ?? '';
    expect(text).toContain('10 tokens');
    expect(text).not.toContain('耗时');
  });
});
