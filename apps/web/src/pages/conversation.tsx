import { useEffect, useState } from 'react';

import { fetchConversationEvents, getConversation } from '@/features/chat/api';
import { MessageComposer } from '@/features/chat/components/message-composer';
import { ProviderBadge } from '@/features/chat/components/provider-badge';
import { TimelineView } from '@/features/chat/components/timeline-view';
import type { ChatReplayFrame, Conversation } from '@/features/chat/schema';
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

function ConversationContent({ conversationId }: { conversationId: string }) {
  const [conversation, setConversation] = useState<Conversation | undefined>(
    undefined,
  );
  const [initialFrames, setInitialFrames] = useState<
    ChatReplayFrame[] | undefined
  >(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);

  useEffect(() => {
    // No need to reset loadError here — the parent mounts this component with
    // `key={conversationId}`, so a conversation change remounts with fresh state.
    const controller = new AbortController();
    Promise.all([
      getConversation(conversationId, controller.signal),
      fetchConversationEvents(conversationId, { signal: controller.signal }),
    ])
      .then(([sessionDetail, frames]) => {
        setConversation(sessionDetail);
        setInitialFrames(frames);
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
  }, [conversationId]);

  if (loadError !== undefined) {
    return (
      <p className="text-destructive text-sm">加载会话失败：{loadError}</p>
    );
  }

  if (conversation === undefined || initialFrames === undefined) {
    return <HistoryLoadingSkeleton />;
  }

  return (
    <ConversationTimeline
      conversationId={conversationId}
      conversation={conversation}
      initialFrames={initialFrames}
    />
  );
}

function ConversationTimeline({
  conversationId,
  conversation,
  initialFrames,
}: {
  conversationId: string;
  conversation: Conversation;
  initialFrames: ChatReplayFrame[];
}) {
  const chat = useChatMessages(conversationId, initialFrames);
  const wasSleeping = conversation.status === 'sleeping';

  return (
    // 高度来自 ChatLayout 的 grid（section 是 flex 列），不再写死
    // h-[calc(100vh-8rem)]——那个魔数假设了 header + main 内边距正好 8rem，实际是
    // 8rem+45px，多出来的部分让文档整体可滚动，就成了「双滚动条 + 底部空白」。
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <header className="flex items-center justify-between">
        <h1 className="font-display text-xl italic">
          {conversation.title ?? '(未命名会话)'}
        </h1>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground font-mono text-xs">
            {conversation.branchName}
          </span>
          <ProviderBadge provider={conversation.provider} />
        </div>
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
          messages={chat.messages}
          pendingUserEchoes={chat.pendingUserEchoes}
          submittingCallIds={chat.submittingCallIds}
          locallyExpiredCallIds={chat.locallyExpiredCallIds}
          onSubmitApproval={chat.submitApproval}
          onSubmitAnswer={chat.submitAnswer}
          conversationId={conversationId}
        />
      </div>

      <MessageComposer
        onSend={chat.sendMessage}
        streaming={chat.status === 'streaming'}
      />
    </div>
  );
}

export function ConversationPage({
  conversationId,
}: {
  conversationId: string;
}) {
  return (
    <ChatLayout activeSessionId={conversationId}>
      {/* `key` forces a fresh mount per conversation — resets conversation/history/error state without an
          effect synchronously calling setState to clear it first (see file header). */}
      <ConversationContent
        key={conversationId}
        conversationId={conversationId}
      />
    </ChatLayout>
  );
}
