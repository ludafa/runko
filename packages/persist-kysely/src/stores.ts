/**
 * 三个领域接口，全部走 Kysely 的查询构建器——**没有一行手写 SQL**。
 *
 * 换掉手搓方言层的直接收益，是这三处不用自己想了：
 *
 * 1. **`settle` / `remove` 不再需要 `RETURNING`**。原先靠它判断「到底改没改」，而
 *    **MySQL 根本不支持 RETURNING**。Kysely 的 `numUpdatedRows` / `numDeletedRows` 三家通吃。
 *    > 实测过 MySQL 那个著名的坑（`affectedRows` 报「真变了几行」而不是「匹配到几行」，
 *    > 值没变时返回 0）：**在 mysql2 + Kysely 这条路上不成立**——`numUpdatedRows` 报的
 *    > 就是匹配行数，「真变了几行」另有 `numChangedRows`。
 * 2. **占位符、标识符引号**：Kysely 按方言自己拼。
 * 3. **类型安全**：表和列从 `NimboDatabase` 推，写错列名当场编译不过。
 */
import type {
  DecisionRecord,
  DecisionStore,
  EnqueueOutcome,
  LedgerEntry,
  LedgerStore,
  QueuedInput,
  QueueStore,
  TurnInput,
  WriteResult,
} from "@nimbo/agent";
import type { JsonValue, NimboUIMessage } from "@nimbo/core";
import type { InsertQueryBuilder, Kysely } from "kysely";
import { sql } from "kysely";

import type { FlavorTraits } from "./flavor.js";
import { decodeJson, encodeJson, toNumber } from "./flavor.js";
import type { DecisionsTable, LedgerTable, NimboDatabase, QueueTable } from "./schema.js";
import { DECISIONS_TABLE, LEDGER_TABLE, QUEUE_TABLE } from "./schema.js";

const OK: WriteResult = { ok: true };

/** `enqueue` 撞号时的重试上限——够覆盖真实并发，又不会在病态负载下无限转。 */
const ENQUEUE_MAX_ATTEMPTS = 5;

type Db = Kysely<NimboDatabase>;

/**
 * 幂等插入——**这是三个方言唯一需要分支的写法**（见 `flavor.ts` 那张表）。
 *
 * 抽成一个泛型函数而不是在每个 Store 里写一遍 `if`：三处调用点形状一样，重复三遍
 * 只会让「MySQL 走另一条路」这件事散在三个地方。
 */
function insertOrIgnore<T extends keyof NimboDatabase, O>(
  traits: FlavorTraits,
  query: InsertQueryBuilder<NimboDatabase, T, O>,
  conflictColumns: readonly string[],
): InsertQueryBuilder<NimboDatabase, T, O> {
  if (traits.idempotentInsert === "on-duplicate-key") {
    // **不能用 `INSERT IGNORE`。** 它把所有可恢复错误一起降级成 warning（超长截断、
    // 约束失败整行跳过），调用方却拿到「写成功了」——静默丢数据，而且丢的那一档正好是
    // 三个方言里唯一静默的。`ON DUPLICATE KEY UPDATE <某列>=<某列>` 是一个无操作的
    // 更新，只吞重复键，语义与另两家的 `DO NOTHING` 对齐。详见 `flavor.ts` 的坑 ②。
    const noop = conflictColumns[0];
    if (noop === undefined) {throw new Error("insertOrIgnore requires at least one conflict column");}
    return query.onDuplicateKeyUpdate({ [noop]: sql.ref(noop) } as never);
  }
  return query.onConflict((oc) => oc.columns([...conflictColumns] as never).doNothing());
}

// ---------------------------------------------------------------------------
// 账本
// ---------------------------------------------------------------------------

export function createLedgerStore(db: Db, traits: FlavorTraits): LedgerStore {
  const toEntry = (row: LedgerTable): LedgerEntry => ({
    conversationId: row.conversation_id,
    seq: toNumber(row.seq),
    // `payload` 存的就是我们 `append` 时写进去的 `NimboUIMessage`——形状归 core 管，
    // 这里不重新校验（core 在 `createSession({resume})` 里会跑 `validateUIMessages`）。
    message: decodeJson(traits, row.payload) as unknown as NimboUIMessage,
    ts: toNumber(row.ts),
  });

  return {
    async append(entry): Promise<WriteResult> {
      // 同 `(conversationId, seq)` 重复写入**不得写出两行**（契约明文）。
      const result = await insertOrIgnore(
        traits,
        db.insertInto(LEDGER_TABLE).values({
          conversation_id: entry.conversationId,
          seq: entry.seq,
          payload: encodeJson(entry.message),
          ts: entry.ts,
        }),
        ["conversation_id", "seq"],
      ).executeTakeFirst();

      // 快路：`ON CONFLICT DO NOTHING` 那两档，affectedRows 为 0 就是「被忽略了」，可信。
      // **MySQL 那档不能信**：`ON DUPLICATE KEY UPDATE` 把「无操作更新」也算进
      // affectedRows，读数分不出「插进去了」和「撞了没动」——所以那一档一律读回来确认。
      const inserted = toNumber(result.numInsertedOrUpdatedRows ?? 0n) > 0;
      if (inserted && traits.idempotentInsert !== "on-duplicate-key") {
        return OK;
      }

      // 没插进去 = 这个号已经有人了。**两种情况必须分开**：
      // - 同一条消息重写一遍（宿主重试）→ 幂等，报成功；
      // - **另一条**消息占了这个号 → 这条消息其实没落库，报成功等于静默丢消息。
      //   租约版归属仲裁上线后这正是最需要被看见的信号：两个进程各自发号撞在一起。
      const existing = await db
        .selectFrom(LEDGER_TABLE)
        .selectAll()
        .where("conversation_id", "=", entry.conversationId)
        .where("seq", "=", entry.seq)
        .executeTakeFirst();
      if (existing !== undefined && toEntry(existing).message.id === entry.message.id) {
        return OK;
      }
      return { ok: false, reason: "rejected" };
    },

    async read(conversationId, opts): Promise<LedgerEntry[]> {
      // `afterSeq` **不含自身**（严格大于），结果按 seq **升序**——两条都是契约明文。
      let query = db
        .selectFrom(LEDGER_TABLE)
        .selectAll()
        .where("conversation_id", "=", conversationId);
      if (opts?.afterSeq !== undefined) {
        query = query.where("seq", ">", opts.afterSeq);
      }
      const rows = await query.orderBy("seq", "asc").execute();
      return rows.map(toEntry);
    },

    async maxSeq(conversationId): Promise<number> {
      const row = await db
        .selectFrom(LEDGER_TABLE)
        .select((eb) => eb.fn.max("seq").as("max_seq"))
        .where("conversation_id", "=", conversationId)
        .executeTakeFirst();
      // 空会话：没有行时 `MAX()` 给 NULL，契约要求返回 0。
      return toNumber(row?.max_seq);
    },
  };
}

// ---------------------------------------------------------------------------
// 裁决表
// ---------------------------------------------------------------------------

function isOutcome(value: string | null): value is NonNullable<DecisionRecord["outcome"]> {
  return value === "allow" || value === "deny" || value === "answered" || value === "timeout";
}

export function createDecisionStore(db: Db, traits: FlavorTraits): DecisionStore {
  /** 可选字段一律「有才放进去」——`exactOptionalPropertyTypes` 下不能给 `undefined`。 */
  const toRecord = (row: DecisionsTable): DecisionRecord => ({
    conversationId: row.conversation_id,
    toolCallId: row.tool_call_id,
    kind: row.kind === "question" ? "question" : "approval",
    ...(row.tool_name !== null ? { toolName: row.tool_name } : {}),
    ...(row.payload !== null ? { payload: decodeJson(traits, row.payload) as JsonValue } : {}),
    ...(isOutcome(row.outcome) ? { outcome: row.outcome } : {}),
    ...(row.scope === "once" || row.scope === "conversation" ? { scope: row.scope } : {}),
    ...(row.decided_by !== null ? { decidedBy: row.decided_by } : {}),
    ...(row.message !== null ? { message: row.message } : {}),
    requestedAt: toNumber(row.requested_at),
    ...(row.decided_at !== null ? { decidedAt: toNumber(row.decided_at) } : {}),
  });

  return {
    async record(entry): Promise<WriteResult> {
      await insertOrIgnore(
        traits,
        db.insertInto(DECISIONS_TABLE).values({
          conversation_id: entry.conversationId,
          tool_call_id: entry.toolCallId,
          kind: entry.kind,
          tool_name: entry.toolName ?? null,
          payload: entry.payload === undefined ? null : encodeJson(entry.payload),
          outcome: entry.outcome ?? null,
          scope: entry.scope ?? null,
          decided_by: entry.decidedBy ?? null,
          message: entry.message ?? null,
          requested_at: entry.requestedAt,
          decided_at: entry.decidedAt ?? null,
        }),
        ["conversation_id", "tool_call_id"],
      ).execute();
      return OK;
    },

    async settle(conversationId, toolCallId, settlement): Promise<boolean> {
      // `decided_at is null` 是关键：只结清**还待定的**那条。已结清 / 已超时 / 从未
      // 存在，三种都匹配不到 → `numUpdatedRows === 0` → 返回 false（契约明文）。
      const result = await db
        .updateTable(DECISIONS_TABLE)
        .set({
          outcome: settlement.outcome ?? null,
          scope: settlement.scope ?? null,
          decided_by: settlement.decidedBy ?? null,
          message: settlement.message ?? null,
          decided_at: settlement.decidedAt,
        })
        .where("conversation_id", "=", conversationId)
        .where("tool_call_id", "=", toolCallId)
        .where("decided_at", "is", null)
        .executeTakeFirst();
      return toNumber(result.numUpdatedRows) > 0;
    },

    async listPending(conversationId): Promise<DecisionRecord[]> {
      const rows = await db
        .selectFrom(DECISIONS_TABLE)
        .selectAll()
        .where("conversation_id", "=", conversationId)
        .where("decided_at", "is", null)
        .orderBy("requested_at", "asc")
        .execute();
      return rows.map(toRecord);
    },
  };
}

// ---------------------------------------------------------------------------
// 待发队列
// ---------------------------------------------------------------------------

/**
 * 库里读回来的 `input` 列 → `TurnInput`。
 *
 * **这里做运行时校验，不用裸断言**：账本那一列的形状归 core 管（`resume` 时会跑
 * `validateUIMessages`），下游有人兜底；但队列这一列没人兜——`TurnInput.text` 是必填的，
 * 库里若有一行被手改坏，裸断言会让崩溃点出现在很远的地方（起轮时喂给模型才炸）。
 * 在这个边界上就地判，报错指向真正的源头。
 */
function isTurnInput(value: unknown): value is TurnInput {
  if (typeof value !== "object" || value === null) {return false;}
  const candidate: { text?: unknown; userId?: unknown } = value;
  if (typeof candidate.text !== "string") {return false;}
  return candidate.userId === undefined || typeof candidate.userId === "string";
}

function decodeTurnInput(traits: FlavorTraits, column: unknown, id: string): TurnInput {
  const decoded = decodeJson(traits, column);
  if (!isTurnInput(decoded)) {
    throw new Error(`nimbo_queue row ${id} has a malformed input column (expected { text: string })`);
  }
  return decoded;
}

export function createQueueStore(db: Db, traits: FlavorTraits): QueueStore {
  const toItem = (row: QueueTable): QueuedInput => ({
    id: row.id,
    conversationId: row.conversation_id,
    seq: toNumber(row.seq),
    input: decodeTurnInput(traits, row.input, row.id),
    createdAt: toNumber(row.created_at),
  });

  const list = async (conversationId: string): Promise<QueuedInput[]> => {
    const rows = await db
      .selectFrom(QUEUE_TABLE)
      .selectAll()
      .where("conversation_id", "=", conversationId)
      .orderBy("seq", "asc")
      .execute();
    return rows.map(toItem);
  };

  /**
   * 插一条并**读回来确认自己真的进去了**。
   *
   * `(conversation_id, seq)` 上有唯一约束，撞号那条会被幂等插入吞掉——所以「插完没抛错」
   * 不等于「插进去了」，必须读回来看。返回 false = 这个号被别人占了，调用方换号重来。
   */
  const insertUnique = async (item: QueuedInput): Promise<boolean> => {
    await insertOrIgnore(
      traits,
      db.insertInto(QUEUE_TABLE).values({
        conversation_id: item.conversationId,
        id: item.id,
        seq: item.seq,
        input: encodeJson(item.input),
        created_at: item.createdAt,
      }),
      ["conversation_id", "seq"],
    ).execute();
    const rows = await list(item.conversationId);
    return rows.some((row) => row.id === item.id);
  };

  const deleteById = async (conversationId: string, id: string): Promise<boolean> => {
    const result = await db
      .deleteFrom(QUEUE_TABLE)
      .where("conversation_id", "=", conversationId)
      .where("id", "=", id)
      .executeTakeFirst();
    return toNumber(result.numDeletedRows) > 0;
  };

  const store: QueueStore = {
    async enqueue(conversationId, input, opts): Promise<EnqueueOutcome> {
      // **写完再读回来校验，撞上就退让重来**——跟 `dequeue` 同一个思路。
      //
      // 光「先 SELECT 再 INSERT」是不够的：`AgentRuntime.enqueue` 就是从 HTTP handler
      // 直接调的，没有按会话串行，两个并发请求会读到同一份快照——都认为没满（队列长到
      // `max + 1`，而契约要求满了就拒），还都算出同一个 `seq`（主键是
      // `(conversation_id, id)`，拦不住），之后 `orderBy("seq")` 平局，**先到先发不再成立**。
      // 这在 SQLite 单进程下也能复现：`list()` 和 `insert()` 之间有 await 边界。
      //
      // 平局用 `id` 判：撞号的几条里 id 最小的留下，其余撤回重来。**必须是确定的规则**，
      // 否则两边都退让就谁都进不去。
      for (let attempt = 0; attempt < ENQUEUE_MAX_ATTEMPTS; attempt += 1) {
        const current = await list(conversationId);
        if (current.length >= opts.max) {
          if (opts.onFull === "reject") {
            // **原样返回当前队列，不截断不覆盖**（契约明文）。
            return { ok: false, reason: "full", queue: current };
          }
          const oldest = current[0];
          if (oldest !== undefined) {
            await deleteById(conversationId, oldest.id);
          }
        }
        const item: QueuedInput = {
          id: crypto.randomUUID(),
          conversationId,
          // 取当前最大 + 1 而不是 length——中间删掉一条也不会撞号。
          seq: (current.at(-1)?.seq ?? 0) + 1,
          input,
          createdAt: Date.now(),
        };
        if (!(await insertUnique(item))) {
          // 这个号被并发的另一条抢走了——重新读一次最大值，换个号。
          continue;
        }

        // 号是稳的了，剩下只有「几条各自拿到不同号、加起来越过 max」这一种越界。
        const after = await list(conversationId);
        if (opts.onFull === "reject" && after.length > opts.max) {
          await deleteById(conversationId, item.id);
          return { ok: false, reason: "full", queue: await list(conversationId) };
        }
        return { ok: true, queued: item, queue: after };
      }
      // 连撞几次说明这个会话正被高频写入。如实拒绝，不猜。
      return { ok: false, reason: "full", queue: await list(conversationId) };
    },

    async dequeue(conversationId): Promise<{ item: QueuedInput | undefined; queue: QueuedInput[] }> {
      // **取出即移除**：起轮失败时调用方会 `requeueFront` 放回去，先移除保证任何中途
      // 异常都不会让同一条消息被起两轮。
      const current = await list(conversationId);
      const head = current[0];
      if (head === undefined) {
        return { item: undefined, queue: [] };
      }
      if (!(await deleteById(conversationId, head.id))) {
        // 并发下另一个调用者抢先取走了它——重来一次。
        return await store.dequeue(conversationId);
      }
      return { item: head, queue: await list(conversationId) };
    },

    list,

    async remove(conversationId, id): Promise<{ removed: boolean; queue: QueuedInput[] }> {
      const removed = await deleteById(conversationId, id);
      return { removed, queue: await list(conversationId) };
    },

    async clear(conversationId): Promise<QueuedInput[]> {
      await db.deleteFrom(QUEUE_TABLE).where("conversation_id", "=", conversationId).execute();
      return [];
    },

    async requeueFront(conversationId, item): Promise<QueuedInput[]> {
      // 放**回队首**：取当前最小 seq 再减 1。**刻意不受 `max` 约束**——这是回滚一次
      // 已发生的出队，不是新的入队请求（契约明文）。
      //
      // 同样要读回来确认：`(conversation_id, seq)` 上有唯一约束，撞号会被静默吞掉，
      // 而这条消息是**已经出过队的**，吞掉就真丢了。撞了就继续往下减。
      for (let attempt = 0; attempt < ENQUEUE_MAX_ATTEMPTS; attempt += 1) {
        const current = await list(conversationId);
        const head = current[0];
        const seq = head === undefined ? item.seq : Math.min(item.seq, head.seq - 1) - attempt;
        if (await insertUnique({ ...item, conversationId, seq })) {
          break;
        }
      }
      return await list(conversationId);
    },
  };

  return store;
}
