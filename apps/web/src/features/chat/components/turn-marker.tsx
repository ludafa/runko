import type { NimboError } from '@nimbo/core';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

import type { TurnFailedErrorInfo } from '../timeline';

export function TurnStartedMarker({ turn }: { turn: number }) {
  return (
    <div className="text-muted-foreground/70 flex items-center justify-center text-[0.7rem] tracking-wide uppercase">
      第 {turn} 轮
    </div>
  );
}

const KNOWN_ERROR_TITLE: Record<NimboError['code'], string> = {
  max_turns: '达到最大轮次',
  context_overflow: '上下文超限',
  provider_error: '模型服务出错',
  aborted: '已中止',
};

/** `code` may be a `NimboError` code (a mid-stream, still-completing turn) or apps/server turn-runner's own open-ended `code: string` (the turn crashed outright) — see `timeline.ts`'s `TurnFailedErrorInfo`. */
function isKnownNimboErrorCode(code: string): code is NimboError['code'] {
  return code in KNOWN_ERROR_TITLE;
}

function errorTitle(code: string): string {
  return isKnownNimboErrorCode(code) ? KNOWN_ERROR_TITLE[code] : '本轮执行出错';
}

export function TurnFailedBar({ error }: { error: TurnFailedErrorInfo }) {
  return (
    <Alert variant="destructive" data-testid="turn-failed-bar">
      <AlertTitle>{errorTitle(error.code)}</AlertTitle>
      <AlertDescription>{error.message}</AlertDescription>
    </Alert>
  );
}
