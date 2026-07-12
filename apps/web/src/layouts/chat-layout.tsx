import { useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import { createChatSession, listChatSessions } from '@/features/chat/api';
import { SessionList } from '@/features/chat/components/session-list';
import type { ChatSession } from '@/features/chat/schema';

export function ChatLayout({
  children,
  activeSessionId,
}: {
  children: ReactNode;
  activeSessionId: string | undefined;
}) {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    listChatSessions(controller.signal)
      .then(setSessions)
      .catch(() => {
        /* left as an empty list; SessionList already handles the empty state */
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  async function handleCreate(title: string) {
    setCreating(true);
    try {
      const session = await createChatSession(
        title.length > 0 ? { title } : {},
      );
      setSessions((prev) => [session, ...prev]);
      await navigate({
        to: '/chat/$sessionId',
        params: { sessionId: session.id },
      });
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="grid gap-6 md:grid-cols-[240px_minmax(0,1fr)] md:items-start">
      <aside className="border-foreground/8 bg-card/40 rounded-2xl border p-3 md:sticky md:top-24 md:h-[calc(100vh-8rem)]">
        {loading ?
          <p className="text-muted-foreground px-1 py-4 text-center text-xs">
            加载中…
          </p>
        : <SessionList
            sessions={sessions}
            activeSessionId={activeSessionId}
            onCreate={handleCreate}
            creating={creating}
          />
        }
      </aside>
      <section className="min-w-0">{children}</section>
    </div>
  );
}
