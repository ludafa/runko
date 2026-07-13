import type { SessionItem } from '@nimbo/core';

import type { ItemLifecycle } from '../timeline';
import { ChatMarkdown } from './chat-markdown';
import { ErrorBar } from './error-bar';
import { FileChangeBadges } from './file-change-badges';
import { Message, MessageContent } from './message';
import { PlanChecklist } from './plan-checklist';
import { ReasoningBlock } from './reasoning-block';
import { ToolCallCard } from './tool-call-card';

/** Exhaustiveness guard: a new `SessionItem` variant fails to compile here until a branch is added below. */
function assertNeverItem(value: never): never {
  throw new Error(`unhandled SessionItem type: ${JSON.stringify(value)}`);
}

export function ItemCard({
  item,
  lifecycle,
}: {
  item: SessionItem;
  lifecycle: ItemLifecycle;
}) {
  const streaming = lifecycle !== 'completed';
  switch (item.type) {
    case 'agent_message':
      return (
        <Message from="assistant">
          <MessageContent from="assistant">
            {/* Streamdown renders (possibly still-streaming) markdown — it
                tolerates unterminated syntax like half-typed **bold** or open
                code fences, which is why it fits an incremental agent_message. */}
            <ChatMarkdown>{item.text}</ChatMarkdown>
            {streaming && (
              <span
                aria-hidden="true"
                className="bg-foreground/60 ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse"
              />
            )}
          </MessageContent>
        </Message>
      );
    case 'reasoning':
      return <ReasoningBlock text={item.text} streaming={streaming} />;
    case 'user_message':
      // steer()-injected mid-turn message — same bubble as the turn-initiating
      // 'user-message' timeline entry (timeline-view.tsx), since both are just
      // user text from the host's point of view.
      return (
        <Message from="user">
          <MessageContent from="user">{item.text}</MessageContent>
        </Message>
      );
    case 'tool_call':
      return <ToolCallCard item={item} />;
    case 'file_change':
      return <FileChangeBadges changes={item.changes} />;
    case 'plan_update':
      return <PlanChecklist items={item.items} />;
    case 'error':
      return <ErrorBar message={item.message} />;
    default:
      return assertNeverItem(item);
  }
}
