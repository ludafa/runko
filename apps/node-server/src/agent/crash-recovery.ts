/**
 * 启动时的[崩溃恢复](../../../../docs/terms.md)（docs/tech/graceful-shutdown.md §5）
 * ——[优雅关闭](../../../../docs/terms.md)的**第二道防线**。
 *
 * 第一道（`turn-runner/shutdown.ts` 的 `shutdownTurns`）覆盖「进程有机会执行代码」的关闭：
 * SIGTERM/SIGINT，也就是 `node --watch` 热重载、部署、pod 迁移、Ctrl-C。但 `kill -9`、
 * OOM、断电、容器被硬杀不给任何机会——那些情况下进行中的轮**从未收尾**，界面上是一个
 * 永远转圈的「思考中…」，历史停在半句话上。
 *
 * 本模块在启动时扫一遍，把这些[孤儿轮](../../../../docs/terms.md)补上收尾标记。
 *
 * **怎么认出孤儿轮**：一个会话的事件行**以 `kind = 'chunk'` 收尾，且那条 chunk 不是收尾
 * `message-metadata`**。依据是既有的落盘时序（docs/tech/single-ledger.md §5）——一轮优雅
 * 收尾时 `finalizeTurnPersistence` 会把本轮消息落成 `kind = 'message'` 行并 GC 掉本轮的
 * chunk 行，所以正常结束的会话必然以 message 行收尾。
 *
 * 三条边界（详见 docs/tech/graceful-shutdown.md §5）：
 *
 * 1. **不删那些 chunk 行**。它们是那一轮**唯一**的内容记录——已经没有 session 能把它们
 *    物化成 `kind = 'message'` 行了，删掉界面就什么都看不到。所以只补收尾、不 GC。
 * 2. **补的收尾行本身也是 chunk 行**，于是这个会话仍然以 chunk 收尾。这不影响下次判断：
 *    判据里带了「那条 chunk 不是收尾 metadata」，所以不会反复追加（幂等）。
 * 3. **被强杀那一轮的半成品不进[模型上下文](../../../../docs/terms.md)**：`loadResumeState`
 *    只读 `kind = 'message'` 行（既有行为）。界面看得到、agent 记不住。
 *
 * 只在进程启动时、`serve()` 之前跑一次（`index.ts`），那时进程内不可能有任何轮在跑，
 * 所以不存在与活跃轮的竞态。**单实例假设**下成立——多实例部署的边界见
 * docs/tech/graceful-shutdown.md 附录 B。
 */
import type { NimboChunk } from '@nimbo/core';
import { z } from 'zod';

import type { Logger } from '../logger.js';
import { logger as defaultLogger } from '../logger.js';
import type { Db } from './store.js';
import {
  appendConversationEvent,
  getLastConversationEvent,
  listAllConversationIds,
} from './store.js';
import { ABORT_REASON_SHUTDOWN } from './turn-runner/index.js';

const LOG_SCOPE = 'crash-recovery';

/**
 * 「这条 chunk 是一轮的收尾」——`message-metadata` 且带终态 `status`。
 *
 * 三种收尾都算，不只 `interrupted`：`completed`（正常结束）与 `failed`（`driveTurn` 的
 * catch 分支合成的那条）同样意味着**这一轮已经有交代了**，不该被当成孤儿轮再补一条。
 *
 * 用 zod 而不是手写类型断言：`payload_json` 是反序列化边界，形状要在运行时验，
 * `JSON.parse` 的 `any` 也不会落进具名变量。
 */
const turnEndMetadataSchema = z.object({
  type: z.literal('message-metadata'),
  messageMetadata: z.object({
    status: z.enum(['completed', 'failed', 'interrupted']),
  }),
});

function isTurnEndChunk(payloadJson: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return false; // 坏行：当作「不是收尾」，下面会给它补一条——比让它永远卡着强
  }
  return turnEndMetadataSchema.safeParse(parsed).success;
}

/** 给孤儿轮补的那条收尾 chunk——形状与 `turn-runner/` 的两处同源，不新增任何 wire 形状。 */
function buildInterruptedChunk(): NimboChunk {
  return {
    type: 'message-metadata',
    messageMetadata: {
      // `turn` 省略：这一轮的 session 早已随进程消失，问不出轮号（与
      // `releaseTurn` 补的那条同款处理）。
      usage: {},
      status: 'interrupted',
      error: { code: 'aborted', message: ABORT_REASON_SHUTDOWN },
    },
  };
}

export interface CrashRecoveryResult {
  /** 扫了几个会话。 */
  scanned: number;
  /** 补了几条收尾（= 发现了几个[孤儿轮](../../../../docs/terms.md)）。 */
  recovered: number;
}

/**
 * 扫描全部会话，给每个[孤儿轮](../../../../docs/terms.md)补一条 `interrupted` 收尾。
 * 幂等：补过的会话再跑一次不会重复追加（见文件头边界 2）。
 */
export function recoverOrphanedTurns(
  db: Db,
  logger?: Logger,
): CrashRecoveryResult {
  const log = logger ?? defaultLogger;
  const conversationIds = listAllConversationIds(db);
  let recovered = 0;

  for (const conversationId of conversationIds) {
    const last = getLastConversationEvent(db, conversationId);
    // 空会话（从没发过消息）或以 message 行收尾（上一轮优雅收尾过）——都不是孤儿轮。
    if (last === undefined || last.kind !== 'chunk') continue;
    if (isTurnEndChunk(last.payloadJson)) continue; // 已经有收尾了（含上次补的那条）

    appendConversationEvent(db, {
      conversationId,
      seq: last.seq + 1,
      kind: 'chunk',
      payloadJson: JSON.stringify(buildInterruptedChunk()),
    });
    recovered += 1;
    log.info(LOG_SCOPE, 'recovered orphaned turn', {
      conversationId,
      afterSeq: last.seq,
    });
  }

  if (recovered > 0) {
    log.warn(LOG_SCOPE, 'startup sweep finished', {
      scanned: conversationIds.length,
      recovered,
    });
  } else {
    // 绝大多数启动都走这条：一行 debug，不给正常启动添噪音。
    log.debug(LOG_SCOPE, 'startup sweep finished, nothing to recover', {
      scanned: conversationIds.length,
    });
  }

  return { scanned: conversationIds.length, recovered };
}
