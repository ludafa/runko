import { Link } from '@tanstack/react-router';
import { PlusIcon } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

import type { Conversation, ConversationProvider } from '../schema';
import { SessionStatusBadge } from './conversation-status-badge';
import { ProviderBadge } from './provider-badge';

const PROVIDER_OPTIONS: { value: ConversationProvider; label: string }[] = [
  { value: 'vercel', label: 'Vercel' },
  { value: 'e2b', label: 'E2B' },
];

export function SessionList({
  conversations,
  activeSessionId,
  onCreate,
  creating,
}: {
  conversations: Conversation[];
  activeSessionId: string | undefined;
  onCreate: (title: string, provider: ConversationProvider) => void;
  creating: boolean;
}) {
  const [title, setTitle] = useState('');
  // Defaults to 'vercel' — matches the server's own `SANDBOX_PROVIDER` default
  // (docs/tech/sandbox-provider.md §6); the UI always sends the choice explicitly.
  const [provider, setProvider] = useState<ConversationProvider>('vercel');

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    onCreate(title.trim(), provider);
    setTitle('');
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <form onSubmit={handleCreate} className="flex flex-col gap-1.5">
        <div className="flex gap-1.5">
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
        </div>
        <div
          role="group"
          aria-label="沙盒 provider"
          className="bg-foreground/[0.04] flex gap-0.5 rounded-lg p-0.5"
        >
          {PROVIDER_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setProvider(option.value)}
              disabled={creating}
              aria-pressed={provider === option.value}
              className={cn(
                'flex-1 rounded-md px-2 py-1 text-[0.7rem] font-medium transition-colors disabled:opacity-50',
                provider === option.value ?
                  'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
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
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground truncate font-mono text-[0.65rem]">
                  {conversation.branchName}
                </span>
                <ProviderBadge provider={conversation.provider} />
              </div>
            </Link>
          ))
        }
      </nav>
    </div>
  );
}
