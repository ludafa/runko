/**
 * Adapted from AI Elements' `tool.tsx` (collapsible card: header row with an
 * icon + tool name + status badge + chevron, content split into
 * "Parameters"/"Result"/"Error" panels) — dropped its `CodeBlock` (shiki
 * syntax highlighting — not worth the dependency for a summary; a plain
 * `<pre>` covers the "view full JSON on demand" need just as well).
 *
 * docs/tech/single-ledger.md §6 migration: renders a tool part
 * directly (`NimboToolPart` — `timeline.ts`'s alias for `ToolUIPart<UITools>`)
 * instead of the old `tool_call` `SessionItem`'s simplified 4-value status —
 * covers all seven of ai's native tool-part states, including the
 * `approval-requested`/`approval-responded` states a gated call passes
 * through *before* it settles (docs/tech/single-ledger.md §6.1) — `approval-requested` is
 * normally intercepted upstream (`message-entry.tsx` renders `ApprovalCard`
 * instead), so seeing it here would only ever happen defensively; every
 * other state is this card's normal rendering.
 *
 * ---- tool timing (`timing` prop, `message-entry.tsx`'s `findToolTiming`
 * join) ----
 *
 * `timing` is `undefined` whenever this tool call has no `data-tool-timing`
 * part yet (input still streaming, or a message persisted before this part
 * existed) — the strip below simply doesn't render. Once present, display is
 * driven entirely by `timing`/`part.state`（never by anything about the
 * surrounding turn/session — "跳动只跟 tool part 自身状态挂钩"），围绕
 * `@nimbo/core` 的三段生命周期（state.ts `toolTimingDataSchema`：`startedAt`
 * 成形入队 → `executionStartedAt` 真实开始执行 → `completedAt` 结算；loop 对
 * 同一步多个调用**串行**结算，排队真实存在）：
 *
 * - queued（`executionStartedAt` 缺席、未结算）：还在排队/等审批——徽标换成
 *   「等待中」，时间条只显示逐秒跳动的已等待时长（没有"启动时间"可言，它还
 *   没启动——2026-07-16 定案：展示给用户的启动时间必须是真实执行起点）。
 * - executing（`executionStartedAt` 到位、`completedAt` 缺席）：真实执行起点
 *   的钟表时间 + 逐秒跳动的执行耗时（`useElapsedTicker`；`Date.now()` 只在
 *   effect 内读取，见 hook 注释——React purity 规则）。
 * - settled（`completedAt` 到位）：执行起点 → 结算钟表时间 + 人性化**执行**
 *   耗时（不含排队/审批等待）。`executionStartedAt` 缺席的两种结算：
 *   `output-denied`（从未执行）显示「未执行」；其余是本字段引入前的存量记录，
 *   退回旧口径（`startedAt` 起算的全程时长）。
 * - crash residue（部件状态已结算但 `completedAt` 缺席——正常跑完的 loop 不会
 *   出现，防御既有/损坏数据）：钟表时间 + "—"，不跳动。
 */
import type { ToolTimingData } from '@nimbo/core';
import {
  CheckCircleIcon,
  ChevronDownIcon,
  CircleSlashIcon,
  HourglassIcon,
  Loader2Icon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  WrenchIcon,
  XCircleIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';

import type { NimboToolPart } from '../timeline';
import {
  formatClockTime,
  formatDuration,
  prettyJson,
  summarizeJson,
  toolPartName,
} from '../timeline';

const STATUS_META: Record<
  NimboToolPart['state'],
  { label: string; icon: ReactNode }
> = {
  'input-streaming': {
    label: '准备中',
    icon: <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />,
  },
  'input-available': {
    label: '运行中',
    icon: <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />,
  },
  'approval-requested': {
    label: '待审批',
    icon: <ShieldAlertIcon className="size-3.5" aria-hidden="true" />,
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

/** The three tool-part states `data-tool-timing`'s `completedAt` is ever written for (`@nimbo/core`'s `loop.ts`) — "already settled" for `ToolTimingStrip`'s crash-residue check below. */
const SETTLED_STATES = new Set<NimboToolPart['state']>([
  'output-available',
  'output-error',
  'output-denied',
]);

/** `input-available` 但 `executionStartedAt` 还没到——串行结算队列里排队/等审批中，徽标从「运行中」降级为「等待中」（file header "queued" bullet）。 */
const QUEUED_META: { label: string; icon: ReactNode } = {
  label: '等待中',
  icon: <HourglassIcon className="size-3.5" aria-hidden="true" />,
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
    if (!active) return undefined;
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
      className="text-muted-foreground ml-1 shrink-0 font-mono text-[0.65rem]"
    >
      {detail}
    </span>
  );
}

export function ToolCallCard({
  part,
  timing,
}: {
  part: NimboToolPart;
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
  const hasOutput = part.state === 'output-available';
  const hasErrorText = part.state === 'output-error';
  const reason =
    part.state === 'approval-responded' || part.state === 'output-denied' ?
      part.approval.reason
    : undefined;

  return (
    <Collapsible
      className="border-foreground/10 bg-card/40 rounded-xl border"
      defaultOpen={false}
    >
      <CollapsibleTrigger className="group/tool flex w-full items-center gap-2 px-3 py-2 text-left">
        <WrenchIcon
          className="text-muted-foreground size-3.5 shrink-0"
          aria-hidden="true"
        />
        <span className="truncate font-mono text-xs font-medium">
          {toolName}
        </span>
        <Badge variant="secondary" className="ml-1 gap-1">
          {meta.icon}
          {meta.label}
        </Badge>
        {timing !== undefined && (
          <ToolTimingStrip
            timing={timing}
            settled={SETTLED_STATES.has(part.state)}
            denied={part.state === 'output-denied'}
          />
        )}
        <span className="text-muted-foreground ml-1 min-w-0 flex-1 truncate font-mono text-xs">
          {summarizeJson(part.input)}
        </span>
        <ChevronDownIcon
          className="text-muted-foreground size-3.5 shrink-0 transition-transform group-data-[panel-open]/tool:rotate-180"
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 px-3 pb-3">
        <div className="space-y-1">
          <h4 className="text-muted-foreground text-[0.65rem] font-medium tracking-[0.14em] uppercase">
            Parameters
          </h4>
          <pre className="bg-muted/50 overflow-x-auto rounded-md p-2 font-mono text-xs">
            {prettyJson(part.input)}
          </pre>
        </div>
        {hasOutput && (
          <div className="space-y-1">
            <h4 className="text-muted-foreground text-[0.65rem] font-medium tracking-[0.14em] uppercase">
              Result
            </h4>
            <pre className="bg-muted/50 overflow-x-auto rounded-md p-2 font-mono text-xs">
              {typeof part.output === 'string' ?
                part.output
              : prettyJson(part.output)}
            </pre>
          </div>
        )}
        {hasErrorText && (
          <div className="space-y-1">
            <h4 className="text-muted-foreground text-[0.65rem] font-medium tracking-[0.14em] uppercase">
              Error
            </h4>
            <pre className="bg-destructive/10 text-destructive overflow-x-auto rounded-md p-2 font-mono text-xs">
              {part.errorText}
            </pre>
          </div>
        )}
        {reason !== undefined && (
          <p className="text-muted-foreground text-xs">拒绝原因：{reason}</p>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
