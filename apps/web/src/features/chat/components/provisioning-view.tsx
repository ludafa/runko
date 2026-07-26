/**
 * 新建会话期间占住会话区的「准备中」视图（docs/features/chat-ui.md「建会话的等待反馈」）。
 *
 * 建一个会话要开沙盒、clone 仓库、装 skill、建分支，实测 9 秒起（provider 与
 * 仓库大小都会拉长它）。这段时间里服务端只有一个同步请求在跑、没有进度可推，
 * 所以这里的阶段是**按实测耗时估的**，不是真进度——刻意不画百分比进度条、不给
 * 「还剩 N 秒」，避免用假精度骗人；能给的诚实信息只有两条：走到哪一步了、已经
 * 等了多久。
 *
 * 阶段时间点取自 E2B 真机实测（建盒 1.4s / clone 2.1s / 装 skill 3.3s / 配置
 * + 建分支 2.2s）。最后一个阶段**不会自己走完**——它停在那儿直到请求真的返回，
 * 因为超时多久是不知道的；拖过 SLOW_HINT_MS 就多说一句「比平时久」。
 */
import { CheckIcon, LoaderIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';

import type { ConversationProvider } from '../schema';

interface Phase {
  key: string;
  label: string;
  /** 从点击算起、预计进入这一步的时刻。 */
  startsAtMs: number;
}

const PHASES: Phase[] = [
  { key: 'create', label: '创建沙盒', startsAtMs: 0 },
  { key: 'clone', label: '拉取仓库代码', startsAtMs: 1500 },
  { key: 'skill', label: '安装 frontend-design 技能', startsAtMs: 3600 },
  { key: 'branch', label: '准备工作分支', startsAtMs: 6900 },
];

/** 超过这个时长就承认「比平时慢」，而不是继续假装一切正常。 */
const SLOW_HINT_MS = 20_000;

const TICK_MS = 250;

/** 当前走到第几步：最后一步只进不出，等真正返回。 */
function activePhaseIndex(elapsedMs: number): number {
  let index = 0;
  for (let i = 0; i < PHASES.length; i++) {
    const phase = PHASES[i];
    if (phase !== undefined && elapsedMs >= phase.startsAtMs) index = i;
  }
  return index;
}

/**
 * 已等待时长。初值由 lazy initializer 给准，effect 只管起 interval——`startedAt`
 * 变了（重试）靠调用方的 `key` 重挂拿到新初值，不在 effect 里同步 setState
 * （那会多一轮级联渲染，且重试瞬间会闪一下上一次的秒数）。
 */
function useElapsedMs(startedAt: number): number {
  const [elapsedMs, setElapsedMs] = useState(() => Date.now() - startedAt);

  useEffect(() => {
    const timer = setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [startedAt]);

  return elapsedMs;
}

export function ProvisioningView({
  title,
  provider,
  startedAt,
}: {
  title: string;
  provider: ConversationProvider;
  startedAt: number;
}) {
  const elapsedMs = useElapsedMs(startedAt);
  const activeIndex = activePhaseIndex(elapsedMs);
  const seconds = Math.floor(elapsedMs / 1000);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* 占住 BranchHeader 的位置，就绪后原地换成真的，不跳版 */}
      <div className="border-border flex items-center gap-2 border-b pb-2">
        <LoaderIcon
          className="text-muted-foreground size-3.5 shrink-0 animate-spin"
          aria-hidden="true"
        />
        <span className="truncate text-[0.8125rem] leading-snug">
          {title.length > 0 ? title : '新会话'}
        </span>
        <span className="text-muted-foreground shrink-0 font-mono text-[0.6875rem]">
          {provider}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 pl-7">
        <ol
          className="relative flex flex-col gap-2"
          role="status"
          aria-live="polite"
        >
          <span
            aria-hidden="true"
            className="bg-rail absolute top-2 bottom-2 left-[-13px] w-px"
          />
          {PHASES.map((phase, index) => {
            const done = index < activeIndex;
            const current = index === activeIndex;
            return (
              <li
                key={phase.key}
                className={cn(
                  'flex items-center gap-2 text-[0.8125rem] leading-snug transition-colors',
                  done && 'text-muted-foreground',
                  current && 'text-foreground',
                  !done && !current && 'text-muted-foreground/50',
                )}
              >
                <span className="flex size-3.5 shrink-0 items-center justify-center">
                  {done ?
                    <CheckIcon className="size-3.5" aria-hidden="true" />
                  : current ?
                    <LoaderIcon
                      className="size-3.5 animate-spin"
                      aria-hidden="true"
                    />
                  : <span className="border-muted-foreground/40 size-1.5 rounded-full border" />
                  }
                </span>
                {phase.label}
                {current && (
                  <span className="text-muted-foreground ml-auto font-mono text-[0.6875rem] tabular-nums">
                    {seconds}s
                  </span>
                )}
              </li>
            );
          })}
        </ol>

        {elapsedMs >= SLOW_HINT_MS && (
          <p className="text-muted-foreground border-border border-l-2 py-0.5 pl-3 text-xs leading-snug">
            比平时久一些，仍在继续。首次为这个仓库开沙盒会慢一点。
          </p>
        )}

        {/* 时间线骨架：就绪后这块换成真实时间线，高度不跳 */}
        <div aria-hidden="true" className="flex flex-col gap-4 opacity-40">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="animate-pulse space-y-2"
              style={{ animationDelay: `${String(i * 120)}ms` }}
            >
              <div className="bg-muted h-3.5 w-1/3 rounded-sm" />
              <div className="bg-muted h-3 w-2/3 rounded-sm" />
            </div>
          ))}
        </div>
      </div>

      {/* 占住 composer 的位置——形状对得上，就绪后不跳版 */}
      <div
        aria-hidden="true"
        className="border-border text-muted-foreground/60 rounded-md border px-3 py-2.5 text-sm"
      >
        工作区准备好后就能发消息
      </div>
    </div>
  );
}

/**
 * 建会话失败。此前这里什么都不显示——`handleCreate` 只有 `finally`、没有
 * `catch`，请求一挂错误就被吞了，按钮弹回可点，用户完全不知道发生了什么。
 */
export function ProvisioningError({
  title,
  message,
  onRetry,
  onDismiss,
}: {
  title: string;
  message: string;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-3 pt-2">
      <p className="text-muted-foreground text-[0.6875rem] font-medium tracking-[0.02em]">
        建会话失败
      </p>
      <p className="text-foreground text-base">
        没能为「{title.length > 0 ? title : '新会话'}」准备好工作区。
      </p>
      <p className="border-destructive/70 text-destructive max-w-[52ch] border-l-2 py-0.5 pl-3 text-xs leading-relaxed">
        {message}
      </p>
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={onRetry}
          className="border-border hover:bg-muted rounded-md border px-3 py-1.5 text-xs transition-colors"
        >
          重试
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="text-muted-foreground hover:text-foreground px-2 py-1.5 text-xs transition-colors"
        >
          返回
        </button>
      </div>
    </div>
  );
}
