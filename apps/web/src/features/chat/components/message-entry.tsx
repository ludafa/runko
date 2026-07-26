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
 *
 * 呈现层用 ai-elements：`Message`/`MessageContent`/`MessageResponse` 负责气泡与
 * markdown，工具/推理/计划/审批各自的组件在 `components/` 下（都已改挂 ai-elements）。
 */
import type { NimboUIMessage } from '@nimbo/core';

import {
  Message,
  MessageContent,
  MessageResponse,
} from '@/components/ai-elements/message';

import { findToolTiming, isNimboToolPart, toolPartName } from '../timeline';
import type { PendingApprovalPart } from './approval-card';
import { ApprovalCard } from './approval-card';
import { ErrorBar } from './error-bar';
import { FileChangeBadges } from './file-change-badges';
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
      <Message from="user">
        {message.metadata?.steered === true && (
          <span className="text-muted-foreground ml-auto text-[0.6875rem]">
            插话
          </span>
        )}
        <MessageContent>{text}</MessageContent>
      </Message>
    );
  }

  return (
    <Message from="assistant">
      <MessageContent>
        {message.parts.map((part, index) => {
          const key = `${message.id}-${String(index)}`;
          switch (part.type) {
            case 'text':
              return (
                // Streamdown renders (possibly still-streaming) markdown — it
                // tolerates unterminated syntax like half-typed **bold** or
                // open code fences, which is why it fits an incremental text
                // part. `MessageResponse` is ai-elements' Streamdown wrapper.
                <MessageResponse key={key}>{part.text}</MessageResponse>
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
      </MessageContent>
    </Message>
  );
}
