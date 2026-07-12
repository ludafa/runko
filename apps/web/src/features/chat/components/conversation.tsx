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
      className={cn('relative flex-1 overflow-y-auto', className)}
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
  ...props
}: ConversationContentProps) {
  return (
    <StickToBottom.Content
      className={cn('flex flex-col gap-4 p-1', className)}
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
