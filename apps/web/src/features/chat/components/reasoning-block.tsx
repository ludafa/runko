/**
 * Adapted from AI Elements' `reasoning.tsx`: auto-opens while the reasoning
 * item is still streaming (`item.updated`, not yet `item.completed`),
 * auto-collapses shortly after it finishes, and shows how long it took —
 * dropped `@radix-ui/react-use-controllable-state` (we don't need an
 * externally-controlled `open` prop, plain `useState` covers "auto + still
 * manually toggleable"). The reasoning text often *is* markdown (the model
 * thinks in fenced code / lists), so it's rendered with `streamdown` too —
 * same tolerance for still-streaming, unterminated syntax as agent_message.
 *
 * The open/close transitions are split across three mechanisms deliberately
 * (`eslint-plugin-react-hooks`'s `set-state-in-effect`/`purity` rules,
 * https://react.dev/learn/you-might-not-need-an-effect):
 *  - reacting to `streaming` flipping true is a render-phase state
 *    adjustment (comparing against a `prevStreaming` state value), not an
 *    effect — this is React's own documented pattern for "derive state from
 *    a prop transition" and never calls `Date.now()` during render;
 *  - capturing the actual start timestamp is a plain ref write inside an
 *    effect (not a `setState` call, so the "no synchronous setState in an
 *    effect body" rule doesn't apply, and effects — unlike render — are an
 *    allowed place for impure calls like `Date.now()`);
 *  - the delayed auto-close's `setState` calls live inside the `setTimeout`
 *    callback, not directly in the effect body, which is exactly the
 *    "subscribe and call setState from a callback" shape the rule expects.
 */
import { BrainIcon, ChevronDownIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';

import { ChatMarkdown } from './chat-markdown';

const AUTO_CLOSE_DELAY_MS = 1000;

export function ReasoningBlock({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  const [isOpen, setIsOpen] = useState(streaming);
  const [prevStreaming, setPrevStreaming] = useState(streaming);
  const [durationSec, setDurationSec] = useState<number | undefined>(undefined);
  const startedAtRef = useRef<number | undefined>(undefined);
  const hasClosedOnceRef = useRef(false);

  if (streaming !== prevStreaming) {
    setPrevStreaming(streaming);
    if (streaming) setIsOpen(true);
  }

  useEffect(() => {
    if (streaming) startedAtRef.current = Date.now();
  }, [streaming]);

  useEffect(() => {
    if (streaming || hasClosedOnceRef.current) return;
    const startedAt = startedAtRef.current;
    if (startedAt === undefined) return;
    const timer = setTimeout(() => {
      setDurationSec(Math.max(1, Math.round((Date.now() - startedAt) / 1000)));
      setIsOpen(false);
      hasClosedOnceRef.current = true;
    }, AUTO_CLOSE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [streaming]);

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={setIsOpen}
      className="border-foreground/8 bg-card/30 rounded-xl border"
    >
      <CollapsibleTrigger className="group/reasoning text-muted-foreground hover:text-foreground flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-medium">
        <BrainIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span>
          {streaming ?
            '思考中…'
          : durationSec !== undefined ?
            `思考了 ${String(durationSec)} 秒`
          : '思考过程'}
        </span>
        <ChevronDownIcon
          className="ml-auto size-3.5 shrink-0 transition-transform group-data-[panel-open]/reasoning:rotate-180"
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="text-muted-foreground px-3 pb-3 text-sm leading-relaxed">
        <ChatMarkdown>{text}</ChatMarkdown>
      </CollapsibleContent>
    </Collapsible>
  );
}
