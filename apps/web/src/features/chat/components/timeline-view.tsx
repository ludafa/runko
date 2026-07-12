import { useMemo } from 'react';

import type { ChatStreamEnvelope } from '../schema';
import { buildTimeline } from '../timeline';
import type { OptimisticUserMessage } from '../use-chat-messages';
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from './conversation';
import { ItemCard } from './item-card';
import { Message, MessageContent } from './message';
import { TurnFailedBar, TurnStartedMarker } from './turn-marker';
import { TurnResultBar } from './turn-result-bar';

export function TimelineView({
  envelopes,
  optimisticMessages = [],
}: {
  envelopes: readonly ChatStreamEnvelope[];
  /** Not yet confirmed by a server `user.message` envelope — rendered after the confirmed timeline, see use-chat-messages.ts. */
  optimisticMessages?: readonly OptimisticUserMessage[];
}) {
  const entries = useMemo(() => buildTimeline(envelopes), [envelopes]);

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
