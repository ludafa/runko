/**
 * 渲染一次 `ask-user` 提问的「待回答」或「已回答」态（docs/logic/orchestration/tech/single-ledger.md §6）。
 *
 * 它直接由 `tool-ask-user` 部件自己的两个状态驱动：`input-available` = 待回答，
 * `output-available` = 已回答。没有另一套 `question`/`callId` 的 wire 形状——
 * `part.toolCallId` **就是** callId。`message-entry.tsx` 对这个工具名压掉通用的
 * `ToolCallCard`，改用这张卡片，理由是「别重复显示」。
 *
 * **没有单独的「超时」结果。** `ask-user` 的 `execute()` 两种情况都只返回一个普通字符串
 * （真实回答，或那句固定的超时文案，见 `apps/node-server` 的 `chat-agent.ts`），所以
 * `output-available` 一律渲染成「已回答」。这里刻意**不去**嗅探那句固定文案来区分两者。
 *
 * ai-elements 没有「向用户提问」这一档组件（`Confirmation` 是二值审批，不带
 * 自由文本回答），所以这里自己拼，但用的是同一批基元（`Alert` + `Button` +
 * `Input`）与同一套间距，视觉上与审批卡片同族。
 */
import { HelpCircleIcon, Loader2Icon, SendIcon } from 'lucide-react';
import { useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import type { RunkoToolPart } from '../timeline';
import { askUserAnswerFromOutput, askUserInputFrom } from '../timeline';

/** 这张卡片只渲染这两个状态（见文件头）——`message-entry.tsx` 只会在这两态下把 `ask-user` 部件分发到这里。 */
export type QuestionPart = Extract<
  RunkoToolPart,
  { state: 'input-available' | 'output-available' }
>;

export function QuestionCard({
  part,
  submitting,
  expired,
  onAnswer,
}: {
  part: QuestionPart;
  submitting: boolean;
  /** 来自 `useChatMessages` 的 `locallyExpiredCallIds`——工具部件自己的状态里没有这一档。 */
  expired: boolean;
  onAnswer: (answer: string) => void;
}) {
  const [freeText, setFreeText] = useState('');
  const input = askUserInputFrom(part.input);
  const question = input?.question ?? '（问题内容缺失）';
  const options = input?.options;
  const answered = part.state === 'output-available';
  const answer = answered ? askUserAnswerFromOutput(part.output) : undefined;
  const isPending = !answered && !expired;

  const status =
    expired ? 'expired'
    : answered ? 'answered'
    : 'pending';
  const statusLabel =
    expired ? '已失效'
    : answered ? '已回答'
    : '待回答';

  function submitFreeText(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = freeText.trim();
    if (trimmed.length === 0) {
      return;
    }
    onAnswer(trimmed);
    setFreeText('');
  }

  return (
    <Alert
      className="mb-2 flex flex-col gap-2"
      data-testid="question-card"
      data-status={status}
    >
      <HelpCircleIcon />
      <AlertTitle className="flex items-start gap-2 leading-snug">
        <span className="flex-1">{question}</span>
        <Badge variant="secondary" className="shrink-0">
          {statusLabel}
        </Badge>
      </AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        {isPending && (
          <>
            {options !== undefined && options.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {options.map((option) => (
                  <Button
                    key={option}
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={submitting}
                    onClick={() => {
                      onAnswer(option);
                    }}
                  >
                    {option}
                  </Button>
                ))}
              </div>
            )}
            <form onSubmit={submitFreeText} className="flex items-center gap-2">
              <Input
                value={freeText}
                onChange={(e) => {
                  setFreeText(e.target.value);
                }}
                placeholder="或者自己写一个回答…"
                disabled={submitting}
                aria-label="回答"
                className="h-8 max-w-md"
              />
              <Button
                type="submit"
                size="icon-sm"
                disabled={submitting || freeText.trim().length === 0}
                aria-label="发送"
              >
                {submitting ?
                  <Loader2Icon
                    className="size-4 animate-spin"
                    aria-hidden="true"
                  />
                : <SendIcon className="size-4" aria-hidden="true" />}
              </Button>
            </form>
          </>
        )}

        {/* 整句放在同一个文本节点里（不拆 span 上色）：`getNodeText` 只看直接
            文本子节点，拆开之后测试与屏幕阅读器读到的都是碎片。 */}
        {answered && answer !== undefined && (
          <p className="text-xs">你的回答：{answer}</p>
        )}
        {expired && (
          <p className="text-xs">{statusLabel}（超时或轮次已结束）</p>
        )}
      </AlertDescription>
    </Alert>
  );
}
