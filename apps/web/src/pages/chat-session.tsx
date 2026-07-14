import { useEffect, useState } from 'react';

import { fetchAllChatSessionEvents, getChatSession } from '@/features/chat/api';
import { MessageComposer } from '@/features/chat/components/message-composer';
import { TimelineView } from '@/features/chat/components/timeline-view';
import type { ChatSession, ChatStreamEnvelope } from '@/features/chat/schema';
import { useChatMessages } from '@/features/chat/use-chat-messages';
import { ChatLayout } from '@/layouts/chat-layout';

function HistoryLoadingSkeleton() {
  return (
    <ul className="divide-foreground/8 border-foreground/8 bg-card/40 divide-y rounded-2xl border">
      {[0, 1, 2].map((i) => (
        <li
          key={i}
          className="animate-pulse space-y-2 px-5 py-4"
          style={{ animationDelay: `${String(i * 80)}ms` }}
        >
          <div className="bg-foreground/8 h-4 w-1/3 rounded" />
          <div className="bg-foreground/6 h-3 w-2/3 rounded" />
        </li>
      ))}
    </ul>
  );
}

function ChatSessionContent({ sessionId }: { sessionId: string }) {
  const [session, setSession] = useState<ChatSession | undefined>(undefined);
  const [initialEnvelopes, setInitialEnvelopes] = useState<
    ChatStreamEnvelope[] | undefined
  >(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);

  useEffect(() => {
    // No need to reset loadError here — the parent mounts this component with
    // `key={sessionId}`, so a session change remounts with fresh state.
    const controller = new AbortController();
    Promise.all([
      getChatSession(sessionId, controller.signal),
      fetchAllChatSessionEvents(sessionId, { signal: controller.signal }),
    ])
      .then(([sessionDetail, events]) => {
        setSession(sessionDetail);
        setInitialEnvelopes(events);
      })
      .catch((error: unknown) => {
        // Swallow the abort that fires when this effect is torn down (route
        // change, or React StrictMode's dev double-mount) — it is not a load
        // failure, and letting it set loadError would clobber the successful
        // second mount's state. Mirrors the SSE hook's AbortError handling.
        if (controller.signal.aborted) return;
        setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, [sessionId]);

  if (loadError !== undefined) {
    return (
      <p className="text-destructive text-sm">加载会话失败：{loadError}</p>
    );
  }

  if (session === undefined || initialEnvelopes === undefined) {
    return <HistoryLoadingSkeleton />;
  }

  return (
    <ChatSessionTimeline
      sessionId={sessionId}
      session={session}
      initialEnvelopes={initialEnvelopes}
    />
  );
}

function ChatSessionTimeline({
  sessionId,
  session,
  initialEnvelopes,
}: {
  sessionId: string;
  session: ChatSession;
  initialEnvelopes: ChatStreamEnvelope[];
}) {
  const chat = useChatMessages(sessionId, initialEnvelopes);
  const wasSleeping = session.status === 'sleeping';

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col gap-3">
      <header className="flex items-center justify-between">
        <h1 className="font-display text-xl italic">
          {session.title ?? '(未命名会话)'}
        </h1>
        <span className="text-muted-foreground font-mono text-xs">
          {session.branchName}
        </span>
      </header>

      {wasSleeping && chat.awaitingFirstEvent && (
        <div className="text-muted-foreground border-foreground/10 bg-card/60 flex items-center gap-2 rounded-xl border px-3 py-2 text-xs">
          沙盒恢复中…
        </div>
      )}

      {chat.status === 'error' && chat.error !== undefined && (
        <p className="text-destructive text-xs">
          连接中断：{chat.error}（已尝试补齐已产生的事件）
        </p>
      )}

      {/* flex flex-col is load-bearing: TimelineView's StickToBottom sizes
          itself with flex-1, which only constrains its height inside a flex
          parent. A plain block wrapper here let the scroller grow to full
          content height and overflow onto the composer (verified box model:
          scroller 2891px inside a 314px wrapper). */}
      <div className="flex min-h-0 flex-1 flex-col">
        <TimelineView
          envelopes={chat.envelopes}
          optimisticMessages={chat.optimisticMessages}
          submittingCallIds={chat.submittingCallIds}
          locallyExpiredCallIds={chat.locallyExpiredCallIds}
          onSubmitApproval={chat.submitApproval}
          onSubmitAnswer={chat.submitAnswer}
        />
      </div>

      <MessageComposer
        onSend={chat.sendMessage}
        streaming={chat.status === 'streaming'}
      />
    </div>
  );
}

export function ChatSessionPage({ sessionId }: { sessionId: string }) {
  return (
    <ChatLayout activeSessionId={sessionId}>
      {/* `key` forces a fresh mount per session — resets session/history/error state without an
          effect synchronously calling setState to clear it first (see file header). */}
      <ChatSessionContent key={sessionId} sessionId={sessionId} />
    </ChatLayout>
  );
}
