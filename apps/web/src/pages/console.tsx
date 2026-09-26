/**
 * [集群控制台](../../../../docs/terms.md)页面：一眼看到每个会话此刻在哪个节点上跑，
 * 点一下「下线」就能把一个节点请退场。用户可见行为见
 * docs/host/node/features/cluster-console.md §3；数据形状与接口见
 * docs/host/node/tech/cluster-console.md §8、§9。
 *
 * demo 项目不设管理员：这里能看到全部用户的会话标题（功能手册 §4），登录了就能用。
 */
import { Icon } from '@iconify/react';
import { AlertTriangleIcon, InfoIcon } from 'lucide-react';
import { useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

import type {
  ConsoleConversation,
  ConsoleNode,
  ConsoleOverview,
} from '../features/console/api';
import { formatCountdown, formatSecondsAgo } from '../features/console/format';
import {
  useConsoleOverview,
  useNodeOfflineMutation,
  useNodeOnlineMutation,
} from '../features/console/use-console';
import { useServerClock } from '../features/console/use-server-clock';

/** 功能手册 §3.3：下线确认框要把三个时间点写清楚。 */
const OFFLINE_CONFIRM_TEXT =
  '这个节点将不再接新请求；正在跑的对话会马上交给别的节点接着跑，还在跑的命令留在这里跑完；2 分钟后进程还在就强杀。';

const NOT_CONTROLLABLE_REASON =
  '这台服务端没有配置运维容器（单进程跑法），节点没法被远程控制';

interface NodeStateMeta {
  label: string;
  icon: string;
}

function describeNodeState(node: ConsoleNode, nowMs: number): NodeStateMeta {
  switch (node.state) {
    case 'online':
      return { label: '在线', icon: 'solar:check-circle-linear' };
    case 'going_offline': {
      const countdown =
        node.offlineDeadline === null ?
          ''
        : ` ${formatCountdown(node.offlineDeadline - nowMs)}`;
      return { label: `下线中${countdown}`, icon: 'solar:clock-circle-linear' };
    }
    case 'offline':
      return { label: '已下线', icon: 'solar:power-linear' };
    case 'unknown':
      return {
        label: node.dockerState ?? '状态未知',
        icon: 'solar:question-circle-linear',
      };
  }
}

/** 会话按 `holder` 挂到 `url` 匹配的节点下；挂不上任何节点的进「未知节点」分组。 */
function groupConversations(overview: ConsoleOverview): {
  byNodeUrl: Map<string, ConsoleConversation[]>;
  unknown: ConsoleConversation[];
} {
  const nodeUrls = new Set(
    overview.nodes
      .map((node) => node.url)
      .filter((url): url is string => url !== null),
  );
  const byNodeUrl = new Map<string, ConsoleConversation[]>();
  const unknown: ConsoleConversation[] = [];
  for (const conversation of overview.conversations) {
    if (!nodeUrls.has(conversation.holder)) {
      unknown.push(conversation);
      continue;
    }
    const bucket = byNodeUrl.get(conversation.holder);
    if (bucket === undefined) {
      byNodeUrl.set(conversation.holder, [conversation]);
    } else {
      bucket.push(conversation);
    }
  }
  return { byNodeUrl, unknown };
}

function ConversationRow({
  conversation,
  nowMs,
}: {
  conversation: ConsoleConversation;
  nowMs: number;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2 text-sm">
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-muted-foreground/50">·</span>
        <span className="truncate">{conversation.title}</span>
        {conversation.stale && <Badge variant="destructive">疑似失联</Badge>}
      </div>
      <div className="text-muted-foreground flex shrink-0 items-center gap-3 text-xs">
        <span>{conversation.ownerEmail}</span>
        <span>心跳 {formatSecondsAgo(conversation.heartbeatAt, nowMs)}</span>
      </div>
    </li>
  );
}

interface NodeCardProps {
  node: ConsoleNode;
  /** 数组里的位置，`node.index` 缺失时（没配运维容器那一档）拿它兜底当「节点 N」的编号。 */
  position: number;
  conversations: ConsoleConversation[];
  nowMs: number;
  controllable: boolean;
  offline: ReturnType<typeof useNodeOfflineMutation>;
  online: ReturnType<typeof useNodeOnlineMutation>;
}

function NodeCard({
  node,
  position,
  conversations,
  nowMs,
  controllable,
  offline,
  online,
}: NodeCardProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const meta = describeNodeState(node, nowMs);
  const displayIndex = node.index ?? position + 1;

  // 两个 mutation 在页面级共用一个实例（见 `use-console.ts`）：这样同时只能有一个
  // 下线/上线请求在飞，`variables` 记的是当前这一个请求打的是哪个节点，用来只点亮
  // 正在处理的那张卡片，而不是把全部按钮一起转起来。
  const busy =
    (offline.isPending && offline.variables === node.id) ||
    (online.isPending && online.variables === node.id);
  const disabled = !controllable || busy;
  const disabledTitle = controllable ? undefined : NOT_CONTROLLABLE_REASON;

  return (
    <section className="border-foreground/10 bg-card/60 space-y-1 rounded-2xl border p-5">
      <header className="flex flex-wrap items-center justify-between gap-3 pb-2">
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground text-xs font-medium tracking-[0.12em] uppercase">
            节点 {displayIndex}
          </span>
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <Icon icon={meta.icon} className="size-4" aria-hidden="true" />
            {meta.label}
          </span>
          <span className="text-muted-foreground text-xs">
            会话 {conversations.length}
          </span>
        </div>

        {node.state === 'offline' && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            title={disabledTitle}
            onClick={() => {
              offline.reset();
              online.mutate(node.id);
            }}
          >
            重新上线
          </Button>
        )}

        {(node.state === 'online' || node.state === 'unknown') && (
          <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
            <DialogTrigger
              render={
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  title={disabledTitle}
                />
              }
            >
              下线
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>下线节点 {displayIndex}？</DialogTitle>
                <DialogDescription>{OFFLINE_CONFIRM_TEXT}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setConfirmOpen(false);
                  }}
                >
                  取消
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => {
                    online.reset();
                    offline.mutate(node.id);
                    setConfirmOpen(false);
                  }}
                >
                  确认下线
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </header>

      {conversations.length === 0 ?
        <p className="text-muted-foreground py-1 text-xs">
          没有会话挂在这个节点下
        </p>
      : <ul className="divide-foreground/8 divide-y">
          {conversations.map((conversation) => (
            <ConversationRow
              key={conversation.id}
              conversation={conversation}
              nowMs={nowMs}
            />
          ))}
        </ul>
      }
    </section>
  );
}

/** 下线/上线失败时给用户看的一句话。`ConsoleApiError` 的 message 已经是人话。 */
function describeActionError(error: Error | null): string {
  return error !== null && error.message.length > 0 ?
      error.message
    : '请求没有成功，请稍后重试。';
}

function LoadingSkeleton() {
  return (
    <div className="space-y-4">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="border-foreground/8 bg-card/40 animate-pulse space-y-2 rounded-2xl border p-5"
          style={{ animationDelay: `${i * 80}ms` }}
        >
          <div className="bg-foreground/8 h-4 w-1/4 rounded" />
          <div className="bg-foreground/6 h-3 w-1/2 rounded" />
        </div>
      ))}
    </div>
  );
}

export function ConsolePage() {
  const overviewQuery = useConsoleOverview();
  const offline = useNodeOfflineMutation();
  const online = useNodeOnlineMutation();
  const overview = overviewQuery.data;
  const nowMs = useServerClock(overview?.now);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-8 px-6 py-10 sm:px-8 sm:py-14">
      <header className="space-y-3">
        <p className="text-muted-foreground text-[0.7rem] font-medium tracking-[0.18em] uppercase">
          Ops
        </p>
        <h1 className="font-display text-5xl leading-[1.02] tracking-tight">
          <span className="italic">集群控制台</span>
        </h1>
        <p className="text-muted-foreground max-w-prose text-sm leading-relaxed">
          每个会话此刻在哪个节点上跑、节点是不是在下线中，这里每 2 秒刷新一次。
        </p>
      </header>

      {overview?.opsError !== undefined ?
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle>连不上运维容器</AlertTitle>
          <AlertDescription>
            {overview.opsError}
            ——节点状态暂时只能靠租约推断，下线/上线按钮已禁用。
          </AlertDescription>
        </Alert>
      : overview !== undefined && !overview.controllable ?
        <Alert>
          <InfoIcon />
          <AlertTitle>这台服务端不能控制节点</AlertTitle>
          <AlertDescription>
            {NOT_CONTROLLABLE_REASON}，下面只能查看。
          </AlertDescription>
        </Alert>
      : null}

      {offline.isError || online.isError ?
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle>{offline.isError ? '下线失败' : '上线失败'}</AlertTitle>
          <AlertDescription>
            {describeActionError(offline.error ?? online.error)}
          </AlertDescription>
        </Alert>
      : null}

      {overviewQuery.isError ?
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle>加载失败</AlertTitle>
          <AlertDescription>
            {overviewQuery.error instanceof Error ?
              overviewQuery.error.message
            : '请刷新页面重试。'}
          </AlertDescription>
        </Alert>
      : overview === undefined ?
        <LoadingSkeleton />
      : (() => {
          const { byNodeUrl, unknown } = groupConversations(overview);
          return (
            <div className="space-y-4">
              {overview.nodes.length === 0 ?
                <p className="text-muted-foreground text-sm">
                  还没有节点上报。
                </p>
              : overview.nodes.map((node, position) => (
                  <NodeCard
                    key={node.id}
                    node={node}
                    position={position}
                    conversations={
                      node.url === null ? [] : (byNodeUrl.get(node.url) ?? [])
                    }
                    nowMs={nowMs}
                    controllable={overview.controllable}
                    offline={offline}
                    online={online}
                  />
                ))
              }

              {unknown.length > 0 && (
                <section className="border-foreground/10 bg-card/60 space-y-1 rounded-2xl border border-dashed p-5">
                  <header className="pb-2">
                    <span className="text-muted-foreground text-xs font-medium tracking-[0.12em] uppercase">
                      未知节点
                    </span>
                    <p className="text-muted-foreground mt-1 text-xs">
                      持有者地址对不上任何一个已知节点——大概率是节点刚重启、还没被运维容器扫到。
                    </p>
                  </header>
                  <ul className="divide-foreground/8 divide-y">
                    {unknown.map((conversation) => (
                      <ConversationRow
                        key={conversation.id}
                        conversation={conversation}
                        nowMs={nowMs}
                      />
                    ))}
                  </ul>
                </section>
              )}
            </div>
          );
        })()
      }
    </div>
  );
}
