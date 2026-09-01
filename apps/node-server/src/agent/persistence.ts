/**
 * chat 应用这一档的**宿主能力实现**：`@nimbo/agent` 的三个领域接口
 * （[账本](../../../../docs/terms.md) · [裁决表](../../../../docs/terms.md) ·
 * [待发队列](../../../../docs/terms.md)）+ [归属仲裁机制](../../../../docs/terms.md)，
 * 全部架在既有的 drizzle schema 上。
 *
 * **为什么不装 `@nimbo/persist-sql`**：这个应用本来就有自己的 ORM 和领域模型，再引一个
 * 持久化包等于在同一个进程里出现第二套数据访问方式。框架的设计正是「逻辑层定义模型、
 * 宿主负责存」——宿主自己实现这四个接口是**头等路径**，不是降级方案。顺带这也是对
 * 接口最真实的检验：它必须能架在别人已有的表上，而不是逼别人跑 nimbo 的迁移。
 *
 * 三处与框架契约对齐的要点：
 *
 * 1. **账本只写 `kind='message'` 行**（[进行中草稿](../../../../docs/terms.md)放内存）。
 *    读的时候顺带把历史遗留的 `kind='chunk'` 行滤掉——它们是本次迁移之前崩溃残留的
 *    垃圾，不删是因为删一张几十万行的表不该发生在启动路径上，滤掉零成本。
 * 2. **`maxSeq` 统计的是全部行**（含那些遗留 chunk 行），不只 message 行——否则新分配的
 *    seq 会跟遗留行的主键撞上。
 * 3. **写入结果用 `WriteResult` 而不是抛错**：单进程下 `rejected` 这一支永远走不到，
 *    但接口上必须有它，否则将来换成租约版就是静默数据损坏。
 */
import type {
  Arbitration,
  DecisionRecord,
  DecisionStore,
  EnqueueOutcome,
  Grant,
  LedgerEntry,
  LedgerStore,
  Persistence,
  QueuedInput,
  QueueStore,
  StaleOwnership,
  TurnInput,
  WriteResult,
} from '@nimbo/agent';
import type { JsonValue, NimboUIMessage } from '@nimbo/core';
import { jsonValueSchema } from '@nimbo/core';
import { and, asc, eq, isNotNull, max } from 'drizzle-orm';
import { z } from 'zod';

import {
  conversationDecisions,
  conversationEvents,
  conversations,
} from '../db/schema.js';
import type { Logger } from '../logger.js';
import { logger as defaultLogger } from '../logger.js';
import type { Db } from './store.js';

const LOG_SCOPE = 'persistence';

const OK: WriteResult = { ok: true };

// ---------------------------------------------------------------------------
// 账本
// ---------------------------------------------------------------------------

/**
 * `payload_json` 的反序列化边界。只做**信封级**校验（id/role/parts 三件套）——深层的
 * 部件校验由 core 自己在 `createSession({resume})` 里跑（`validateUIMessages`），这里
 * 重跑一遍纯属浪费，而且两处校验口径迟早会漂。
 */
const uiMessageEnvelopeSchema = z.object({
  id: z.string(),
  role: z.enum(['system', 'user', 'assistant']),
  parts: z.array(z.unknown()),
});

/** JSON 列 → `NimboUIMessage`；坏行返回 `undefined`（记一行 warn，跳过，不让整段回放 500）。 */
function parseMessage(
  payloadJson: string,
  log: Logger,
): NimboUIMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch (error) {
    log.warn(LOG_SCOPE, 'ledger row is not valid JSON', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  const envelope = uiMessageEnvelopeSchema.safeParse(parsed);
  if (!envelope.success) {
    log.warn(LOG_SCOPE, 'ledger row failed envelope validation', {
      error: envelope.error.message,
    });
    return undefined;
  }
  // 信封校验通过即视为 `NimboUIMessage`——深层校验归 core（见 schema 注释）。这是
  // 本文件唯一一处「运行时校验后收窄」的信任声明，隔离在这个函数里。
  return parsed as NimboUIMessage;
}

function createLedgerStore(db: Db, log: Logger): LedgerStore {
  return {
    append(entry: LedgerEntry): Promise<WriteResult> {
      db.insert(conversationEvents)
        .values({
          conversationId: entry.conversationId,
          seq: entry.seq,
          ts: new Date(entry.ts),
          kind: 'message',
          payloadJson: JSON.stringify(entry.message),
        })
        // 同 `(conversationId, seq)` 重复写入是幂等的，不抛（框架的契约）。
        .onConflictDoNothing()
        .run();
      return Promise.resolve(OK);
    },
    read(conversationId, opts): Promise<LedgerEntry[]> {
      const rows = db
        .select()
        .from(conversationEvents)
        .where(eq(conversationEvents.conversationId, conversationId))
        .orderBy(asc(conversationEvents.seq))
        .all();
      const afterSeq = opts?.afterSeq;
      const entries: LedgerEntry[] = [];
      for (const row of rows) {
        if (row.kind !== 'message') {
          continue;
        } // 见文件头要点 1：历史遗留的 chunk 行
        if (afterSeq !== undefined && row.seq <= afterSeq) {
          continue;
        }
        const message = parseMessage(row.payloadJson, log);
        if (message === undefined) {
          continue;
        }
        entries.push({
          conversationId,
          seq: row.seq,
          message,
          ts: row.ts.getTime(),
        });
      }
      return Promise.resolve(entries);
    },
    maxSeq(conversationId: string): Promise<number> {
      const row = db
        .select({ value: max(conversationEvents.seq) })
        .from(conversationEvents)
        .where(eq(conversationEvents.conversationId, conversationId))
        .get();
      return Promise.resolve(row?.value ?? 0);
    },
  };
}

// ---------------------------------------------------------------------------
// 裁决表
// ---------------------------------------------------------------------------

/**
 * `payload_json` → `JsonValue`。反序列化边界，走 core 自己导出的 schema 收窄——
 * `JSON.parse` 的 `any` 只作为 `.parse()` 的实参一次性经过，不落进任何具名变量。
 * 坏行当作「没有 payload」（`null` 是合法 `JsonValue`），不抛。
 */
function parseJsonValue(payloadJson: string): JsonValue {
  try {
    return jsonValueSchema.parse(JSON.parse(payloadJson));
  } catch {
    return null;
  }
}

function createDecisionStore(db: Db): DecisionStore {
  return {
    record(entry: DecisionRecord): Promise<WriteResult> {
      db.insert(conversationDecisions)
        .values({
          conversationId: entry.conversationId,
          toolCallId: entry.toolCallId,
          kind: entry.kind,
          toolName: entry.toolName ?? null,
          payloadJson:
            entry.payload === undefined ? null : JSON.stringify(entry.payload),
          outcome: entry.outcome ?? null,
          scope: entry.scope ?? null,
          decidedBy: entry.decidedBy ?? null,
          message: entry.message ?? null,
          requestedAt: new Date(entry.requestedAt),
          decidedAt:
            entry.decidedAt === undefined ? null : new Date(entry.decidedAt),
        })
        // 同一个 callId 重登记（防御性）覆盖旧行，不抛。
        .onConflictDoUpdate({
          target: [
            conversationDecisions.conversationId,
            conversationDecisions.toolCallId,
          ],
          set: { requestedAt: new Date(entry.requestedAt) },
        })
        .run();
      return Promise.resolve(OK);
    },
    settle(conversationId, toolCallId, settlement): Promise<boolean> {
      const existing = db
        .select()
        .from(conversationDecisions)
        .where(
          and(
            eq(conversationDecisions.conversationId, conversationId),
            eq(conversationDecisions.toolCallId, toolCallId),
          ),
        )
        .get();
      if (existing === undefined || existing.decidedAt !== null) {
        return Promise.resolve(false);
      }
      db.update(conversationDecisions)
        .set({
          outcome: settlement.outcome ?? null,
          scope: settlement.scope ?? null,
          decidedBy: settlement.decidedBy ?? null,
          message: settlement.message ?? null,
          decidedAt: new Date(settlement.decidedAt),
        })
        .where(
          and(
            eq(conversationDecisions.conversationId, conversationId),
            eq(conversationDecisions.toolCallId, toolCallId),
          ),
        )
        .run();
      return Promise.resolve(true);
    },
    listPending(conversationId: string): Promise<DecisionRecord[]> {
      const rows = db
        .select()
        .from(conversationDecisions)
        .where(eq(conversationDecisions.conversationId, conversationId))
        .all();
      return Promise.resolve(
        rows
          .filter((row) => row.decidedAt === null)
          .map((row) => ({
            conversationId: row.conversationId,
            toolCallId: row.toolCallId,
            kind: row.kind,
            ...(row.toolName !== null ? { toolName: row.toolName } : {}),
            // `payload` 带回去是有具体用途的：审批卡片上点「会话内都允许」时，路由要拿
            // **这次调用的原始入参**去记一条[会话级授权](../../../../docs/terms.md)，而
            // 路由手上只有 callId。
            ...(row.payloadJson !== null ?
              { payload: parseJsonValue(row.payloadJson) }
            : {}),
            requestedAt: row.requestedAt.getTime(),
          })),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// 待发队列（落 `conversations.queued_messages_json` 那一列，形状换成框架的 QueuedInput）
// ---------------------------------------------------------------------------

const queuedInputSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  seq: z.number(),
  input: z.object({
    text: z.string(),
    userId: z.string().optional(),
  }),
  createdAt: z.number(),
});
const queuedInputsSchema = z.array(queuedInputSchema);

/**
 * **迁移前的旧形状**（`{id,text,userId,createdAt}`，即 `schemas/chat.ts` 的
 * `QueuedMessageSchema`）。这一列的形状随本批换成了框架的 `QueuedInput`，而它是
 * **用户真正排着的消息**——升级重启时按「解析失败 = 空队列」处理，等于把它们静默吞掉，
 * 正好打破框架在 `shutdown()` 里刻意不清队列的那个承诺（「服务重启不该吞掉用户排的消息」）。
 * 所以这里就地升格，不丢。
 */
const legacyQueuedMessageSchema = z.object({
  id: z.string(),
  text: z.string().min(1),
  userId: z.string(),
  createdAt: z.number().int(),
});
const legacyQueuedMessagesSchema = z.array(legacyQueuedMessageSchema);

/** 旧行 → `QueuedInput`。`seq` 按数组下标补，够用：它只用来排序，不参与去重。 */
function upgradeLegacyQueue(
  rows: z.infer<typeof legacyQueuedMessagesSchema>,
  conversationId: string,
): QueuedInput[] {
  return rows.map((row, index) => ({
    id: row.id,
    conversationId,
    seq: index + 1,
    input: {
      text: row.text,
      ...(row.userId !== '' ? { userId: row.userId } : {}),
    },
    createdAt: row.createdAt,
  }));
}

/**
 * JSON 列 → `QueuedInput[]`。先按新形状解析；不匹配就试一次**旧形状并就地升格**；
 * 两样都不是（手改坏了库）才**当作空队列**并记一行 warn，而不是抛——队列是辅助状态，
 * 不该让一次 `GET .../conversations` 或一轮收尾因为它而 500。
 */
export function parseQueuedInputs(
  json: string,
  conversationId: string,
  log: Logger = defaultLogger,
): QueuedInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    log.warn(LOG_SCOPE, 'queued inputs column is not valid JSON', {
      conversationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
  const result = queuedInputsSchema.safeParse(parsed);
  if (!result.success) {
    // 迁移前那一版写下的行——升格而不是丢掉。
    const legacy = legacyQueuedMessagesSchema.safeParse(parsed);
    if (legacy.success) {
      log.info(LOG_SCOPE, 'upgrading legacy queued messages to QueuedInput', {
        conversationId,
        count: legacy.data.length,
      });
      return upgradeLegacyQueue(legacy.data, conversationId);
    }
    log.warn(LOG_SCOPE, 'queued inputs column failed validation', {
      conversationId,
      error: result.error.message,
    });
    return [];
  }
  return result.data;
}

function createQueueStore(db: Db, log: Logger): QueueStore {
  const read = (conversationId: string): QueuedInput[] => {
    const row = db
      .select({ json: conversations.queuedMessagesJson })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get();
    if (row === undefined) {
      return [];
    }
    return parseQueuedInputs(row.json, conversationId, log);
  };
  const write = (
    conversationId: string,
    queue: QueuedInput[],
  ): QueuedInput[] => {
    db.update(conversations)
      .set({ queuedMessagesJson: JSON.stringify(queue) })
      .where(eq(conversations.id, conversationId))
      .run();
    return queue;
  };

  return {
    enqueue(conversationId, input: TurnInput, opts): Promise<EnqueueOutcome> {
      const current = read(conversationId);
      const queued: QueuedInput = {
        id: crypto.randomUUID(),
        conversationId,
        seq: (current.at(-1)?.seq ?? 0) + 1,
        input,
        createdAt: Date.now(),
      };
      if (current.length >= opts.max) {
        if (opts.onFull === 'reject') {
          return Promise.resolve({ ok: false, reason: 'full', queue: current });
        }
        const trimmed = [
          ...current.slice(current.length - opts.max + 1),
          queued,
        ];
        return Promise.resolve({
          ok: true,
          queued,
          queue: write(conversationId, trimmed),
        });
      }
      return Promise.resolve({
        ok: true,
        queued,
        queue: write(conversationId, [...current, queued]),
      });
    },
    dequeue(conversationId) {
      const current = read(conversationId);
      const [head, ...rest] = current;
      if (head === undefined) {
        return Promise.resolve({ item: undefined, queue: current });
      }
      return Promise.resolve({
        item: head,
        queue: write(conversationId, rest),
      });
    },
    list(conversationId) {
      return Promise.resolve(read(conversationId));
    },
    remove(conversationId, id) {
      const current = read(conversationId);
      const next = current.filter((item) => item.id !== id);
      if (next.length === current.length) {
        return Promise.resolve({ removed: false, queue: current });
      }
      return Promise.resolve({
        removed: true,
        queue: write(conversationId, next),
      });
    },
    clear(conversationId) {
      return Promise.resolve(write(conversationId, []));
    },
    requeueFront(conversationId, item) {
      // 刻意不受 `max` 约束：这是回滚一次已发生的出队，不是新的入队请求。
      return Promise.resolve(
        write(conversationId, [item, ...read(conversationId)]),
      );
    },
  };
}

export function createChatPersistence(
  db: Db,
  log: Logger = defaultLogger,
): Persistence {
  return {
    ledger: createLedgerStore(db, log),
    decisions: createDecisionStore(db),
    queue: createQueueStore(db, log),
  };
}

// ---------------------------------------------------------------------------
// 归属仲裁机制：[起轮标记](../../../../docs/terms.md)落 `conversations.turn_holder`
// ---------------------------------------------------------------------------

export interface ChatArbitrationOptions {
  holder?: string;
}

/**
 * 单进程 + 落库的[归属仲裁机制](../../../../docs/terms.md)——比框架内置的内存 Map 多的
 * 只有一样：**标记活得比进程久**，所以启动扫描认得出[孤儿轮](../../../../docs/terms.md)。
 *
 * 这一档**不需要 CAS**：better-sqlite3 全同步，单进程内「读-判断-写」中间插不进别的
 * 东西。上多进程时这里要换成带心跳与[租期标识](../../../../docs/terms.md)的租约版
 * （`@nimbo/persist-sql`），轮编排一行不用改。
 */
export function createChatArbitration(
  db: Db,
  opts: ChatArbitrationOptions = {},
): Arbitration {
  const holder = opts.holder ?? `pid:${String(process.pid)}`;
  /** conversationId → 这个会话的 seq 水位（进程内缓存，首次抢占时回库里问一次）。 */
  const watermarks = new Map<string, number>();

  const readHolder = (conversationId: string): string | null | undefined => {
    const row = db
      .select({ turnHolder: conversations.turnHolder })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get();
    return row?.turnHolder;
  };

  return {
    async acquire(conversationId, ctx) {
      const current = readHolder(conversationId);
      if (current === undefined) {
        // 会话行不存在——起轮标记无处可写。报 busy 而不是抛：调用方（路由）本来就已经
        // 先做过属主校验，走到这里说明会话刚被删了。
        return { ok: false, reason: 'busy', holder: undefined };
      }
      if (current !== null) {
        return { ok: false, reason: 'busy', holder: current };
      }

      db.update(conversations)
        .set({ turnHolder: holder, turnStartedAt: new Date() })
        .where(eq(conversations.id, conversationId))
        .run();

      let watermark = watermarks.get(conversationId);
      if (watermark === undefined) {
        watermark = await ctx.seedSeq();
        watermarks.set(conversationId, watermark);
      }

      const controller = new AbortController();
      let released = false;
      const grant: Grant = {
        conversationId,
        holder,
        signal: controller.signal,
        get valid() {
          return !released;
        },
        nextSeq() {
          if (released) {
            return Promise.resolve({ ok: false, reason: 'lost_ownership' });
          }
          const next = (watermarks.get(conversationId) ?? 0) + 1;
          watermarks.set(conversationId, next);
          return Promise.resolve({ ok: true, seq: next });
        },
        release() {
          if (released) {
            return Promise.resolve();
          }
          released = true;
          db.update(conversations)
            .set({ turnHolder: null, turnStartedAt: null })
            .where(
              and(
                eq(conversations.id, conversationId),
                eq(conversations.turnHolder, holder),
              ),
            )
            .run();
          return Promise.resolve();
        },
      };
      return { ok: true, grant };
    },

    inspect(conversationId) {
      const current = readHolder(conversationId);
      if (current === undefined || current === null) {
        return Promise.resolve({ held: false });
      }
      return Promise.resolve({ held: true, holder: current });
    },

    /**
     * **只在进程启动、开始服务之前调**：那一刻本进程不可能有任何轮在跑，所以库里还
     * 留着的每一条标记都是上次崩溃的残留。
     */
    listStale(): Promise<StaleOwnership[]> {
      const rows = db
        .select({ id: conversations.id, turnHolder: conversations.turnHolder })
        .from(conversations)
        .where(isNotNull(conversations.turnHolder))
        .all();
      return Promise.resolve(
        rows.map((row) => ({
          conversationId: row.id,
          ...(row.turnHolder !== null ? { holder: row.turnHolder } : {}),
        })),
      );
    },

    clearStale(conversationId) {
      db.update(conversations)
        .set({ turnHolder: null, turnStartedAt: null })
        .where(eq(conversations.id, conversationId))
        .run();
      return Promise.resolve();
    },
  };
}
