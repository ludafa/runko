import type { NimboUIMessage } from '@nimbo/core';
import { useMemo } from 'react';

import type { PendingUserEcho } from '../timeline';
import { buildRenderEntries } from '../timeline';
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from './conversation';
import { Message, MessageContent } from './message';
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
          <ConversationEmptyState />
        </ConversationContent>
      </Conversation>
    );
  }

  return (
    <Conversation>
      <ConversationContent>
        {entries.map((entry) =>
          entry.kind === 'pending-echo' ?
            <Message key={`pending-echo-${String(entry.echo.id)}`} from="user">
              <MessageContent from="user">{entry.echo.text}</MessageContent>
            </Message>
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
