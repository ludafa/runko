/**
 * `ToolCallCard`'s tool-timing strip (chat 可观测性：启动/完成时间 + 耗时,
 * `timing?: ToolTimingData` prop, `message-entry.tsx`'s `findToolTiming`
 * join) — display states driven entirely by `timing`/`part.state`,围绕
 * `@nimbo/core` 三段生命周期（startedAt 入队 → executionStartedAt 真实执行 →
 * completedAt 结算）：queued（等待中徽标 + 已等待跳动）、running（执行起点 +
 * 逐秒跳动）、settled（静态，耗时 = 真实执行时长）、denied（未执行）、legacy
 * fallback（无 executionStartedAt 的存量记录退回全程口径）、crash residue
 * （"—"，不跳动）。`timing` itself absent renders no strip at all — already
 * covered by `timeline-view.test.tsx`'s own join test; this file drives
 * `ToolCallCard` directly instead of through the full timeline to pin the
 * ticking behavior precisely.
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ToolCallCard } from '../components/tool-call-card';
import type { NimboToolPart } from '../timeline';

function runningPart(): NimboToolPart {
  return {
    type: 'tool-bash',
    toolCallId: 'call-1',
    state: 'input-available',
    input: { command: 'ls' },
  };
}

function settledPart(): NimboToolPart {
  return {
    type: 'tool-bash',
    toolCallId: 'call-1',
    state: 'output-available',
    input: { command: 'ls' },
    output: 'a.txt',
  };
}

function erroredPart(): NimboToolPart {
  return {
    type: 'tool-bash',
    toolCallId: 'call-1',
    state: 'output-error',
    input: { command: 'ls' },
    errorText: 'boom',
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ToolCallCard — no timing data', () => {
  it('renders no tool-timing strip at all when timing is undefined', () => {
    render(<ToolCallCard part={settledPart()} />);
    expect(screen.queryByTestId('tool-timing')).not.toBeInTheDocument();
  });
});

describe('ToolCallCard — settled (completedAt present)', () => {
  it('shows a static "start → complete · duration" strip, using the humanized duration ladder', () => {
    render(
      <ToolCallCard
        part={settledPart()}
        timing={{
          toolCallId: 'call-1',
          startedAt: new Date(2024, 0, 1, 10, 0, 0).getTime(),
          completedAt: new Date(2024, 0, 1, 10, 0, 1, 500).getTime(),
        }}
      />,
    );
    const strip = screen.getByTestId('tool-timing');
    expect(strip.textContent).toBe('10:00:00 → 10:00:01 · 1.5s');
  });

  it('does not tick — advancing fake timers leaves the settled strip’s text unchanged', () => {
    vi.useFakeTimers();
    render(
      <ToolCallCard
        part={settledPart()}
        timing={{
          toolCallId: 'call-1',
          startedAt: new Date(2024, 0, 1, 10, 0, 0).getTime(),
          completedAt: new Date(2024, 0, 1, 10, 0, 1).getTime(),
        }}
      />,
    );
    const before = screen.getByTestId('tool-timing').textContent;
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByTestId('tool-timing').textContent).toBe(before);
  });

  it('uses the real execution window when executionStartedAt is present — queue wait (startedAt → executionStartedAt) excluded from both the start label and the duration', () => {
    render(
      <ToolCallCard
        part={settledPart()}
        timing={{
          toolCallId: 'call-1',
          startedAt: new Date(2024, 0, 1, 10, 0, 0).getTime(),
          executionStartedAt: new Date(2024, 0, 1, 10, 0, 8).getTime(),
          completedAt: new Date(2024, 0, 1, 10, 0, 9, 500).getTime(),
        }}
      />,
    );
    // 排队 8 秒不出现在展示里：起点是真实执行时刻，耗时是 1.5s 而不是 9.5s。
    expect(screen.getByTestId('tool-timing').textContent).toBe(
      '10:00:08 → 10:00:09 · 1.5s',
    );
  });

  it('renders 未执行 for a denied call (never executed, so executionStartedAt never stamped)', () => {
    render(
      <ToolCallCard
        part={{
          type: 'tool-bash',
          toolCallId: 'call-1',
          state: 'output-denied',
          input: { command: 'rm -rf /' },
          approval: { id: 'appr-1', approved: false, reason: 'nope' },
        }}
        timing={{
          toolCallId: 'call-1',
          startedAt: new Date(2024, 0, 1, 10, 0, 0).getTime(),
          completedAt: new Date(2024, 0, 1, 10, 0, 30).getTime(),
        }}
      />,
    );
    expect(screen.getByTestId('tool-timing').textContent).toBe(
      '10:00:00 · 未执行',
    );
  });
});

describe('ToolCallCard — queued (input-available, executionStartedAt not yet stamped)', () => {
  it('downgrades the badge to 等待中 and ticks an 已等待 elapsed with no start-time label (nothing has started executing yet)', () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    render(
      <ToolCallCard
        part={runningPart()}
        timing={{ toolCallId: 'call-1', startedAt }}
      />,
    );

    expect(screen.getByText('等待中')).toBeInTheDocument();
    expect(screen.queryByText('运行中')).not.toBeInTheDocument();
    expect(screen.getByTestId('tool-timing').textContent).toBe('已等待 0ms');

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByTestId('tool-timing').textContent).toBe('已等待 3.0s');
  });

  it('switches to 运行中 when executionStartedAt arrives, restarting the ticker from the real execution start (queue wait excluded)', () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const { rerender } = render(
      <ToolCallCard
        part={runningPart()}
        timing={{ toolCallId: 'call-1', startedAt }}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByTestId('tool-timing').textContent).toBe('已等待 5.0s');

    rerender(
      <ToolCallCard
        part={runningPart()}
        timing={{
          toolCallId: 'call-1',
          startedAt,
          executionStartedAt: startedAt + 5000,
        }}
      />,
    );
    expect(screen.getByText('运行中')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    // 排队那 5 秒不混进执行耗时——ticker 从真实执行起点重新起跳。
    expect(screen.getByTestId('tool-timing').textContent).toContain('1.0s');
    expect(screen.getByTestId('tool-timing').textContent).not.toContain(
      '已等待',
    );
  });
});

describe('ToolCallCard — running (executionStartedAt stamped, no completedAt yet)', () => {
  it('shows the execution start time plus an elapsed duration that ticks upward once per second', () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    render(
      <ToolCallCard
        part={runningPart()}
        timing={{
          toolCallId: 'call-1',
          startedAt,
          executionStartedAt: startedAt,
        }}
      />,
    );

    // First render (before the effect's first tick) shows 0ms elapsed.
    expect(screen.getByTestId('tool-timing').textContent).toContain('0ms');

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId('tool-timing').textContent).toContain('1.0s');

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId('tool-timing').textContent).toContain('2.0s');
  });

  it('includes the static execution-start label alongside the ticking elapsed duration', () => {
    vi.useFakeTimers();
    const startedAt = new Date(2024, 0, 1, 14, 30, 0).getTime();
    vi.setSystemTime(startedAt);
    render(
      <ToolCallCard
        part={runningPart()}
        timing={{
          toolCallId: 'call-1',
          startedAt,
          executionStartedAt: startedAt,
        }}
      />,
    );
    expect(screen.getByTestId('tool-timing').textContent).toBe(
      '14:30:00 · 0ms',
    );
  });

  it('stops ticking once the part settles and a completed timing prop arrives (interval cleaned up, not just frozen)', () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const { rerender } = render(
      <ToolCallCard
        part={runningPart()}
        timing={{ toolCallId: 'call-1', startedAt }}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByTestId('tool-timing').textContent).toContain('2.0s');

    const completedAt = startedAt + 2000;
    rerender(
      <ToolCallCard
        part={settledPart()}
        timing={{ toolCallId: 'call-1', startedAt, completedAt }}
      />,
    );
    const settledText = screen.getByTestId('tool-timing').textContent;
    expect(settledText).toContain('2.0s');

    // Advancing further must not change the now-settled, non-ticking text —
    // if the old running interval were still alive it would keep bumping
    // the elapsed value past what the settled duration shows.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByTestId('tool-timing').textContent).toBe(settledText);
  });
});

describe('ToolCallCard — crash residue (part.state already settled, but completedAt missing)', () => {
  it('shows the start time and "—" in place of a duration, and does not tick', () => {
    vi.useFakeTimers();
    const startedAt = new Date(2024, 0, 1, 8, 0, 0).getTime();
    render(
      <ToolCallCard
        part={erroredPart()}
        timing={{ toolCallId: 'call-1', startedAt }}
      />,
    );

    expect(screen.getByTestId('tool-timing').textContent).toBe('08:00:00 · —');

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByTestId('tool-timing').textContent).toBe('08:00:00 · —');
  });

  it('output-denied is also a settled state for this purpose — same crash-residue rendering', () => {
    const deniedPart: NimboToolPart = {
      type: 'tool-bash',
      toolCallId: 'call-1',
      state: 'output-denied',
      input: { command: 'rm -rf /' },
      approval: { id: 'call-1', approved: false, reason: 'no' },
    };
    render(
      <ToolCallCard
        part={deniedPart}
        timing={{
          toolCallId: 'call-1',
          startedAt: new Date(2024, 0, 1, 8, 0, 0).getTime(),
        }}
      />,
    );
    expect(screen.getByTestId('tool-timing').textContent).toBe('08:00:00 · —');
  });
});
