/**
 * docs/tech/single-ledger.md §5/§6 migration: `TurnStartedMarker`
 * (a "第 N 轮" divider) is dropped — there is no wire signal for a turn
 * *starting* any more (`session.started`/`turn.started` "不需要部件/chunk",
 * `@nimbo/core`'s `loop.ts` doc comment), only for one *ending*
 * (`message-metadata`'s `turn`/`status`), so a start divider could only ever
 * be rendered retroactively, which isn't useful enough to keep. `TurnFailedBar`
 * now takes the real `@nimbo/core` `NimboError` directly — the retired
 * `TurnFailedErrorInfo` widening existed only to also cover apps/node-server
 * turn-runner's old open-ended-`code: string` flat sentinel, which no longer
 * exists (its replacement, `driveTurn`'s generator-threw catch branch,
 * reuses the exact same `NimboError` shape as a graceful degrade — `code:
 * 'provider_error'`).
 *
 * `code: 'aborted'` 是这四种 code 里唯一**不是故障**的一种（docs/tech/turn-abort.md
 * §4.3）：用户自己按了[停止](../../../../../docs/terms.md)。它因此走中性呈现、也不显示
 * core 那句英文 `message`（那是给日志看的），其余三种照旧 destructive。
 */
import type { NimboError } from '@nimbo/core';
import { CircleStopIcon } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

const KNOWN_ERROR_TITLE: Record<NimboError['code'], string> = {
  max_turns: '达到最大轮次',
  context_overflow: '上下文超限',
  provider_error: '模型服务出错',
  aborted: '已停止',
};

export function TurnFailedBar({ error }: { error: NimboError }) {
  if (error.code === 'aborted') {
    return (
      <Alert className="mb-2" data-testid="turn-stopped-bar">
        <CircleStopIcon />
        <AlertTitle>{KNOWN_ERROR_TITLE.aborted}</AlertTitle>
        <AlertDescription>
          这一轮由你停止；已经做过的事都保留着，接着发消息即可继续。
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert variant="destructive" className="mb-2" data-testid="turn-failed-bar">
      <AlertTitle>{KNOWN_ERROR_TITLE[error.code]}</AlertTitle>
      <AlertDescription>{error.message}</AlertDescription>
    </Alert>
  );
}
