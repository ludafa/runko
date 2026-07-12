/**
 * Adapted from AI Elements' `message.tsx` `Message`/`MessageContent` (the
 * role-based bubble layout only — `MessageActions`/`MessageBranch`/markdown
 * rendering weren't needed here, see final report's dependency notes).
 */
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export function Message({
  from,
  children,
}: {
  from: 'user' | 'assistant';
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'group flex w-full max-w-[85%] flex-col gap-2',
        from === 'user' ? 'ml-auto items-end' : 'items-start',
      )}
    >
      {children}
    </div>
  );
}

export function MessageContent({
  from,
  children,
}: {
  from: 'user' | 'assistant';
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'w-fit max-w-full min-w-0 text-sm leading-relaxed whitespace-pre-wrap',
        from === 'user' ?
          'bg-secondary text-secondary-foreground rounded-2xl px-4 py-2.5'
        : 'text-foreground',
      )}
    >
      {children}
    </div>
  );
}
