import { useMemo } from 'react';

import type { ChatStreamEnvelope } from '../schema';
import { buildTimeline } from '../timeline';
import type { OptimisticUserMessage } from '../use-chat-messages';
import { ApprovalCard } from './approval-card';
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from './conversation';
import { ItemCard } from './item-card';
import { Message, MessageContent } from './message';
import { QuestionCard } from './question-card';
import { TurnFailedBar, TurnStartedMarker } from './turn-marker';
import { TurnResultBar } from './turn-result-bar';

/** No-op default so `submitApproval`/`submitAnswer` are optional for callers (e.g. tests, or a read-only preview) that never need the interactive path. */
function noopDecision(): void {
  /* intentionally empty */
}

// Stable identity (not a fresh `new Set()` per render) — used as the default
// for both `submittingCallIds` and `locallyExpiredCallIds` below so a caller
// that never passes them doesn't invalidate `buildTimeline`'s `useMemo` on
// every render.
const EMPTY_CALL_ID_SET: ReadonlySet<string> = new Set();

export function TimelineView({
  envelopes,
  optimisticMessages = [],
  submittingCallIds = EMPTY_CALL_ID_SET,
  locallyExpiredCallIds = EMPTY_CALL_ID_SET,
  onSubmitApproval = noopDecision,
  onSubmitAnswer = noopDecision,
}: {
  envelopes: readonly ChatStreamEnvelope[];
  /** Not yet confirmed by a server `user.message` envelope — rendered after the confirmed timeline, see use-chat-messages.ts. */
  optimisticMessages?: readonly OptimisticUserMessage[];
  /** `useChatMessages`'s own submitting/expired state (docs/08 §2.2c（审批链）) — threaded straight through to `buildTimeline`/the approval/question cards, see that hook's doc comments. */
  submittingCallIds?: ReadonlySet<string>;
  locallyExpiredCallIds?: ReadonlySet<string>;
  onSubmitApproval?: (callId: string, behavior: 'allow' | 'deny') => void;
  onSubmitAnswer?: (callId: string, answer: string) => void;
}) {
  const entries = useMemo(
    () => buildTimeline(envelopes, { locallyExpiredCallIds }),
    [envelopes, locallyExpiredCallIds],
  );

  if (entries.length === 0 && optimisticMessages.length === 0) {
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
        {entries.map((entry) => {
          switch (entry.kind) {
            case 'session-started':
              return null;
            case 'user-message':
              return (
                <Message key={`user-${String(entry.seq)}`} from="user">
                  <MessageContent from="user">{entry.text}</MessageContent>
                </Message>
              );
            case 'turn-started':
              return (
                <TurnStartedMarker
                  key={`turn-${String(entry.turn)}`}
                  turn={entry.turn}
                />
              );
            case 'turn-failed':
              return (
                <TurnFailedBar
                  key={`turn-failed-${String(entry.seq)}`}
                  error={entry.error}
                />
              );
            case 'turn-result':
              return (
                <TurnResultBar
                  key={`turn-result-${String(entry.seq)}`}
                  usage={entry.usage}
                />
              );
            case 'item':
              return (
                <ItemCard
                  key={`item-${entry.id}`}
                  item={entry.item}
                  lifecycle={entry.lifecycle}
                />
              );
            case 'approval':
              return (
                <ApprovalCard
                  key={`approval-${entry.callId}`}
                  entry={entry}
                  submitting={submittingCallIds.has(entry.callId)}
                  onDecide={(behavior) => {
                    onSubmitApproval(entry.callId, behavior);
                  }}
                />
              );
            case 'question':
              return (
                <QuestionCard
                  key={`question-${entry.callId}`}
                  entry={entry}
                  submitting={submittingCallIds.has(entry.callId)}
                  onAnswer={(answer) => {
                    onSubmitAnswer(entry.callId, answer);
                  }}
                />
              );
          }
        })}
        {optimisticMessages.map((message) => (
          <Message key={`optimistic-${String(message.id)}`} from="user">
            <MessageContent from="user">{message.text}</MessageContent>
          </Message>
        ))}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}
