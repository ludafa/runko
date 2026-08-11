import type { NimboUIMessage } from '@nimbo/core';
import { MessageSquareIcon } from 'lucide-react';
import { useMemo } from 'react';

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { Message, MessageContent } from '@/components/ai-elements/message';
import { Shimmer } from '@/components/ai-elements/shimmer';

import type { PendingUserEcho } from '../timeline';
import { buildRenderEntries } from '../timeline';
import { MessageEntry } from './message-entry';

/** No-op default so `onSubmitApproval`/`onSubmitAnswer` are optional for callers (e.g. tests, or a read-only preview) that never need the interactive path. */
function noopDecision(): void {
  /* intentionally empty */
}

// Stable identity (not a fresh `[]`/`new Set()` per render) — used as the
// default for `pendingUserEchoes`/`submittingCallIds`/`locallyExpiredCallIds`
// below so a caller that never passes them doesn't invalidate
// `buildRenderEntries`'s `useMemo` on every render.
const EMPTY_ECHOES: readonly PendingUserEcho[] = [];
const EMPTY_CALL_ID_SET: ReadonlySet<string> = new Set();

/**
 * 消息已经发出去、这一轮的**第一帧还没到**时，AI 侧的等待占位。
 *
 * 为什么需要：用户那条消息是同步乐观上屏的（下面 `PendingEchoMessage`），可 AI 侧要等
 * 整段[起轮装配](../../../../../docs/terms.md)跑完（取沙盒 → 续期 → 扫 skill → 建
 * session）才会出现第一个「思考中…」——冷启动时那是好几秒到几十秒的空白，用户不知道
 * 消息到底有没有被收到。
 *
 * 文案刻意**不是**「思考中…」：那一刻 agent 根本还没开始跑，说它在思考是假的。用同一个
 * `Shimmer` 效果保持视觉连续（等第一帧到达，这个占位就被真的「思考中…」顶替）。
 */
function AwaitingFirstEventMessage() {
  return (
    <Message from="assistant" data-testid="awaiting-first-event">
      <MessageContent>
        <Shimmer duration={1}>正在准备…</Shimmer>
      </MessageContent>
    </Message>
  );
}

/**
 * 还没落账本的用户消息（乐观回显）。两种成色：
 *
 * - **起新一轮**：几乎立刻被真实消息顶替，画得和正常用户消息一样即可。
 * - **[插话](../../../../../docs/terms.md)**：要等 core 的下一个 step 边界才真正注入，可能几十秒。压暗 +
 *   标「待注入」，如实说明「已经发出去了，但 agent 还没看到」。
 */
function PendingEchoMessage({ echo }: { echo: PendingUserEcho }) {
  const steered = echo.steered === true;
  return (
    <Message from="user" className={steered ? 'opacity-60' : undefined}>
      {steered && (
        <span className="text-muted-foreground ml-auto text-[0.6875rem]">
          插话 · 待注入
        </span>
      )}
      <MessageContent>{echo.text}</MessageContent>
    </Message>
  );
}

export function TimelineView({
  messages,
  pendingUserEchoes = EMPTY_ECHOES,
  submittingCallIds = EMPTY_CALL_ID_SET,
  locallyExpiredCallIds = EMPTY_CALL_ID_SET,
  turnInProgress = true,
  awaitingFirstEvent = false,
  onSubmitApproval = noopDecision,
  onSubmitAnswer = noopDecision,
  conversationId,
}: {
  messages: readonly NimboUIMessage[];
  /** Short-lived — popped once the real turn-start `MessageFrame` arrives (see `use-chat-messages.ts`'s file header) — interleaved with `messages` at their sent-at position in the meantime. */
  pendingUserEchoes?: readonly PendingUserEcho[];
  /** `useChatMessages`'s own submitting/expired state (docs/agent/single-ledger/tech.md §6) — threaded straight through to the approval/question cards, see that hook's doc comments. */
  submittingCallIds?: ReadonlySet<string>;
  locallyExpiredCallIds?: ReadonlySet<string>;
  /** 这个会话此刻有没有[轮](../../../../../docs/terms.md)在跑——轮结束后还没落定的审批/提问卡片一律显示成「已失效」（见 `MessageEntry` 的同名 prop）。缺省 `true`。 */
  turnInProgress?: boolean;
  /** 消息已发出、这一轮的第一帧还没到（`useChatMessages` 的同名字段）——为真时在时间线末尾摆一个 AI 侧的等待占位，见 `AwaitingFirstEventMessage`。缺省 `false`。 */
  awaitingFirstEvent?: boolean;
  onSubmitApproval?: (
    callId: string,
    behavior: 'allow' | 'allow-session' | 'deny',
  ) => void;
  onSubmitAnswer?: (callId: string, answer: string) => void;
  /** chat 会话 id——TurnStatsButton 遥测明细的查询键（docs/app/chat-webapp/tech.md §11.4），缺席时统计弹窗只出概览、没有明细。 */
  conversationId?: string;
}) {
  const entries = useMemo(
    () => buildRenderEntries(messages, pendingUserEchoes),
    [messages, pendingUserEchoes],
  );

  /**
   * 属于**已经收尾的轮**的那些消息的 id。
   *
   * `turnInProgress` 是**会话级**的（「此刻有没有轮在跑」），而一张卡片属于**某一轮**
   * ——只用会话级那个布尔会出一个真实的 bug：上一轮停掉、卡片已正确显示为「已失效」，
   * 用户再发一句「继续」起了新一轮，会话又「有轮在跑」了，于是**历史里那张早该失效的
   * 卡片会跟着复活成可点的「待审批」**（用户实测报告）。
   *
   * 判据来自[账本](../../../../../docs/terms.md)自身的结构：每一轮都以一条带终态
   * `metadata.status` 的 assistant 消息收尾（`loop.ts` 的 `finalizeTurn`）。所以从后往前
   * 扫，遇到的第一条收尾消息——**它自己和它之前的所有消息**——都属于已经结束的轮；只有
   * 它之后那一段才可能是当前这一轮。
   */
  const settledMessageIds = useMemo(() => {
    const ids = new Set<string>();
    let seenTurnEnd = false;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message === undefined) continue;
      if (seenTurnEnd) {
        ids.add(message.id);
        continue;
      }
      if (message.metadata?.status !== undefined) {
        seenTurnEnd = true;
        ids.add(message.id); // 收尾消息自己也算——那一轮就是在它这里结束的
      }
    }
    return ids;
  }, [messages]);

  if (entries.length === 0) {
    return (
      <Conversation>
        <ConversationContent>
          <ConversationEmptyState
            icon={<MessageSquareIcon className="size-10" />}
            title="这条分支还没有指令"
            description="描述你想让 agent 做什么，它会在这条分支上动手。"
          />
        </ConversationContent>
      </Conversation>
    );
  }

  return (
    <Conversation>
      <ConversationContent>
        {entries.map((entry) =>
          entry.kind === 'pending-echo' ?
            <PendingEchoMessage
              key={`pending-echo-${String(entry.echo.id)}`}
              echo={entry.echo}
            />
          : <MessageEntry
              key={`message-${entry.message.id}`}
              message={entry.message}
              submittingCallIds={submittingCallIds}
              locallyExpiredCallIds={locallyExpiredCallIds}
              // 「**这条消息所属的那一轮**还活着吗」：会话里有轮在跑 **且** 这条消息不
              // 属于任何已收尾的轮。两个条件缺一不可（见 `settledMessageIds` 的注释）。
              turnLive={
                turnInProgress && !settledMessageIds.has(entry.message.id)
              }
              onSubmitApproval={onSubmitApproval}
              onSubmitAnswer={onSubmitAnswer}
              conversationId={conversationId}
            />,
        )}
        {/* 恒在最末：用户那条消息已经上屏了，这一格是 AI 侧的「收到了，正在准备」。
            第一帧一到（`awaitingFirstEvent` 翻假），它就被真的内容顶替。 */}
        {awaitingFirstEvent && <AwaitingFirstEventMessage />}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}
