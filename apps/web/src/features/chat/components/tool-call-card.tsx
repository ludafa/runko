/**
 * 一次工具调用的卡片——**壳来自 ai-elements 的 `Tool`**（`components/ai-elements/tool.tsx`），
 * 这里只补 runko 特有的两件事：中文状态词，和工具计时条。
 *
 * 为什么不直接用 `ToolHeader`：它的状态徽标是英文固定表，且没有「排队/等审批」
 * 这一档——而这一档在 runko 里是真实存在的（loop 对同一步的多个调用**串行**结算）。
 * 所以 header 自己拼，`ToolContent`/`ToolInput`/`ToolOutput` 照用官方件。
 *
 * ---- tool timing (`timing` prop, `message-entry.tsx` 的 `findToolTiming` join) ----
 *
 * `timing` 在这次调用还没有 `data-tool-timing` 部件时是 `undefined`（入参还在流式，
 * 或这条消息在该部件引入前就落盘了）——此时计时条整个不渲染。一旦到位，显示完全
 * 由 `timing`/`part.state` 驱动（绝不看外部的轮/会话状态——「跳动只跟 tool part
 * 自身状态挂钩」），围绕 `@runko/core` 的三段生命周期（state.ts `toolTimingDataSchema`：
 * `startedAt` 成形入队 → `executionStartedAt` 真实开始执行 → `completedAt` 结算）：
 *
 * - queued（`executionStartedAt` 缺席、未结算）：还在排队/等审批——状态词换成
 *   「等待中」，只显示逐秒跳动的已等待时长（没有"启动时间"可言，它还没启动——
 *   2026-07-16 定案：展示给用户的启动时间必须是真实执行起点）。
 * - executing（`executionStartedAt` 到位、`completedAt` 缺席）：真实执行起点的
 *   钟表时间 + 逐秒跳动的执行耗时（`useElapsedTicker`；`Date.now()` 只在 effect
 *   内读取，见 hook 注释——React purity 规则）。
 * - settled（`completedAt` 到位）：执行起点 → 结算钟表时间 + 人性化**执行**耗时
 *   （不含排队/审批等待）。`executionStartedAt` 缺席的两种结算：`output-denied`
 *   （从未执行）显示「未执行」；其余是本字段引入前的存量记录，退回旧口径
 *   （`startedAt` 起算的全程时长）。
 * - crash residue（部件状态已结算但 `completedAt` 缺席——正常跑完的 loop 不会出现，
 *   防御既有/损坏数据）：钟表时间 + "—"，不跳动。
 */
import type { ToolTimingData } from '@runko/core';
import {
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  CircleSlashIcon,
  HourglassIcon,
  Loader2Icon,
  ShieldCheckIcon,
  WrenchIcon,
  XCircleIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import {
  Tool,
  ToolContent,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool';
import { Badge } from '@/components/ui/badge';
import { CollapsibleTrigger } from '@/components/ui/collapsible';

import type { RunkoToolPart } from '../timeline';
import {
  formatClockTime,
  formatDuration,
  summarizeJson,
  toolPartName,
} from '../timeline';

const STATUS_META: Record<
  RunkoToolPart['state'],
  { label: string; icon: ReactNode }
> = {
  'input-streaming': {
    label: '准备中',
    icon: <CircleIcon className="size-3.5" aria-hidden="true" />,
  },
  'input-available': {
    label: '运行中',
    icon: <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />,
  },
  'approval-requested': {
    label: '待审批',
    icon: (
      <HourglassIcon
        className="size-3.5 text-amber-600 dark:text-amber-400"
        aria-hidden="true"
      />
    ),
  },
  'approval-responded': {
    label: '已裁决',
    icon: <ShieldCheckIcon className="size-3.5" aria-hidden="true" />,
  },
  'output-available': {
    label: '已完成',
    icon: (
      <CheckCircleIcon
        className="size-3.5 text-emerald-600 dark:text-emerald-400"
        aria-hidden="true"
      />
    ),
  },
  'output-error': {
    label: '失败',
    icon: (
      <XCircleIcon
        className="size-3.5 text-red-600 dark:text-red-400"
        aria-hidden="true"
      />
    ),
  },
  'output-denied': {
    label: '已拒绝',
    icon: (
      <CircleSlashIcon
        className="size-3.5 text-amber-600 dark:text-amber-400"
        aria-hidden="true"
      />
    ),
  },
};

/** The three tool-part states `data-tool-timing`'s `completedAt` is ever written for (`@runko/core`'s `loop.ts`) — "already settled" for `ToolTimingStrip`'s crash-residue check below. */
const SETTLED_STATES = new Set<RunkoToolPart['state']>([
  'output-available',
  'output-error',
  'output-denied',
]);

/** `input-available` 但 `executionStartedAt` 还没到——串行结算队列里排队/等审批中，状态从「运行中」降级为「等待中」（file header "queued" bullet）。 */
const QUEUED_META: { label: string; icon: ReactNode } = {
  label: '等待中',
  icon: (
    <HourglassIcon
      className="size-3.5 text-amber-600 dark:text-amber-400"
      aria-hidden="true"
    />
  ),
};

/**
 * Milliseconds elapsed since `startedAt`, updated once a second while
 * `active` (cleared the instant `active` flips false — settlement — or on
 * unmount, via the effect's own cleanup). `Date.now()` is only ever called
 * from inside this effect, never during render (see this file's own header,
 * "running" bullet) — the very first render before the effect has fired
 * reads `0`, corrected within the same commit's passive-effect pass.
 */
function useElapsedTicker(active: boolean, startedAt: number): number {
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (!active) {
      return undefined;
    }
    function tick(): void {
      setElapsedMs(Date.now() - startedAt);
    }
    tick();
    const interval = setInterval(tick, 1000);
    return () => {
      clearInterval(interval);
    };
  }, [active, startedAt]);
  return elapsedMs;
}

/**
 * The header's low-key timing segment — a separate component (not inlined
 * into `ToolCallCard`) purely so `useElapsedTicker` can be called
 * unconditionally even though the strip as a whole only ever renders when
 * `timing` is defined (`ToolCallCard` gates that at its call site, not with a
 * runtime `if` in the middle of its own hook calls).
 */
function ToolTimingStrip({
  timing,
  settled,
  denied,
}: {
  timing: ToolTimingData;
  settled: boolean;
  denied: boolean;
}) {
  const live = !settled && timing.completedAt === undefined;
  // queued 阶段从 `startedAt` 起跳（"已等待多久"），executing 阶段从真实执行
  // 起点重新起跳（"已执行多久"）——base 变化会让 useElapsedTicker 的 effect
  // 重挂、tick 归零重来，正是想要的切换行为。
  const tickBase = timing.executionStartedAt ?? timing.startedAt;
  const elapsedMs = useElapsedTicker(live, tickBase);

  let detail: string;
  if (timing.completedAt !== undefined) {
    if (timing.executionStartedAt !== undefined) {
      detail = `${formatClockTime(timing.executionStartedAt)} → ${formatClockTime(timing.completedAt)} · ${formatDuration(timing.completedAt - timing.executionStartedAt)}`;
    } else if (denied) {
      // 从未执行（deny 路径恒无 executionStartedAt）——没有执行耗时可言。
      detail = `${formatClockTime(timing.startedAt)} · 未执行`;
    } else {
      // executionStartedAt 引入前的存量记录——退回旧口径（全程时长）。
      detail = `${formatClockTime(timing.startedAt)} → ${formatClockTime(timing.completedAt)} · ${formatDuration(timing.completedAt - timing.startedAt)}`;
    }
  } else if (live && timing.executionStartedAt !== undefined) {
    detail = `${formatClockTime(timing.executionStartedAt)} · ${formatDuration(elapsedMs)}`;
  } else if (live) {
    detail = `已等待 ${formatDuration(elapsedMs)}`;
  } else {
    // Settled but `completedAt` never landed — crash residue (file header).
    detail = `${formatClockTime(tickBase)} · —`;
  }

  return (
    <span
      data-testid="tool-timing"
      className="text-muted-foreground shrink-0 font-mono text-[0.6875rem] tabular-nums"
    >
      {detail}
    </span>
  );
}

export function ToolCallCard({
  part,
  timing,
}: {
  part: RunkoToolPart;
  /** The `data-tool-timing` part sharing this call's `toolCallId` (`message-entry.tsx`'s `findToolTiming` join) — `undefined` while input is still streaming, or for a message persisted before this part existed. */
  timing?: ToolTimingData;
}) {
  // 串行结算队列可见化：调用已成形（input-available）但真实执行还没开始
  // （timing 在、executionStartedAt 缺席）——排队/等审批中，不能标「运行中」。
  const queued =
    part.state === 'input-available' &&
    timing !== undefined &&
    timing.executionStartedAt === undefined;
  const meta = queued ? QUEUED_META : STATUS_META[part.state];
  const toolName = toolPartName(part);
  const reason =
    part.state === 'approval-responded' || part.state === 'output-denied' ?
      part.approval.reason
    : undefined;

  return (
    <Tool defaultOpen={false}>
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-2.5 py-2 text-left">
        <WrenchIcon
          className="text-muted-foreground size-3.5 shrink-0"
          aria-hidden="true"
        />
        <span className="shrink-0 font-mono text-xs font-medium">
          {toolName}
        </span>
        <Badge variant="secondary" className="shrink-0 gap-1">
          {meta.icon}
          {meta.label}
        </Badge>
        <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs">
          {summarizeJson(part.input)}
        </span>
        {timing !== undefined && (
          <ToolTimingStrip
            timing={timing}
            settled={SETTLED_STATES.has(part.state)}
            denied={part.state === 'output-denied'}
          />
        )}
        <ChevronDownIcon
          className="text-muted-foreground size-3.5 shrink-0 transition-transform group-data-[panel-open]:rotate-180"
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <ToolContent>
        <ToolInput input={part.input} />
        <ToolOutput
          output={part.state === 'output-available' ? part.output : undefined}
          errorText={part.state === 'output-error' ? part.errorText : undefined}
        />
        {reason !== undefined && (
          <p className="text-muted-foreground px-2.5 pb-2.5 text-xs">
            拒绝原因：{reason}
          </p>
        )}
      </ToolContent>
    </Tool>
  );
}
