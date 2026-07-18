import { Link } from '@tanstack/react-router';
import { PlusIcon } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

import type { Conversation } from '../schema';
import { SessionStatusBadge } from './conversation-status-badge';

export function SessionList({
  conversations,
  activeSessionId,
  onCreate,
  creating,
}: {
  conversations: Conversation[];
  activeSessionId: string | undefined;
  onCreate: (title: string) => void;
  creating: boolean;
}) {
  const [title, setTitle] = useState('');

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    onCreate(title.trim());
    setTitle('');
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <form onSubmit={handleCreate} className="flex gap-1.5">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="新会话标题（可选）"
          className="h-8 text-xs"
        />
        <Button
          type="submit"
          size="icon-sm"
          disabled={creating}
          aria-label="新建会话"
        >
          <PlusIcon className="size-4" />
        </Button>
      </form>

      <nav
        className="flex flex-1 flex-col gap-1 overflow-y-auto"
        aria-label="会话列表"
      >
        {conversations.length === 0 ?
          <p className="text-muted-foreground px-1 py-4 text-center text-xs">
            还没有会话
          </p>
        : conversations.map((conversation) => (
            <Link
              key={conversation.id}
              to="/chat/$conversationId"
              params={{ conversationId: conversation.id }}
              className={cn(
                'hover:bg-foreground/[0.04] flex flex-col gap-1 rounded-lg px-2.5 py-2 transition-colors',
                conversation.id === activeSessionId && 'bg-foreground/[0.06]',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">
                  {conversation.title ?? '(未命名会话)'}
                </span>
                <SessionStatusBadge status={conversation.status} />
              </div>
              <span className="text-muted-foreground truncate font-mono text-[0.65rem]">
                {conversation.branchName}
              </span>
            </Link>
          ))
        }
      </nav>
    </div>
  );
}
