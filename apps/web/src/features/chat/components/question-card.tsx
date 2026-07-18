/**
 * Renders a pending or answered `ask-user` question (docs/tech/single-ledger.md §6) — driven directly by the `tool-ask-user` part's own
 * `input-available` (pending)/`output-available` (answered) states, no
 * separate `question`/`callId` wire shape any more (`part.toolCallId` *is*
 * the callId). `timeline.ts`'s `buildRenderEntries`/`message-entry.tsx`
 * still suppress the generic `ToolCallCard` for this tool name in favor of
 * this card, same "avoid double-显示" rationale as before this migration.
 *
 * Unlike the retired `QuestionTimelineEntry`, there is no distinct
 * `'timeout'` outcome any more — the `ask-user` tool's `execute()` just
 * returns a plain string either way (the real answer, or the fixed timeout
 * message, `apps/server`'s `chat-agent.ts`), so an `output-available` state
 * always renders as "answered" (this app deliberately does not string-sniff
 * the fixed timeout text to recover the old distinction).
 */
import { HelpCircleIcon, Loader2Icon, SendIcon } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import type { NimboToolPart } from '../timeline';
import { askUserAnswerFromOutput, askUserInputFrom } from '../timeline';

/** The two states this card ever renders (see file header) — `message-entry.tsx` only ever dispatches an `ask-user` part here in one of these two. */
export type QuestionPart = Extract<
  NimboToolPart,
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
  /** `useChatMessages`'s `locallyExpiredCallIds` — not part of the tool part's own state. */
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
  const statusVariant: 'default' | 'secondary' | 'outline' =
    expired ? 'outline'
    : answered ? 'default'
    : 'secondary';

  function submitFreeText(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = freeText.trim();
    if (trimmed.length === 0) return;
    onAnswer(trimmed);
    setFreeText('');
  }

  return (
    <div
      data-testid="question-card"
      data-status={status}
      className="border-foreground/10 bg-card/40 space-y-2.5 rounded-xl border px-3 py-2.5"
    >
      <div className="flex items-start gap-2">
        <HelpCircleIcon
          className="text-muted-foreground mt-0.5 size-3.5 shrink-0"
          aria-hidden="true"
        />
        <span className="flex-1 text-sm leading-snug">{question}</span>
        <Badge variant={statusVariant} className="ml-1 shrink-0">
          {statusLabel}
        </Badge>
      </div>

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
              placeholder="输入你的回答…"
              disabled={submitting}
              aria-label="回答"
            />
            <Button
              type="submit"
              size="icon"
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

      {answered && answer !== undefined && (
        <p className="text-muted-foreground text-xs">你的回答：{answer}</p>
      )}

      {expired && (
        <p className="text-muted-foreground text-xs">
          已失效（超时或轮次已结束）
        </p>
      )}
    </div>
  );
}
