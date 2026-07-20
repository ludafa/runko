import { useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import { createConversation, listConversations } from '@/features/chat/api';
import { SessionList } from '@/features/chat/components/conversation-list';
import type {
  Conversation,
  ConversationProvider,
} from '@/features/chat/schema';

export function ChatLayout({
  children,
  activeSessionId,
}: {
  children: ReactNode;
  activeSessionId: string | undefined;
}) {
  const navigate = useNavigate();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    listConversations(controller.signal)
      .then(setConversations)
      .catch(() => {
        /* left as an empty list; SessionList already handles the empty state */
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  async function handleCreate(title: string, provider: ConversationProvider) {
    setCreating(true);
    try {
      const conversation = await createConversation({
        ...(title.length > 0 ? { title } : {}),
        provider,
      });
      setConversations((prev) => [conversation, ...prev]);
      await navigate({
        to: '/chat/$conversationId',
        params: { conversationId: conversation.id },
      });
    } finally {
      setCreating(false);
    }
  }

  // 撑满 AppLayout 给的确定高度（flex-1 + min-h-0），侧栏与会话区都靠 grid 的默认
  // stretch 拿到高度，不再用 sticky + h-[calc(100vh-8rem)] 猜像素。窄屏是两行：
  // 侧栏按内容高、会话区吃掉剩下的（用 minmax(0,1fr) 而非 1fr，才允许里面的滚动
  // 容器收缩到比内容矮）。
  return (
    <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-6 md:grid-cols-[240px_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)]">
      <aside className="border-foreground/8 bg-card/40 min-h-0 overflow-hidden rounded-2xl border p-3">
        {loading ?
          <p className="text-muted-foreground px-1 py-4 text-center text-xs">
            加载中…
          </p>
        : <SessionList
            conversations={conversations}
            activeSessionId={activeSessionId}
            onCreate={handleCreate}
            creating={creating}
          />
        }
      </aside>
      <section className="flex min-h-0 min-w-0 flex-col">{children}</section>
    </div>
  );
}
