/**
 * 本轮统计按钮 + 弹窗（docs/features/telemetry.md · docs/tech/telemetry.md §4.2）：
 * assistant 消息末尾（该轮 metadata.status === 'completed'，@nimbo/core loop 的
 * finalizeTurn）挂一枚「统计」按钮——界面上不再有常驻的汇总条，一轮的全部指标
 * 都收进点开的弹窗里。弹窗分两层数据源，正是「账本为源、遥测做增强」的分工：
 *
 * - **概览**来自账本 metadata（产品数据，永久、随流免费到达）：耗时、工具/agent
 *   拆分、usage 四分——不依赖遥测，遥测整体关闭这一节照常显示。
 * - **明细**来自遥测端点按需拉取：逐次模型调用的响应/首 token 耗时、输入输出
 *   吞吐、token 三分（含推理）、finishReason、模型；逐个工具执行的耗时与失败。
 *   遥测是可关闭/可清空的耗材，明细缺席只显示「无遥测数据」，概览不受影响。
 *
 * 明细只在 conversationId/turn 都就位时才拉（旧记录 metadata 无 turn 就只有
 * 概览）；首次打开弹窗才发请求，结果缓存在组件 state 里（反复开合不重复拉取）。
 * payloadJson 用零星 zod safeParse 按需取字段——形状随 ai 小版本演化，解析失败
 * 的行静默跳过，不让一条坏数据毁掉整个弹窗。
 */
import type { Usage } from '@nimbo/core';
import { BarChart3Icon } from 'lucide-react';
import { Fragment, useState } from 'react';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

import { fetchTurnTelemetry } from '../api';
import type { TurnTelemetryEvent } from '../schema';
import { formatDuration } from '../timeline';

// Deliberately not `toLocaleString()`: keeps the rendered text deterministic
// across test/CI environments regardless of ICU data availability — thousands
// grouping is done by hand for the same readability without the ICU
// dependency (149326 → "149,326").
function count(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 收敛 `number | null | undefined`（zod `.nullable().optional()` 的产物）为「是不是有值」——面板对缺席字段一律不渲染。 */
function present(value: number | null | undefined): value is number {
  return value !== null && value !== undefined;
}

// ---- payloadJson 的按需解析（只挑弹窗要展示的字段，其余无视） ----

const modelCallEndPayloadSchema = z.object({
  modelId: z.string().optional(),
  finishReason: z.string().optional(),
  usage: z
    .object({
      inputTokens: z.number().optional(),
      inputTokenDetails: z
        .object({ cacheReadTokens: z.number().optional() })
        .optional(),
      outputTokens: z.number().optional(),
      outputTokenDetails: z
        .object({ reasoningTokens: z.number().optional() })
        .optional(),
      totalTokens: z.number().optional(),
    })
    .optional(),
  performance: z
    .object({
      responseTimeMs: z.number().optional(),
      timeToFirstOutputMs: z.number().nullable().optional(),
      outputTokensPerSecond: z.number().nullable().optional(),
      inputTokensPerSecond: z.number().nullable().optional(),
    })
    .optional(),
});

const toolExecutionEndPayloadSchema = z.object({
  toolCall: z.object({ toolName: z.string() }).optional(),
  toolExecutionMs: z.number(),
  toolOutput: z.object({ type: z.string() }).optional(),
});

type ModelCallRow = z.infer<typeof modelCallEndPayloadSchema> & {
  index: number;
};

interface ToolExecutionRow {
  index: number;
  toolName: string;
  toolExecutionMs: number;
  failed: boolean;
}

function parseTelemetryRows(events: TurnTelemetryEvent[]): {
  modelCalls: ModelCallRow[];
  toolExecutions: ToolExecutionRow[];
} {
  const modelCalls: ModelCallRow[] = [];
  const toolExecutions: ToolExecutionRow[] = [];
  for (const event of events) {
    let payload: unknown;
    try {
      payload = JSON.parse(event.payloadJson);
    } catch {
      continue; // 坏行静默跳过（文件头）。
    }
    if (event.eventType === 'model-call-end') {
      const parsed = modelCallEndPayloadSchema.safeParse(payload);
      if (!parsed.success) continue;
      modelCalls.push({ ...parsed.data, index: modelCalls.length + 1 });
    } else if (event.eventType === 'tool-execution-end') {
      const parsed = toolExecutionEndPayloadSchema.safeParse(payload);
      if (!parsed.success) continue;
      toolExecutions.push({
        index: toolExecutions.length + 1,
        toolName: parsed.data.toolCall?.toolName ?? '(unknown)',
        toolExecutionMs: parsed.data.toolExecutionMs,
        failed: parsed.data.toolOutput?.type === 'tool-error',
      });
    }
  }
  return { modelCalls, toolExecutions };
}

// ---- 概览（账本 metadata） ----

interface OverviewRow {
  label: string;
  value: string;
}

function overviewRows(
  usage: Usage,
  durationMs: number | undefined,
  toolDurationMs: number | undefined,
): OverviewRow[] {
  const rows: OverviewRow[] = [];
  if (durationMs !== undefined) {
    rows.push({ label: '耗时', value: formatDuration(durationMs) });
    // 工具/agent 拆分只在本轮真跑过工具时出现——纯文本轮拆分是噪音，旧记录
    // （无 toolDurationMs）无从拆分。agent = 全轮减工具，区间并集保证非负。
    if (toolDurationMs !== undefined && toolDurationMs > 0) {
      rows.push({ label: '工具', value: formatDuration(toolDurationMs) });
      rows.push({
        label: 'agent',
        value: formatDuration(Math.max(0, durationMs - toolDurationMs)),
      });
    }
  }
  if (usage.inputTokens !== undefined)
    rows.push({ label: '输入', value: count(usage.inputTokens) });
  if (usage.cachedInputTokens !== undefined)
    rows.push({ label: '缓存命中', value: count(usage.cachedInputTokens) });
  if (usage.outputTokens !== undefined)
    rows.push({ label: '输出', value: count(usage.outputTokens) });
  if (usage.totalTokens !== undefined)
    rows.push({ label: '共计', value: `${count(usage.totalTokens)} tokens` });
  return rows;
}

// ---- 模型调用明细行的两段文案（性能 / token 用量） ----

function modelCallPerfParts(perf: ModelCallRow['performance']): string[] {
  if (perf === undefined) return [];
  const parts: string[] = [];
  if (present(perf.responseTimeMs))
    parts.push(`响应 ${formatDuration(perf.responseTimeMs)}`);
  if (present(perf.timeToFirstOutputMs))
    parts.push(`首 token ${formatDuration(perf.timeToFirstOutputMs)}`);
  if (present(perf.outputTokensPerSecond))
    parts.push(`输出 ${perf.outputTokensPerSecond.toFixed(1)} tok/s`);
  if (present(perf.inputTokensPerSecond))
    parts.push(`输入 ${count(Math.round(perf.inputTokensPerSecond))} tok/s`);
  return parts;
}

function modelCallUsageParts(usage: ModelCallRow['usage']): string[] {
  if (usage === undefined) return [];
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) {
    const cached = usage.inputTokenDetails?.cacheReadTokens;
    parts.push(
      cached !== undefined ?
        `输入 ${count(usage.inputTokens)}（缓存 ${count(cached)}）`
      : `输入 ${count(usage.inputTokens)}`,
    );
  }
  if (usage.outputTokens !== undefined) {
    const reasoning = usage.outputTokenDetails?.reasoningTokens;
    parts.push(
      reasoning !== undefined ?
        `输出 ${count(usage.outputTokens)}（推理 ${count(reasoning)}）`
      : `输出 ${count(usage.outputTokens)}`,
    );
  }
  if (usage.totalTokens !== undefined)
    parts.push(`共计 ${count(usage.totalTokens)}`);
  return parts;
}

// ---- 弹窗主体 ----

type PanelState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'error' }
  | { phase: 'loaded'; events: TurnTelemetryEvent[] };

function SectionHeading({ children }: { children: string }) {
  return (
    <h4 className="text-muted-foreground text-[0.65rem] font-medium tracking-[0.14em] uppercase">
      {children}
    </h4>
  );
}

function DetailPanel({
  state,
  expandable,
}: {
  state: PanelState;
  expandable: boolean;
}) {
  if (!expandable)
    return (
      <p className="text-muted-foreground text-xs">
        此记录无遥测明细（缺 turn 键）
      </p>
    );
  if (state.phase === 'loading')
    return <p className="text-muted-foreground text-xs">加载中…</p>;
  if (state.phase === 'error')
    return <p className="text-muted-foreground text-xs">遥测数据加载失败</p>;
  if (state.phase !== 'loaded') return null;

  const { modelCalls, toolExecutions } = parseTelemetryRows(state.events);
  if (modelCalls.length === 0 && toolExecutions.length === 0)
    return <p className="text-muted-foreground text-xs">无遥测数据</p>;

  return (
    <>
      {modelCalls.length > 0 && (
        <div className="space-y-1.5">
          <SectionHeading>模型调用</SectionHeading>
          {modelCalls.map((row) => {
            const perf = modelCallPerfParts(row.performance);
            const usage = modelCallUsageParts(row.usage);
            return (
              <div
                key={row.index}
                className="border-foreground/5 space-y-0.5 pt-1.5 font-mono text-xs tabular-nums not-first:border-t"
              >
                <div className="flex flex-wrap items-center gap-x-2">
                  <span className="text-foreground">#{row.index}</span>
                  {row.modelId !== undefined && (
                    <span className="text-muted-foreground">{row.modelId}</span>
                  )}
                  {row.finishReason !== undefined && (
                    <span className="text-muted-foreground/70">
                      {row.finishReason}
                    </span>
                  )}
                </div>
                {perf.length > 0 && (
                  <div className="text-muted-foreground">
                    {perf.join(' · ')}
                  </div>
                )}
                {usage.length > 0 && (
                  <div className="text-muted-foreground">
                    {usage.join(' · ')}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {toolExecutions.length > 0 && (
        <div className="space-y-1">
          <SectionHeading>工具执行</SectionHeading>
          {toolExecutions.map((row) => (
            <div
              key={row.index}
              className="text-muted-foreground flex items-center gap-3 font-mono text-xs tabular-nums"
            >
              <span className="truncate">{row.toolName}</span>
              <span>{formatDuration(row.toolExecutionMs)}</span>
              {row.failed && <span className="text-destructive">失败</span>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function TurnStatsButton({
  usage,
  durationMs,
  toolDurationMs,
  conversationId,
  turn,
}: {
  usage: Usage;
  /** 全 turn 墙钟耗时（`NimboMessageMetadata.durationMs`，`@nimbo/core` loop 的 `finalizeTurn` 写入）——旧记录（字段引入前落盘）没有，概览就不显示这一段。 */
  durationMs?: number;
  /** 本轮工具执行墙钟（`NimboMessageMetadata.toolDurationMs`，并行批区间并集）——`durationMs - toolDurationMs` 即 agent（模型思考/往返）时间。 */
  toolDurationMs?: number;
  /** 遥测明细的查询键（chat 会话 id + metadata.turn）——任一缺席就只出概览，没有明细。 */
  conversationId?: string;
  turn?: number;
}) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<PanelState>({ phase: 'idle' });

  const rows = overviewRows(usage, durationMs, toolDurationMs);

  const handleOpenChange = (next: boolean): void => {
    setOpen(next);
    // 首次打开且查询键就位才拉一次；idle 守卫保证反复开合不重复请求。
    if (
      next &&
      conversationId !== undefined &&
      turn !== undefined &&
      panel.phase === 'idle'
    ) {
      setPanel({ phase: 'loading' });
      fetchTurnTelemetry(conversationId, turn).then(
        (events) => {
          setPanel({ phase: 'loaded', events });
        },
        () => {
          setPanel({ phase: 'error' });
        },
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {/* 消息动作行（对齐 AI Elements 的 Actions/Action：无边框 ghost 图标钮，
          muted → hover 变实）——目前只有「统计」一枚，后续 copy/retry 可并排入行。 */}
      <div className="flex items-center gap-1">
        <DialogTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              title="统计"
              data-testid="turn-stats-button"
              className="text-muted-foreground hover:text-foreground"
            />
          }
        >
          <BarChart3Icon aria-hidden="true" />
          <span className="sr-only">统计</span>
        </DialogTrigger>
      </div>
      <DialogContent data-testid="turn-stats-dialog" className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>本轮统计</DialogTitle>
          <DialogDescription>
            {turn !== undefined ? `第 ${String(turn)} 轮` : '本轮'} ·
            用量与调用明细
          </DialogDescription>
        </DialogHeader>
        <div className="grid max-h-[70vh] gap-4 overflow-y-auto pr-1">
          <div className="space-y-1.5">
            <SectionHeading>概览</SectionHeading>
            {rows.length > 0 ?
              <div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 font-mono text-xs tabular-nums">
                {rows.map((row) => (
                  <Fragment key={row.label}>
                    <span className="text-muted-foreground">{row.label}</span>
                    <span>{row.value}</span>
                  </Fragment>
                ))}
              </div>
            : <p className="text-muted-foreground text-xs">本轮结束</p>}
          </div>
          <DetailPanel
            state={panel}
            expandable={conversationId !== undefined && turn !== undefined}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
