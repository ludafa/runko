/**
 * 渲染一条 `RunkoUIMessage`（docs/logic/orchestration/tech/single-ledger.md §5/§6）。
 *
 * 一条消息与一张卡片**不是** 1:1：一条 `RunkoUIMessage` 可以带同一个 step 里的**多个**
 * 部件（文本、推理、一个或多个工具调用、数据部件）。所以这个组件遍历 `message.parts`
 * 逐个渲染；如果 `message.metadata?.status` 有值（那是收尾那条 assistant 消息，见
 * `@runko/core` 的 `loop.ts` 里 `finalizeTurn`），末尾再补一个
 * `TurnStatsButton`/`TurnFailedBar`。
 *
 * 还有一种「只报轮结束」的占位消息（`materialize.ts` 的 `MessageLedger` 产出，
 * `parts: []`、只有 `metadata`——一轮在任何 step 跑起来之前就失败的少见情况），它自然
 * 就只渲染出那个尾部标记，没有气泡。
 *
 * **工具部件的分发**（docs/logic/orchestration/tech/single-ledger.md §6）：受控调用处于
 * `approval-requested` 时渲染 `ApprovalCard`，而不是通用的 `ToolCallCard`；`ask-user`
 * 工具的 `input-available`/`output-available` 两态渲染 `QuestionCard`（同一个「别重复
 * 显示」的理由）。其余工具部件/状态一律走 `ToolCallCard`，它覆盖剩下的整个状态空间
 * （包括受控调用落定之后的 `approval-responded`/`output-denied`）。
 *
 * 每个渲染 `ToolCallCard` 的地方都会顺带按 `toolCallId` 查出这次调用的
 * `data-tool-timing` 部件（`timeline.ts` 的 `findToolTiming`）一并传进去。
 * `data-tool-timing` 自己在下面的 switch 里没有 `case`，会掉到 `default` 被
 * `isRunkoToolPart` 拒掉，所以从不单独渲染成一张卡片。
 *
 * 呈现层用 ai-elements：`Message`/`MessageContent`/`MessageResponse` 负责气泡与
 * markdown，工具/推理/计划/审批各自的组件在 `components/` 下（都已改挂 ai-elements）。
 */
import type { RunkoUIMessage } from '@runko/core';

import {
  Message,
  MessageContent,
  MessageResponse,
} from '@/components/ai-elements/message';

import { findToolTiming, isRunkoToolPart, toolPartName } from '../timeline';
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
  message: RunkoUIMessage;
  submittingCallIds: ReadonlySet<string>;
  locallyExpiredCallIds: ReadonlySet<string>;
  /**
   * **这条消息所属的那一轮**是否还活着——决定它里面还没落定的
   * [审批卡片](../../../../../../docs/terms.md)与提问卡片该不该显示成「已失效」。
   *
   * 为什么需要它：一张卡片处于「待审批」态，只有**它自己那一轮还在跑**时才可能真的还
   * 在等人。轮一结束（正常收尾、被[停止](../../../../../../docs/terms.md)、服务重启中断），
   * 服务端的挂起项就已经被结掉了，再点任何按钮都只会拿到 404。光靠
   * `locallyExpiredCallIds` 不够——那条路要等用户**点下去**、吃了 404 才翻成「已失效」，
   * 在那之前一直画着三个可点的按钮，等于骗人。
   *
   * 注意是**这条消息所属的轮**，不是「会话里有没有轮在跑」：后者会让上一轮那张早该失效
   * 的卡片在用户发出下一条消息、新一轮起来时**复活**成可点的「待审批」。合成这个布尔的
   * 逻辑在 `TimelineView`（`settledMessageIds`）。
   *
   * 缺省 `true`（「假设还活着」）：[设计工作台](../../../../../../docs/terms.md)与只关心
   * 卡片长相的测试不传它时，卡片照常显示 pending 态。
   */
  turnLive?: boolean;
  onSubmitApproval: (
    callId: string,
    behavior: 'allow' | 'allow-session' | 'deny',
  ) => void;
  onSubmitAnswer: (callId: string, answer: string) => void;
  /** chat 会话 id（遥测明细的查询键之一，docs/ingress/tech/chat-webapp.md §11.4）——不传时 TurnStatsButton 的弹窗只出概览、没有明细。 */
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
  // 防御性判断——runko 从不往账本里塞 system 消息（系统提示词是单独传给 streamText() 的，见 loop.ts 的 runOneStep）
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
                // Streamdown 渲染（可能还在流式产出的）markdown——它能容忍没写完的
                // 语法，比如打了一半的 **粗体** 或没闭合的代码围栏，所以正好适合增量
                // 的文本部件。`MessageResponse` 是 ai-elements 对 Streamdown 的包装。
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
              // file/source-*/dynamic-tool/custom——runko 从不产生这几种（见 @runko/core 的 state.ts 里 RunkoUIMessage 的注释）
              if (!isRunkoToolPart(part)) {
                return null;
              }

              // `data-tool-timing` 从不单独渲染成卡片：上面没有它的 `case`，会掉到
              // 这里被 `isRunkoToolPart` 拒掉。它只按 `toolCallId` 并进对应那次工具
              // 调用自己的卡片里（见 `timeline.ts` 的注释）。
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
            // [挂起](../../../../../../docs/terms.md)不是失败，也没有 error——不单独判一下的话
            // 这一轮的尾部会是一片空白。
            <TurnSuspendedBar />
          : message.metadata.error !== undefined && (
              <TurnFailedBar error={message.metadata.error} />
            ))}
      </MessageContent>
    </Message>
  );
}
