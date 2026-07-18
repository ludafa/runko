/**
 * Renders one `NimboUIMessage` (docs/tech/single-ledger.md §5/§6) —
 * the P13-5-4 replacement for the retired `ItemCard`/`SessionItem` mapping.
 * The mapping is no longer 1:1: a `SessionItem` used to render as exactly
 * one card, but one `NimboUIMessage` can carry *several* parts (text,
 * reasoning, one or more tool calls, data parts) from a single step, so this
 * component iterates `message.parts` and renders each in turn, then — if
 * `message.metadata?.status` is set (the turn-ending assistant message,
 * `@nimbo/core`'s `loop.ts`'s `finalizeTurn`) — a trailing
 * `TurnStatsButton`/`TurnFailedBar`. A "turn signal" placeholder message
 * (`materialize.ts`'s `MessageLedger`, `parts: []`, only `metadata` set —
 * the rare case a turn fails before any step ever ran) naturally renders as
 * *just* that trailing marker, no bubble.
 *
 * Tool part dispatch (docs/tech/single-ledger.md §6): a gated call's `approval-requested` state
 * renders `ApprovalCard` instead of the generic `ToolCallCard`; the
 * `ask-user` tool's `input-available`/`output-available` states render
 * `QuestionCard` instead (same "avoid double display" rationale the retired
 * `timeline.ts` reducer used) — every other tool part/state renders
 * `ToolCallCard`, which itself covers the rest of the state space (including
 * a gated call's `approval-responded`/`output-denied`, once resolved). Every
 * `ToolCallCard` render site also looks up that call's `data-tool-timing`
 * part (`timeline.ts`'s `findToolTiming`, by `toolCallId`) and passes it
 * along — `data-tool-timing` itself has no `case` in the switch below and so
 * never renders as an independent card (falls to `default`, rejected by
 * `isNimboToolPart`).
 */
import type { NimboUIMessage } from '@nimbo/core';

import { findToolTiming, isNimboToolPart, toolPartName } from '../timeline';
import type { PendingApprovalPart } from './approval-card';
import { ApprovalCard } from './approval-card';
import { ChatMarkdown } from './chat-markdown';
import { ErrorBar } from './error-bar';
import { FileChangeBadges } from './file-change-badges';
import { Message, MessageContent } from './message';
import { PlanChecklist } from './plan-checklist';
import type { QuestionPart } from './question-card';
import { QuestionCard } from './question-card';
import { ReasoningBlock } from './reasoning-block';
import { ToolCallCard } from './tool-call-card';
import { TurnFailedBar } from './turn-marker';
import { TurnStatsButton } from './turn-stats-dialog';

const ASK_USER_TOOL_NAME = 'ask-user';

export interface MessageEntryProps {
  message: NimboUIMessage;
  submittingCallIds: ReadonlySet<string>;
  locallyExpiredCallIds: ReadonlySet<string>;
  onSubmitApproval: (
    callId: string,
    behavior: 'allow' | 'allow-session' | 'deny',
  ) => void;
  onSubmitAnswer: (callId: string, answer: string) => void;
  /** chat 会话 id（遥测明细的查询键之一，docs/tech/chat-webapp.md §11.4）——缺席时 TurnStatsButton 的弹窗只出概览、没有明细。 */
  conversationId?: string;
}

export function MessageEntry({
  message,
  submittingCallIds,
  locallyExpiredCallIds,
  onSubmitApproval,
  onSubmitAnswer,
  conversationId,
}: MessageEntryProps) {
  if (message.role === 'system') return null; // defensive — nimbo never pushes a system message onto the ledger (the system prompt is passed to streamText() separately, loop.ts's runOneStep)

  if (message.role === 'user') {
    const text = message.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('');
    return (
      <div className="flex w-full flex-col items-end gap-1">
        {message.metadata?.steered === true && (
          <span className="text-muted-foreground/70 mr-1 text-[0.65rem] tracking-wide uppercase">
            插话
          </span>
        )}
        <Message from="user">
          <MessageContent from="user">{text}</MessageContent>
        </Message>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-3">
      {message.parts.map((part, index) => {
        const key = `${message.id}-${String(index)}`;
        switch (part.type) {
          case 'text':
            return (
              <Message key={key} from="assistant">
                <MessageContent from="assistant">
                  {/* Streamdown renders (possibly still-streaming) markdown —
                      it tolerates unterminated syntax like half-typed
                      **bold** or open code fences, which is why it fits an
                      incremental text part. */}
                  <ChatMarkdown>{part.text}</ChatMarkdown>
                  {part.state === 'streaming' && (
                    <span
                      aria-hidden="true"
                      className="bg-foreground/60 ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse"
                    />
                  )}
                </MessageContent>
              </Message>
            );
          case 'reasoning':
            return (
              <ReasoningBlock
                key={key}
                text={part.text}
                streaming={part.state === 'streaming'}
              />
            );
          case 'data-file-change':
            return <FileChangeBadges key={key} changes={part.data.changes} />;
          case 'data-plan-update':
            return <PlanChecklist key={key} items={part.data.items} />;
          case 'data-error':
            return <ErrorBar key={key} message={part.data.message} />;
          case 'step-start':
            return null;
          default: {
            if (!isNimboToolPart(part)) return null; // file/source-*/dynamic-tool/custom — never produced by nimbo (see @nimbo/core's state.ts NimboUIMessage doc comment)

            // `data-tool-timing` never renders as its own card (no `case` for
            // it above — falls through here, rejected by `isNimboToolPart`)
            // — only joined by `toolCallId` into the matching tool call's own
            // card, `timeline.ts`'s own doc comment.
            const timing = findToolTiming(message, part.toolCallId);

            if (toolPartName(part) === ASK_USER_TOOL_NAME) {
              if (
                part.state === 'input-available' ||
                part.state === 'output-available'
              ) {
                const questionPart: QuestionPart = part;
                return (
                  <QuestionCard
                    key={key}
                    part={questionPart}
                    submitting={submittingCallIds.has(part.toolCallId)}
                    expired={locallyExpiredCallIds.has(part.toolCallId)}
                    onAnswer={(answer) => {
                      onSubmitAnswer(part.toolCallId, answer);
                    }}
                  />
                );
              }
              return <ToolCallCard key={key} part={part} timing={timing} />;
            }

            if (part.state === 'approval-requested') {
              const approvalPart: PendingApprovalPart = part;
              return (
                <ApprovalCard
                  key={key}
                  part={approvalPart}
                  submitting={submittingCallIds.has(part.toolCallId)}
                  expired={locallyExpiredCallIds.has(part.toolCallId)}
                  onDecide={(behavior) => {
                    onSubmitApproval(part.toolCallId, behavior);
                  }}
                />
              );
            }

            return <ToolCallCard key={key} part={part} timing={timing} />;
          }
        }
      })}
      {message.metadata?.status !== undefined &&
        (message.metadata.status === 'completed' ?
          <TurnStatsButton
            usage={message.metadata.usage ?? {}}
            durationMs={message.metadata.durationMs}
            toolDurationMs={message.metadata.toolDurationMs}
            conversationId={conversationId}
            turn={message.metadata.turn}
          />
        : message.metadata.error !== undefined && (
            <TurnFailedBar error={message.metadata.error} />
          ))}
    </div>
  );
}
