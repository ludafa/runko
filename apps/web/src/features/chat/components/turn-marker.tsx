/**
 * 一轮的收尾标记（单一账本技术方案 docs/logic/orchestration/tech/single-ledger.md §6.1）。wire 上只有
 * 一轮**结束**的信号（`message-metadata` 的 `turn`/`status`），没有一轮**开始**的信号，
 * 所以这里只画收尾、不画「第 N 轮」的分隔线。
 *
 * `code: 'aborted'` 是这几种 code 里唯一**不是故障**的一种（docs/logic/orchestration/tech/turn-abort.md
 * §4.3）：用户自己按了[停止](../../../../../../docs/terms.md)。它因此走中性呈现、也不显示
 * core 那句英文 `message`（那是给日志看的），其余几种照旧 destructive。
 */
import type { RunkoError } from '@runko/core';
import { CircleStopIcon } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

const KNOWN_ERROR_TITLE: Record<RunkoError['code'], string> = {
  max_turns: '达到最大轮次',
  context_overflow: '上下文超限',
  provider_error: '模型服务出错',
  aborted: '已停止',
  internal_error: '系统异常',
};

/**
 * `@runko/agent` 的 `ABORT_REASON_SHUTDOWN`（`packages/agent/src/runtime/reasons.ts`）的
 * **手写镜像**（本仓库既有的镜像纪律，同 `schema.ts`）——服务端
 * [优雅关闭](../../../../../../docs/terms.md)时中止一轮用的就是这句话，它经 core 透传成
 * `RunkoError.message`（docs/logic/orchestration/tech/graceful-shutdown.md §4）。
 *
 * 为什么靠文案而不是靠一个专门的 `code`：「服务要关闭了」是宿主的运维概念，不该塞进
 * `@runko/core` 的类型联合（理由见 docs/logic/orchestration/tech/graceful-shutdown.md §2）。**改这个常量要
 * 同时改 `@runko/agent` 那份**，否则服务重启会被显示成「用户按了停止」——两边对不齐时，
 * 一条直接从 `@runko/agent` 导入 `ABORT_REASON_SHUTDOWN` 比对的防漂移测试会先红。
 */
const SHUTDOWN_ABORT_MESSAGE =
  'Server is shutting down; this turn was interrupted.';

/**
 * [挂起](../../../../../../docs/terms.md)：等人等太久，这一轮落盘退出了，人回来还能接着跑。
 *
 * **不是失败**——跟 `aborted` 一样走中性呈现。它没有 `RunkoError`（没有出错），所以
 * 单独一个组件，不挂在 `TurnFailedBar` 上。
 *
 * `waiting` 为假 = 挂起的调用都答完了、恢复那一轮已经接着跑了。这时只留一行灰字，否则历史里
 * 会一直挂着一句「在等你」（docs/ingress/tech/chat-webapp.md §6.2 ②）。
 */
export function TurnSuspendedBar({ waiting }: { waiting: boolean }) {
  if (!waiting) {
    return (
      <p
        className="text-muted-foreground mb-2 text-xs"
        data-testid="turn-resumed-note"
      >
        在这里挂起过，答复之后已接着跑。
      </p>
    );
  }
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
      <AlertDescription>
        {/* 系统异常的细节只进服务端日志，这里只说用户能做什么。 */}
        {error.code === 'internal_error' ?
          '服务端出了问题，这一轮没能完成，请重新发送。'
        : error.message}
      </AlertDescription>
    </Alert>
  );
}
