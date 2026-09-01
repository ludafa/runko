import { useEffect, useState } from 'react';

import {
  fetchConversationMessages,
  getConversation,
} from '@/features/chat/api';
import { BranchHeader } from '@/features/chat/components/branch-header';
import { MessageComposer } from '@/features/chat/components/message-composer';
import { QueuedMessages } from '@/features/chat/components/queued-messages';
import { TimelineView } from '@/features/chat/components/timeline-view';
import type { ChatReplayFrame, Conversation } from '@/features/chat/schema';
import { useChatMessages } from '@/features/chat/use-chat-messages';
import { usePresence } from '@/features/chat/use-presence';
import { ChatLayout } from '@/layouts/chat-layout';

/** 回放到达前的骨架：直接摆成轨道的样子，历史落位时不会跳版。 */
function HistoryLoadingSkeleton() {
  return (
    <div className="relative flex flex-col gap-4 pl-7">
      <span
        aria-hidden="true"
        className="bg-rail absolute top-1 bottom-1 left-[7px] w-px"
      />
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="animate-pulse space-y-2"
          style={{ animationDelay: `${String(i * 80)}ms` }}
        >
          <div className="bg-muted h-3.5 w-1/3 rounded-sm" />
          <div className="bg-muted h-3 w-2/3 rounded-sm" />
        </div>
      ))}
    </div>
  );
}

function ConversationContent({ conversationId }: { conversationId: string }) {
  // [在场](../../../docs/terms.md)上报（docs/tech/push-notification.md §5.2）：人正
  // 盯着这条会话时，服务端不推送本会话的通知——卡片已经在眼前了。挂在这里而不是
  // 更内层，是因为它只需要 conversationId，且历史还在加载时人就已经"在看"了。
  usePresence(conversationId);

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
      fetchConversationMessages(conversationId, { signal: controller.signal }),
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
        if (controller.signal.aborted) {
          return;
        }
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
  // 队列初值来自会话详情（docs/tech/steer-and-queue.md §4.2）——之后由直播流的
  // `QueueFrame` 快照接管，不再读这份初值。
  const chat = useChatMessages(
    conversationId,
    initialFrames,
    conversation.queuedMessages,
    // 「有没有轮在跑」的初值同样来自会话详情——服务端读[起轮标记](../../../../docs/terms.md)
    // 那一列给出的权威答案，不再靠前端猜（见 `use-chat-messages.ts` 的同名参数）。
    conversation.turnInProgress,
  );
  const wasSleeping = conversation.status === 'sleeping';

  return (
    // 高度来自 ChatLayout 的 grid（section 是 flex 列），不再写死
    // h-[calc(100vh-8rem)]——那个魔数假设了 header + main 内边距正好 8rem，实际是
    // 8rem+45px，多出来的部分让文档整体可滚动，就成了「双滚动条 + 底部空白」。
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <BranchHeader conversation={conversation} messages={chat.messages} />

      {wasSleeping && chat.awaitingFirstEvent && (
        <p className="text-muted-foreground border-border border-l-2 py-0.5 pl-3 text-xs leading-snug">
          正在唤醒沙盒，分支代码会原样还原。
        </p>
      )}

      {chat.status === 'error' && chat.error !== undefined && (
        <p className="border-destructive/70 text-destructive border-l-2 py-0.5 pl-3 text-xs leading-snug">
          直播中断：{chat.error} · 已补齐断线期间产生的事件
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
          // 轮一结束，还挂着的审批/提问卡片就已经失效了（服务端的挂起项被结掉了）
          // ——界面立刻如实画成「已失效」，而不是等用户点下去吃 404 才翻。
          turnInProgress={chat.status === 'streaming'}
          // 消息发出到这一轮第一帧到达之间（起轮装配，冷启动可达数十秒），AI 侧摆一个
          // 「正在准备…」占位——否则用户只看到自己那条消息孤零零地挂着。
          awaitingFirstEvent={chat.awaitingFirstEvent}
          onSubmitApproval={chat.submitApproval}
          onSubmitAnswer={chat.submitAnswer}
          conversationId={conversationId}
        />
      </div>

      {/* 待发区与 composer 是同一件事的两个阶段——贴在一起，不留缝。 */}
      <div className="flex flex-col">
        <QueuedMessages
          messages={chat.queuedMessages}
          onRemove={chat.removeQueuedMessage}
          onPromote={chat.promoteQueuedMessage}
          onClear={chat.clearQueue}
          streaming={chat.status === 'streaming'}
        />
        <MessageComposer
          onSend={chat.sendMessage}
          onStop={chat.stopTurn}
          stopping={chat.stopping}
          streaming={chat.status === 'streaming'}
          skills={conversation.availableSkills}
        />
      </div>
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
