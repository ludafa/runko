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
  onSubmitApproval = noopDecision,
  onSubmitAnswer = noopDecision,
  conversationId,
}: {
  messages: readonly NimboUIMessage[];
  /** Short-lived — popped once the real turn-start `MessageFrame` arrives (see `use-chat-messages.ts`'s file header) — interleaved with `messages` at their sent-at position in the meantime. */
  pendingUserEchoes?: readonly PendingUserEcho[];
  /** `useChatMessages`'s own submitting/expired state (docs/tech/single-ledger.md §6) — threaded straight through to the approval/question cards, see that hook's doc comments. */
  submittingCallIds?: ReadonlySet<string>;
  locallyExpiredCallIds?: ReadonlySet<string>;
  onSubmitApproval?: (
    callId: string,
    behavior: 'allow' | 'allow-session' | 'deny',
  ) => void;
  onSubmitAnswer?: (callId: string, answer: string) => void;
  /** chat 会话 id——TurnStatsButton 遥测明细的查询键（docs/tech/chat-webapp.md §11.4），缺席时统计弹窗只出概览、没有明细。 */
  conversationId?: string;
}) {
  const entries = useMemo(
    () => buildRenderEntries(messages, pendingUserEchoes),
    [messages, pendingUserEchoes],
  );

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
              onSubmitApproval={onSubmitApproval}
              onSubmitAnswer={onSubmitAnswer}
              conversationId={conversationId}
            />,
        )}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}
