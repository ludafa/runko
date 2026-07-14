/**
 * Renders one `ApprovalTimelineEntry` (docs/08 §2.2c（审批链）) — a bash (or
 * any per-tool-gated) call escalated to a human via `turn-runner.ts`'s
 * `requestApproval`/`resolveApproval` bridge. A standalone timeline card, not
 * anchored to the underlying `tool_call` card: `callId` and the `tool_call`
 * item's own `id` live in different id spaces (the loop's internal item id
 * vs. `ApprovalContext.callId`) and don't map onto each other, so this is
 * its own row (docs/08 §2.2c).
 *
 * Styling follows `tool-call-card.tsx`'s established conventions in this
 * feature (a bordered card, a `Badge` status pill, a monospace `<pre>` for
 * the raw payload) rather than introducing a new `CodeBlock`/syntax-
 * highlighting dependency — same "not worth it for a summary" call that file
 * already made for the exact same kind of preview.
 */
import { CheckIcon, Loader2Icon, ShieldAlertIcon, XIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

import type { JsonValue } from '../schema';
import type { ApprovalEntryStatus, ApprovalTimelineEntry } from '../timeline';

const STATUS_META: Record<
  ApprovalEntryStatus,
  {
    label: string;
    variant: 'default' | 'secondary' | 'destructive' | 'outline';
  }
> = {
  pending: { label: '待审批', variant: 'secondary' },
  allowed: { label: '已允许', variant: 'default' },
  denied: { label: '已拒绝', variant: 'destructive' },
  expired: { label: '已失效', variant: 'outline' },
};

/** `bash`'s own input shape (docs/04-builtin-tools.md) — narrowed without a cast: `JsonValue`'s object arm already types `.command` as `JsonValue`, so this only needs the `typeof … === 'string'` check to land on a real `string`. */
function bashCommandOf(input: JsonValue): string | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    return undefined;
  const { command } = input;
  return typeof command === 'string' ? command : undefined;
}

function prettyJson(value: JsonValue): string {
  return JSON.stringify(value, null, 2);
}

export function ApprovalCard({
  entry,
  submitting,
  onDecide,
}: {
  entry: ApprovalTimelineEntry;
  submitting: boolean;
  onDecide: (behavior: 'allow' | 'deny') => void;
}) {
  const meta = STATUS_META[entry.status];
  const command = bashCommandOf(entry.input);
  const spinner = (
    <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
  );

  return (
    <div
      data-testid="approval-card"
      data-status={entry.status}
      className="border-foreground/10 bg-card/40 space-y-2.5 rounded-xl border px-3 py-2.5"
    >
      <div className="flex items-center gap-2">
        <ShieldAlertIcon
          className="text-muted-foreground size-3.5 shrink-0"
          aria-hidden="true"
        />
        <span className="truncate font-mono text-xs font-medium">
          {entry.toolName}
        </span>
        <Badge variant={meta.variant} className="ml-auto shrink-0">
          {meta.label}
        </Badge>
      </div>

      {command !== undefined ?
        <pre className="bg-muted/50 overflow-x-auto rounded-md p-2 font-mono text-xs font-medium">
          {command}
        </pre>
      : <div className="space-y-1">
          <h4 className="text-muted-foreground text-[0.65rem] font-medium tracking-[0.14em] uppercase">
            Parameters
          </h4>
          <pre className="bg-muted/50 overflow-x-auto rounded-md p-2 font-mono text-xs">
            {prettyJson(entry.input)}
          </pre>
        </div>
      }

      {entry.status === 'pending' && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => {
              onDecide('allow');
            }}
            disabled={submitting}
          >
            {submitting ?
              spinner
            : <CheckIcon className="size-3.5" aria-hidden="true" />}
            允许
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => {
              onDecide('deny');
            }}
            disabled={submitting}
          >
            {submitting ?
              spinner
            : <XIcon className="size-3.5" aria-hidden="true" />}
            拒绝
          </Button>
        </div>
      )}

      {entry.status === 'denied' && entry.message !== undefined && (
        <p className="text-muted-foreground text-xs">
          拒绝原因：{entry.message}
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
