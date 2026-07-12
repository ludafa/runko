/**
 * Adapted from AI Elements' `tool.tsx` (collapsible card: header row with an
 * icon + tool name + status badge + chevron, content split into
 * "Parameters"/"Result"/"Error" panels) — dropped its `ai`-package
 * `ToolUIPart`/`DynamicToolUIPart` typing (nimbo's own `tool_call` item has
 * a different, simpler status vocabulary: `in_progress`/`completed`/
 * `failed`/`denied`, no separate approval states) and its `CodeBlock`
 * (shiki syntax highlighting — not worth the dependency for what the work
 * order asks for, a summary; a plain `<pre>` covers the "view full JSON on
 * demand" need just as well).
 */
import {
  CheckCircleIcon,
  ChevronDownIcon,
  CircleSlashIcon,
  Loader2Icon,
  WrenchIcon,
  XCircleIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';

import type { JsonValue } from '../schema';

export interface ToolCallItemLike {
  toolName: string;
  input: JsonValue;
  output?: JsonValue;
  status: 'in_progress' | 'completed' | 'failed' | 'denied';
}

const STATUS_META: Record<
  ToolCallItemLike['status'],
  { label: string; icon: ReactNode }
> = {
  in_progress: {
    label: '运行中',
    icon: <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />,
  },
  completed: {
    label: '已完成',
    icon: (
      <CheckCircleIcon
        className="size-3.5 text-emerald-600 dark:text-emerald-400"
        aria-hidden="true"
      />
    ),
  },
  failed: {
    label: '失败',
    icon: (
      <XCircleIcon
        className="size-3.5 text-red-600 dark:text-red-400"
        aria-hidden="true"
      />
    ),
  },
  denied: {
    label: '已拒绝',
    icon: (
      <CircleSlashIcon
        className="size-3.5 text-amber-600 dark:text-amber-400"
        aria-hidden="true"
      />
    ),
  },
};

function summarizeInput(input: JsonValue): string {
  const json = JSON.stringify(input);
  return json.length > 120 ? `${json.slice(0, 120)}…` : json;
}

function prettyJson(value: JsonValue): string {
  return JSON.stringify(value, null, 2);
}

export function ToolCallCard({ item }: { item: ToolCallItemLike }) {
  const meta = STATUS_META[item.status];
  const hasOutput = item.output !== undefined;

  return (
    <Collapsible
      className="border-foreground/10 bg-card/40 rounded-xl border"
      defaultOpen={false}
    >
      <CollapsibleTrigger className="group/tool flex w-full items-center gap-2 px-3 py-2 text-left">
        <WrenchIcon
          className="text-muted-foreground size-3.5 shrink-0"
          aria-hidden="true"
        />
        <span className="truncate font-mono text-xs font-medium">
          {item.toolName}
        </span>
        <Badge variant="secondary" className="ml-1 gap-1">
          {meta.icon}
          {meta.label}
        </Badge>
        <span className="text-muted-foreground ml-1 min-w-0 flex-1 truncate font-mono text-xs">
          {summarizeInput(item.input)}
        </span>
        <ChevronDownIcon
          className="text-muted-foreground size-3.5 shrink-0 transition-transform group-data-[panel-open]/tool:rotate-180"
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 px-3 pb-3">
        <div className="space-y-1">
          <h4 className="text-muted-foreground text-[0.65rem] font-medium tracking-[0.14em] uppercase">
            Parameters
          </h4>
          <pre className="bg-muted/50 overflow-x-auto rounded-md p-2 font-mono text-xs">
            {prettyJson(item.input)}
          </pre>
        </div>
        {hasOutput && (
          <div className="space-y-1">
            <h4 className="text-muted-foreground text-[0.65rem] font-medium tracking-[0.14em] uppercase">
              {item.status === 'failed' ? 'Error' : 'Result'}
            </h4>
            <pre
              className={
                item.status === 'failed' ?
                  'bg-destructive/10 text-destructive overflow-x-auto rounded-md p-2 font-mono text-xs'
                : 'bg-muted/50 overflow-x-auto rounded-md p-2 font-mono text-xs'
              }
            >
              {typeof item.output === 'string' ?
                item.output
              : prettyJson(item.output ?? null)}
            </pre>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
