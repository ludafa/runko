/**
 * 一轮的收尾标记（docs/logic/orchestration/tech/single-ledger.md §5/§6）。wire 上只有
 * 一轮**结束**的信号（`message-metadata` 的 `turn`/`status`），没有一轮**开始**的信号，
 * 所以这里只画收尾、不画「第 N 轮」的分隔线。
 *
 * `code: 'aborted'` 是这四种 code 里唯一**不是故障**的一种（docs/logic/orchestration/tech/turn-abort.md
 * §4.3）：用户自己按了[停止](../../../../../../docs/terms.md)。它因此走中性呈现、也不显示
 * core 那句英文 `message`（那是给日志看的），其余三种照旧 destructive。
 */
import type { RunkoError } from '@runko/core';
import { CircleStopIcon } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

const KNOWN_ERROR_TITLE: Record<RunkoError['code'], string> = {
  max_turns: '达到最大轮次',
  context_overflow: '上下文超限',
  provider_error: '模型服务出错',
  aborted: '已停止',
};

/**
 * `apps/node-server` 的 `ABORT_REASON_SHUTDOWN` 的**手写镜像**（本仓库既有的镜像纪律，
 * 同 `schema.ts`）——服务端[优雅关闭](../../../../../../docs/terms.md)时中止一轮用的就是这句
 * 话，它经 core 透传成 `RunkoError.message`（docs/logic/orchestration/tech/graceful-shutdown.md §4）。
 *
 * 为什么靠文案而不是靠一个专门的 `code`：「服务要关闭了」是宿主的运维概念，不该塞进
 * `@runko/core` 的类型联合（理由见 docs/logic/orchestration/tech/graceful-shutdown.md §2）。**改这个常量要
 * 同时改服务端那份**，否则服务重启会被显示成「用户按了停止」。
 */
const SHUTDOWN_ABORT_MESSAGE =
  'The server shut down while this turn was running.';

/**
 * [挂起](../../../../../../docs/terms.md)：等人等太久，这一轮落盘退出了，人回来还能接着跑。
 *
 * **不是失败**——跟 `aborted` 一样走中性呈现。它没有 `RunkoError`（没有出错），所以
 * 单独一个组件，不挂在 `TurnFailedBar` 上。
 */
export function TurnSuspendedBar() {
  return (
    <Alert className="mb-2" data-testid="turn-suspended-bar">
      <CircleStopIcon />
      <AlertTitle>等待你的答复，这一轮已挂起</AlertTitle>
      <AlertDescription>
        已经做过的事都保留着；答复之后会从挂起的地方接着跑。
      </AlertDescription>
    </Alert>
  );
}

export function TurnFailedBar({ error }: { error: RunkoError }) {
  if (error.code === 'aborted') {
    // 两档都不是故障、都走中性呈现，差别只在「是谁停的」——用户没按任何按钮却看到
    // 「已停止」会困惑，所以服务重启那一档要如实说是服务重启。
    const byShutdown = error.message === SHUTDOWN_ABORT_MESSAGE;
    return (
      <Alert className="mb-2" data-testid="turn-stopped-bar">
        <CircleStopIcon />
        <AlertTitle>
          {byShutdown ? '服务重启，这一轮已中断' : KNOWN_ERROR_TITLE.aborted}
        </AlertTitle>
        <AlertDescription>
          {byShutdown ?
            '服务端重启了，这一轮没能跑完；已经做过的事都保留着，接着发消息即可继续。'
          : '这一轮由你停止；已经做过的事都保留着，接着发消息即可继续。'}
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
