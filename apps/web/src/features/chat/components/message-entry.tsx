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
import { TurnFailedBar, TurnSuspendedBar } from './turn-marker';
import { TurnStatsButton } from './turn-stats-dialog';

const ASK_USER_TOOL_NAME = 'ask-user';

export interface MessageEntryProps {
  message: NimboUIMessage;
  submittingCallIds: ReadonlySet<string>;
  locallyExpiredCallIds: ReadonlySet<string>;
  /**
   * **这条消息所属的那一轮**是否还活着——决定它里面还没落定的
   * [审批卡片](../../../../../docs/terms.md)与提问卡片该不该显示成「已失效」。
   *
   * 为什么需要它：一张卡片处于「待审批」态，只有**它自己那一轮还在跑**时才可能真的还
   * 在等人。轮一结束（正常收尾、被[停止](../../../../../docs/terms.md)、服务重启中断），
   * 服务端的挂起项就已经被结掉了，再点任何按钮都只会拿到 404。此前界面要等用户**点下去**、
   * 吃了 404 才翻成「已失效」（`locallyExpiredCallIds`），在那之前一直画着三个可点的
   * 按钮——等于骗人。
   *
   * 注意是**这条消息所属的轮**，不是「会话里有没有轮在跑」：后者会让上一轮那张早该失效
   * 的卡片在用户发出下一条消息、新一轮起来时**复活**成可点的「待审批」。合成这个布尔的
   * 逻辑在 `TimelineView`（`settledMessageIds`）。
   *
   * 缺省 `true`（「假设还活着」）：[设计工作台](../../../../../docs/terms.md)与只关心
   * 卡片长相的测试不传它时，卡片照常显示 pending 态。
   */
  turnLive?: boolean;
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
  turnLive = true,
  onSubmitApproval,
  onSubmitAnswer,
  conversationId,
}: MessageEntryProps) {
  /** 这条消息所属的轮已结束 = 它里面还没落定的卡片都已失效（见 `turnLive` 的注释）。 */
  const staleByTurnEnd = !turnLive;
  // defensive — nimbo never pushes a system message onto the ledger (the system prompt is passed to streamText() separately, loop.ts's runOneStep)
  if (message.role === 'system') {
    return null;
  }

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
              // file/source-*/dynamic-tool/custom — never produced by nimbo (see @nimbo/core's state.ts NimboUIMessage doc comment)
              if (!isNimboToolPart(part)) {
                return null;
              }

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
                      // 只有**还在等**的那一档（`input-available`）才叠加轮结束的判定：
                      // `output-available` 是已回答，而卡片里 `expired` 的优先级高于
                      // `answered`，叠上去会把一条已经答完的问题画成「已失效」。
                      expired={
                        locallyExpiredCallIds.has(part.toolCallId) ||
                        (part.state === 'input-available' && staleByTurnEnd)
                      }
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
                    // `approval-requested` 本身就是「还在等人」，所以直接叠加：轮结束了
                    // 就没人会来处理它了（服务端的挂起项早已被结掉）。
                    expired={
                      locallyExpiredCallIds.has(part.toolCallId) ||
                      staleByTurnEnd
                    }
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
          : message.metadata.status === 'suspended' ?
            // [挂起](../../../../../docs/terms.md)不是失败，也没有 error——不单独判一下的话
            // 这一轮的尾部会是一片空白。
            <TurnSuspendedBar />
          : message.metadata.error !== undefined && (
              <TurnFailedBar error={message.metadata.error} />
            ))}
      </MessageContent>
    </Message>
  );
}
