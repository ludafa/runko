/**
 * Renders one `QuestionTimelineEntry` (docs/08 §2.2c（审批链）) — a pending
 * `ask_user` question via `turn-runner.ts`'s `requestUserAnswer`/
 * `resolveUserAnswer` bridge. Its own standalone timeline card, same
 * "`callId` isn't the underlying `tool_call` item's `id`" reasoning as
 * `approval-card.tsx`; `timeline.ts` additionally suppresses the `ask_user`
 * `tool_call` card outright while it's in progress/completed, so this is the
 * *only* rendering of the question in the common case (docs/08 §2.2c: "避免
 * 与 question 卡片双显").
 */
import { HelpCircleIcon, Loader2Icon, SendIcon } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import type { QuestionEntryStatus, QuestionTimelineEntry } from '../timeline';

const STATUS_META: Record<
  QuestionEntryStatus,
  {
    label: string;
    variant: 'default' | 'secondary' | 'destructive' | 'outline';
  }
> = {
  pending: { label: '待回答', variant: 'secondary' },
  answered: { label: '已回答', variant: 'default' },
  timeout: { label: '已超时', variant: 'outline' },
  expired: { label: '已失效', variant: 'outline' },
};

export function QuestionCard({
  entry,
  submitting,
  onAnswer,
}: {
  entry: QuestionTimelineEntry;
  submitting: boolean;
  onAnswer: (answer: string) => void;
}) {
  const [freeText, setFreeText] = useState('');
  const meta = STATUS_META[entry.status];
  const isPending = entry.status === 'pending';

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
      data-status={entry.status}
      className="border-foreground/10 bg-card/40 space-y-2.5 rounded-xl border px-3 py-2.5"
    >
      <div className="flex items-start gap-2">
        <HelpCircleIcon
          className="text-muted-foreground mt-0.5 size-3.5 shrink-0"
          aria-hidden="true"
        />
        <span className="flex-1 text-sm leading-snug">{entry.question}</span>
        <Badge variant={meta.variant} className="ml-1 shrink-0">
          {meta.label}
        </Badge>
      </div>

      {isPending && (
        <>
          {entry.options !== undefined && entry.options.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {entry.options.map((option) => (
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

      {entry.status === 'answered' && entry.answer !== undefined && (
        <p className="text-muted-foreground text-xs">
          你的回答：{entry.answer}
        </p>
      )}

      {entry.status === 'timeout' && (
        <p className="text-muted-foreground text-xs">
          未在时限内回答，agent 已继续
        </p>
      )}

      {entry.status === 'expired' && (
        <p className="text-muted-foreground text-xs">
          已失效（超时或轮次已结束）
        </p>
      )}
    </div>
  );
}
