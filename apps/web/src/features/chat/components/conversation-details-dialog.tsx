/**
 * 会话详情弹窗：功能条上放不下、也不必常驻的东西（docs/features/chat-ui.md
 * 「会话功能条压成一行」）。两个 tab：
 *
 * - **详情**——这个会话绑在哪条分支、哪个仓库、哪种[沙盒 provider](../../../../../docs/terms.md)。
 *   仓库来自全局 `GITHUB_REPO`、每个会话都一样；provider 建会话时选定后不再变。
 *   都是「偶尔要查」而非「一直要看」，常驻功能条只会挤掉会话标题的位置。
 * - **统计**——**整个会话**的用量汇总，与消息末尾那枚「统计」（`TurnStatsButton`，
 *   单轮）互补：那个回答「这一轮花了多少」，这个回答「这个会话至今花了多少」。
 *
 * 统计的数据源是**账本 metadata**（每条 assistant 消息 `metadata.usage /
 * durationMs / toolDurationMs`），不额外请求：它随直播流免费到达、永久保存。
 * 遥测那条线（可关闭、可清空的耗材）只喂单轮明细，不参与这里的汇总。
 */
import type { NimboUIMessage } from '@nimbo/core';
import { InfoIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

import type { Conversation } from '../schema';
import { formatDuration } from '../timeline';
import { CONVERSATION_STATUS_LABEL } from './conversation-status-badge';
import { count } from './turn-stats-dialog';

/** 固定用 ISO 风格的本地时间，不走 `toLocaleString()`——后者的输出随环境 ICU 数据变化，测试里对不齐。 */
function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

// ---- 会话级汇总 ----

export interface ConversationStats {
  completedTurns: number;
  failedTurns: number;
  /** 有 `durationMs` 的轮的墙钟之和；没有任何一轮带该字段时为 `undefined`（旧记录）。 */
  durationMs: number | undefined;
  toolDurationMs: number | undefined;
  inputTokens: number | undefined;
  cachedInputTokens: number | undefined;
  outputTokens: number | undefined;
  totalTokens: number | undefined;
}

/** `undefined + n = n`，全程没值就保持 `undefined`——区分「这个会话没花 token」和「旧记录没记」。 */
function addOptional(
  acc: number | undefined,
  value: number | undefined,
): number | undefined {
  if (value === undefined) return acc;
  return (acc ?? 0) + value;
}

export function summarizeConversation(
  messages: readonly NimboUIMessage[],
): ConversationStats {
  const stats: ConversationStats = {
    completedTurns: 0,
    failedTurns: 0,
    durationMs: undefined,
    toolDurationMs: undefined,
    inputTokens: undefined,
    cachedInputTokens: undefined,
    outputTokens: undefined,
    totalTokens: undefined,
  };

  for (const message of messages) {
    const metadata = message.metadata;
    if (metadata?.status === undefined) continue;
    if (metadata.status === 'completed') stats.completedTurns += 1;
    else {
      stats.failedTurns += 1;
      // 失败轮照样计入耗时与用量——token 是真花掉了，不能因为这轮没成就当没发生。
    }
    stats.durationMs = addOptional(stats.durationMs, metadata.durationMs);
    stats.toolDurationMs = addOptional(
      stats.toolDurationMs,
      metadata.toolDurationMs,
    );
    const usage = metadata.usage;
    stats.inputTokens = addOptional(stats.inputTokens, usage?.inputTokens);
    stats.cachedInputTokens = addOptional(
      stats.cachedInputTokens,
      usage?.cachedInputTokens,
    );
    stats.outputTokens = addOptional(stats.outputTokens, usage?.outputTokens);
    stats.totalTokens = addOptional(stats.totalTokens, usage?.totalTokens);
  }

  return stats;
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-baseline gap-3">
      <dt className="text-muted-foreground text-[0.6875rem] font-medium tracking-[0.02em]">
        {label}
      </dt>
      <dd className="min-w-0 text-sm break-all">{children}</dd>
    </div>
  );
}

function StatsPanel({ stats }: { stats: ConversationStats }) {
  const turns = stats.completedTurns + stats.failedTurns;
  if (turns === 0) {
    return (
      <p className="text-muted-foreground py-2 text-sm">
        这个会话还没有跑完过一轮。
      </p>
    );
  }

  return (
    <dl className="flex flex-col gap-3">
      <Row label="轮数">
        <span className="tabular-nums">{count(turns)}</span>
        {stats.failedTurns > 0 && (
          <span className="text-muted-foreground ml-2 text-xs">
            其中 {count(stats.failedTurns)} 轮失败
          </span>
        )}
      </Row>
      {stats.durationMs !== undefined && (
        <Row label="总耗时">
          <span className="tabular-nums">
            {formatDuration(stats.durationMs)}
          </span>
        </Row>
      )}
      {/* 工具/agent 拆分只在真跑过工具时给——纯对话会话拆分是噪音。agent = 全轮减工具。 */}
      {stats.durationMs !== undefined &&
        stats.toolDurationMs !== undefined &&
        stats.toolDurationMs > 0 && (
          <>
            <Row label="工具">
              <span className="tabular-nums">
                {formatDuration(stats.toolDurationMs)}
              </span>
            </Row>
            <Row label="agent">
              <span className="tabular-nums">
                {formatDuration(
                  Math.max(0, stats.durationMs - stats.toolDurationMs),
                )}
              </span>
            </Row>
          </>
        )}
      {stats.inputTokens !== undefined && (
        <Row label="输入">
          <span className="tabular-nums">{count(stats.inputTokens)}</span>
        </Row>
      )}
      {stats.cachedInputTokens !== undefined && (
        <Row label="缓存命中">
          <span className="tabular-nums">{count(stats.cachedInputTokens)}</span>
        </Row>
      )}
      {stats.outputTokens !== undefined && (
        <Row label="输出">
          <span className="tabular-nums">{count(stats.outputTokens)}</span>
        </Row>
      )}
      {stats.totalTokens !== undefined && (
        <Row label="共计">
          <span className="tabular-nums">{count(stats.totalTokens)}</span>{' '}
          tokens
        </Row>
      )}
    </dl>
  );
}

export function ConversationDetailsDialog({
  conversation,
  messages,
}: {
  conversation: Conversation;
  /** 账本里已加载的消息——会话级统计的唯一数据源。缺席（如设计工作台）就只有详情 tab 有内容。 */
  messages?: readonly NimboUIMessage[];
}) {
  const stats = summarizeConversation(messages ?? []);

  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-foreground shrink-0"
            aria-label="会话详情"
            title="会话详情"
          />
        }
      >
        <InfoIcon className="size-3.5" aria-hidden="true" />
      </DialogTrigger>

      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>会话详情</DialogTitle>
          <DialogDescription>
            这个会话绑定的分支与沙盒，以及至今的用量。
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="detail">
          <TabsList>
            <TabsTrigger value="detail">详情</TabsTrigger>
            <TabsTrigger value="stats">统计</TabsTrigger>
          </TabsList>

          <TabsContent value="detail">
            <dl className="flex flex-col gap-3">
              <Row label="分支">
                <span className="font-mono text-[0.8125rem]">
                  {conversation.branchName}
                </span>
              </Row>
              <Row label="仓库">
                <span className="font-mono text-[0.8125rem]">
                  {conversation.repo}
                </span>
              </Row>
              <Row label="沙盒">
                <span className="font-mono text-[0.8125rem]">
                  {conversation.provider}
                </span>
              </Row>
              <Row label="状态">
                {CONVERSATION_STATUS_LABEL[conversation.status]}
              </Row>
              <Row label="创建于">
                <span className="tabular-nums">
                  {formatTimestamp(conversation.createdAt)}
                </span>
              </Row>
              <Row label="最后活跃">
                <span className="tabular-nums">
                  {formatTimestamp(conversation.lastActiveAt)}
                </span>
              </Row>
            </dl>
          </TabsContent>

          <TabsContent value="stats">
            <StatsPanel stats={stats} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
