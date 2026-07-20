/**
 * Adapted from Vercel AI Elements' `conversation.tsx` (registry:
 * https://elements.ai-sdk.dev/api/registry/conversation.json) — same
 * stick-to-bottom-while-streaming behavior, dropped the `ai`-package-typed
 * `ConversationDownload`/markdown-export piece (irrelevant here) and the
 * `ai` import, otherwise structurally the same. `use-stick-to-bottom` has no
 * dependencies beyond React itself.
 */
import { ArrowDownIcon } from 'lucide-react';
import type { ComponentProps } from 'react';
import { useCallback } from 'react';
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type ConversationProps = ComponentProps<typeof StickToBottom>;

export function Conversation({ className, ...props }: ConversationProps) {
  return (
    <StickToBottom
      // 这里刻意不加 overflow-*：StickToBottom 真正的滚动容器是它内部那层
      // `scrollRef` div（库在 layout effect 里把它的 overflow 设成 auto），外层
      // 再来一个 overflow-y-auto 只是多套了一个滚动容器。改用 min-h-0 让这个
      // flex item 能收缩到比内容矮——原先是靠 overflow 把 min-height:auto 压成 0。
      className={cn('relative min-h-0 flex-1', className)}
      initial="smooth"
      resize="smooth"
      role="log"
      {...props}
    />
  );
}

export type ConversationContentProps = ComponentProps<
  typeof StickToBottom.Content
>;

export function ConversationContent({
  className,
  scrollClassName,
  ...props
}: ConversationContentProps) {
  return (
    <StickToBottom.Content
      // relative 是修「最后一条消息之后还能滚出大片空白」的关键：消息里的
      // `sr-only` 文案（如 TurnStatsButton 的「统计」）是 position:absolute，
      // 若滚动容器自身不是定位元素，它们的包含块会落到外层那个 `relative` div
      // 上——于是既不跟着滚动、也不被滚动容器裁剪，而是停在「未滚动时的静态
      // 位置」上，把外层的 scrollHeight 撑出上千像素的空白。把滚动容器本身设为
      // 定位元素，这些绝对定位后代就回到它内部，正常被裁剪。
      // overscroll-contain：滚到消息列表两端时不要把滚动「续传」给外层 main。
      scrollClassName={cn('relative overscroll-contain', scrollClassName)}
      // `min-h-full justify-end`：会话短于滚动视口时把消息锚定到底部（最新
      // 消息贴着输入框，空白挪到顶部——聊天惯例），而不是顶对齐、下方留一大片
      // 空白到 composer。内容溢出时 min-h-full 由内容自身满足、justify-end 空转，
      // 照常滚动，不影响 StickToBottom 的贴底行为。
      className={cn(
        'flex min-h-full flex-col justify-end gap-4 p-1',
        className,
      )}
      {...props}
    />
  );
}

export function ConversationEmptyState({
  title = '还没有消息',
  description = '发送第一条消息开始与 agent 对话',
}: {
  title?: string;
  description?: string;
}) {
  return (
    <div className="flex size-full flex-col items-center justify-center gap-1.5 p-8 text-center">
      <p className="text-foreground text-sm font-medium">{title}</p>
      <p className="text-muted-foreground text-sm">{description}</p>
    </div>
  );
}

export function ConversationScrollButton({
  className,
  ...props
}: ComponentProps<typeof Button>) {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  const handleClick = useCallback(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  if (isAtBottom) return null;

  return (
    <Button
      className={cn(
        'absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full',
        className,
      )}
      onClick={handleClick}
      size="icon-sm"
      type="button"
      variant="outline"
      {...props}
    >
      <ArrowDownIcon className="size-4" />
    </Button>
  );
}
