/**
 * 三个领域接口，**直接落在 MongoDB 驱动上**——没有中间层。
 *
 * 这是第一个非关系型实现，所以它同时是对[契约](../../../docs/host/contract/tech/persistence.md)
 * 里那几条准则的检验。逐条的实测结论：
 *
 * | 准则 | 在 Mongo 上成不成立 |
 * |---|---|
 * | 不假设事务能跨接口 | ✅ 成立。需要原子的只有 `dequeue`，而 Mongo 的 `findOneAndDelete` **原生原子**——比 SQL 那几家还干净（它们是读-删两步 + 竞态重试） |
 * | 不要求 CAS | ✅ 成立。这一版一次 CAS 都没用上 |
 * | 不支持跨会话查询 | ✅ 成立。每个查询都以 `conversationId` 打头，正好是索引前缀 |
 * | 迁移不是契约的一部分 | ✅ 成立。Mongo 没有建表，`migrate()` 只建索引 |
 *
 * **两个 Mongo 特有的坑**（都是实测出来的，见各处注释）：
 *
 * 1. `updateOne` 匹配到但值没变时 `modifiedCount === 0`——判断「有没有这条」必须看
 *    **`matchedCount`**。（这正是契约文档曾经安在 MySQL 头上、结果在 MySQL 上不成立的
 *    那个坑的**真身**——它在 Mongo 上是真的。）
 * 2. BSON 把 `undefined` 存成 `null`，而 SQL 那几家会把这个键丢掉。见 `toBson`。
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
} from "@runko/agent";
import type { JsonValue, RunkoUIMessage } from "@runko/core";
import type { Db, Filter } from "mongodb";

import type { DecisionDoc, LedgerDoc, QueueDoc } from "./collections.js";
import {
  DECISIONS_COLLECTION,
  fromBson,
  LEDGER_COLLECTION,
  QUEUE_COLLECTION,
  toBson,
} from "./collections.js";

const OK: WriteResult = { ok: true };

/** 重复键。并发 upsert 撞同一个唯一索引时驱动抛这个，见 `upsertOnce`。 */
const DUPLICATE_KEY = 11000;

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === DUPLICATE_KEY
  );
}

/**
 * 幂等插入的**兜底那一半**：吞掉重复键，其余错误照抛。
 *
 * 幂等本身靠 `upsert` + `$setOnInsert`（在调用点写），不靠异常——「先查再插」有竞态
 * 窗口，「插了 catch」会把真正的写失败也一起吞掉。
 *
 * 但 `upsert` 在并发下**仍可能抛重复键**：两个请求同时发现不存在、同时插，唯一索引
 * 挡下后一个。这是 MongoDB 明确记录的行为，不是 bug。那一支的结果照样是「已经有了
 * 一行」——契约要的是「不得写出两行」，满足了，所以吞掉。
 *
 * **只包异常处理、不包 `updateOne` 本身**是刻意的：这样 `$setOnInsert` 的字段能在
 * **具体的调用点**跟具体的文档类型对上，写错字段当场编译不过。包成一个泛型 helper
 * 反而会把类型冲开、逼出一个 `as`。
 */
async function ignoringDuplicateKey<T>(write: () => Promise<T>): Promise<T | undefined> {
  try {
    return await write();
  } catch (error: unknown) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }
    // 撞唯一索引 = 并发下另一个 upsert 抢先建了同一条。返回 undefined，让调用方自己
    // 决定这算幂等（同一条重写）还是拒绝（别的内容占了这个号）。
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 账本
// ---------------------------------------------------------------------------

export function createLedgerStore(db: Db): LedgerStore {
  const col = db.collection<LedgerDoc>(LEDGER_COLLECTION);

  return {
    async append(entry: LedgerEntry): Promise<WriteResult> {
      // `$setOnInsert` 里**不重复写 filter 那两个字段**——Mongo 在插入时会自己把
      // filter 的等值条件填进去，重复写会报 "would create a conflict"。
      const result = await ignoringDuplicateKey(() =>
        col.updateOne(
          { conversationId: entry.conversationId, seq: entry.seq },
          { $setOnInsert: { payload: toBson(entry.message), ts: entry.ts } },
          { upsert: true },
        ),
      );
      if (result?.upsertedCount === 1) {
        return OK;
      }

      // 没插进去 = 这个号已经有人了。**两种情况必须分开**：同一条消息重写一遍是幂等
      // （报成功），**另一条**消息占了这个号则意味着这条其实没落库——报成功等于静默丢
      // 消息。租约版归属仲裁上线后这正是最需要被看见的信号。
      const existing = await col.findOne(
        { conversationId: entry.conversationId, seq: entry.seq },
        { projection: { _id: 0 } },
      );
      if (existing !== null && fromBson<RunkoUIMessage>(existing.payload).id === entry.message.id) {
        return OK;
      }
      return { ok: false, reason: "rejected" };
    },

    async read(conversationId, opts): Promise<LedgerEntry[]> {
      // `afterSeq` **不含自身**（`$gt`），结果按 seq **升序**——两条都是契约明文。
      const filter: Filter<LedgerDoc> =
        opts?.afterSeq === undefined
          ? { conversationId }
          : { conversationId, seq: { $gt: opts.afterSeq } };

      const docs = await col
        .find(filter, { projection: { _id: 0 } })
        .sort({ seq: 1 })
        .toArray();

      return docs.map((doc) => ({
        conversationId: doc.conversationId,
        seq: doc.seq,
        message: fromBson<RunkoUIMessage>(doc.payload),
        ts: doc.ts,
      }));
    },

    async maxSeq(conversationId): Promise<number> {
      // 走 `(conversationId, seq)` 那个索引的反向扫描，取第一条即可——比聚合 `$max` 便宜，
      // 而且空会话直接给 null（契约要求返回 0）。
      const doc = await col.findOne(
        { conversationId },
        { sort: { seq: -1 }, projection: { seq: 1, _id: 0 } },
      );
      return doc?.seq ?? 0;
    },
  };
}

// ---------------------------------------------------------------------------
// 裁决表
// ---------------------------------------------------------------------------

function isOutcome(value: string | null): value is NonNullable<DecisionRecord["outcome"]> {
  return value === "allow" || value === "deny" || value === "answered" || value === "timeout";
}

/** 可选字段一律「有才放进去」——`exactOptionalPropertyTypes` 下不能给 `undefined`。 */
function toRecord(doc: DecisionDoc): DecisionRecord {
  return {
    conversationId: doc.conversationId,
    toolCallId: doc.toolCallId,
    kind: doc.kind === "question" ? "question" : "approval",
    ...(doc.toolName !== null ? { toolName: doc.toolName } : {}),
    ...(doc.payload !== null ? { payload: fromBson<JsonValue>(doc.payload) } : {}),
    ...(isOutcome(doc.outcome) ? { outcome: doc.outcome } : {}),
    ...(doc.scope === "once" || doc.scope === "conversation" ? { scope: doc.scope } : {}),
    ...(doc.decidedBy !== null ? { decidedBy: doc.decidedBy } : {}),
    ...(doc.message !== null ? { message: doc.message } : {}),
    requestedAt: doc.requestedAt,
    ...(doc.decidedAt !== null ? { decidedAt: doc.decidedAt } : {}),
  };
}

export function createDecisionStore(db: Db): DecisionStore {
  const col = db.collection<DecisionDoc>(DECISIONS_COLLECTION);

  return {
    async record(entry: DecisionRecord): Promise<WriteResult> {
      // 同上：filter 那两个字段不进 `$setOnInsert`。
      await ignoringDuplicateKey(() =>
        col.updateOne(
          { conversationId: entry.conversationId, toolCallId: entry.toolCallId },
          {
            $setOnInsert: {
              kind: entry.kind,
              toolName: entry.toolName ?? null,
              payload: entry.payload === undefined ? null : toBson(entry.payload),
              outcome: entry.outcome ?? null,
              scope: entry.scope ?? null,
              decidedBy: entry.decidedBy ?? null,
              message: entry.message ?? null,
              requestedAt: entry.requestedAt,
              decidedAt: entry.decidedAt ?? null,
            },
          },
          { upsert: true },
        ),
      );
      return OK;
    },

    async settle(conversationId, toolCallId, settlement): Promise<boolean> {
      // `decidedAt: null` 是关键：只结清**还待定的**那条。已结清 / 已超时 / 从未存在，
      // 三种都匹配不到 → 返回 false（契约明文）。
      const result = await col.updateOne(
        { conversationId, toolCallId, decidedAt: null },
        {
          $set: {
            outcome: settlement.outcome ?? null,
            scope: settlement.scope ?? null,
            decidedBy: settlement.decidedBy ?? null,
            message: settlement.message ?? null,
            decidedAt: settlement.decidedAt,
          },
        },
      );
      // ⚠️ **必须看 `matchedCount`，不能看 `modifiedCount`。** 实测：匹配到但新值与旧值
      // 完全相同时，Mongo 报 `matched=1, modified=0`。用 `modifiedCount` 就会把一次
      // 成功的结清误报成「没有这条」，调用方于是转 404。
      return result.matchedCount > 0;
    },

    async listPending(conversationId): Promise<DecisionRecord[]> {
      const docs = await col
        .find({ conversationId, decidedAt: null }, { projection: { _id: 0 } })
        .sort({ requestedAt: 1 })
        .toArray();
      return docs.map(toRecord);
    },
  };
}

// ---------------------------------------------------------------------------
// 待发队列
// ---------------------------------------------------------------------------

/** `enqueue` / `requeueFront` 撞号时的重试上限——够覆盖真实并发，又不会在病态负载下无限转。 */
const ENQUEUE_MAX_ATTEMPTS = 5;

export function createQueueStore(db: Db): QueueStore {
  const col = db.collection<QueueDoc>(QUEUE_COLLECTION);

  const toItem = (doc: QueueDoc): QueuedInput => ({
    id: doc._id,
    conversationId: doc.conversationId,
    seq: doc.seq,
    input: fromBson<TurnInput>(doc.input),
    createdAt: doc.createdAt,
  });

  const list = async (conversationId: string): Promise<QueuedInput[]> => {
    const docs = await col.find({ conversationId }).sort({ seq: 1 }).toArray();
    return docs.map(toItem);
  };

  /**
   * 插一条。`(conversationId, seq)` 上有唯一索引，撞号会抛 11000（duplicate key）——
   * 返回 false 让调用方换号重来，其余错误照常往外抛。
   */
  const insert = async (item: QueuedInput): Promise<boolean> => {
    try {
      await col.insertOne({
        _id: item.id,
        conversationId: item.conversationId,
        seq: item.seq,
        input: toBson(item.input),
        createdAt: item.createdAt,
      });
      return true;
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        return false;
      }
      throw error;
    }
  };

  return {
    async enqueue(conversationId, input: TurnInput, opts): Promise<EnqueueOutcome> {
      // 撞号就换个号重来——上限见 `ENQUEUE_MAX_ATTEMPTS`。
      for (let attempt = 0; attempt < ENQUEUE_MAX_ATTEMPTS; attempt += 1) {
      const current = await list(conversationId);
      if (current.length >= opts.max) {
        if (opts.onFull === "reject") {
          // **原样返回当前队列，不截断不覆盖**（契约明文）。
          return { ok: false, reason: "full", queue: current };
        }
        const oldest = current[0];
        if (oldest !== undefined) {
          await col.deleteOne({ _id: oldest.id });
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
      if (!(await insert(item))) {
        // 这个号被并发的另一条抢走了——重新读一次最大值，换个号。
        continue;
      }

      // 号是稳的了，剩下只有「几条各自拿到不同号、加起来越过 max」这一种越界：退让。
      const after = await list(conversationId);
      if (opts.onFull === "reject" && after.length > opts.max) {
        await col.deleteOne({ _id: item.id });
        return { ok: false, reason: "full", queue: await list(conversationId) };
      }
      return { ok: true, queued: item, queue: after };
      }
      // 连撞几次说明这个会话正被高频写入。如实拒绝，不猜。
      return { ok: false, reason: "full", queue: await list(conversationId) };
    },

    async dequeue(conversationId): Promise<{ item: QueuedInput | undefined; queue: QueuedInput[] }> {
      // **这里是 Mongo 比 SQL 那几家干净的地方**：`findOneAndDelete` 带 `sort` 是**原生
      // 原子**的——「取队首」与「移除它」在服务端一次完成。SQL 那边是「先 SELECT 排序
      // 取第一条、再 DELETE」两步，中间有窗口，得靠「删失败就重来」兜。
      //
      // 契约要求的「取出即移除，一个方法内原子完成」，在这一档是数据库直接给的。
      const doc = await col.findOneAndDelete({ conversationId }, { sort: { seq: 1 } });
      if (doc === null) {
        return { item: undefined, queue: [] };
      }
      return { item: toItem(doc), queue: await list(conversationId) };
    },

    list,

    async remove(conversationId, id): Promise<{ removed: boolean; queue: QueuedInput[] }> {
      const result = await col.deleteOne({ conversationId, _id: id });
      return { removed: result.deletedCount > 0, queue: await list(conversationId) };
    },

    async clear(conversationId): Promise<QueuedInput[]> {
      await col.deleteMany({ conversationId });
      return [];
    },

    async requeueFront(conversationId, item): Promise<QueuedInput[]> {
      // 放**回队首**：取当前最小 seq 再减 1。**刻意不受 `max` 约束**——这是回滚一次
      // 已发生的出队，不是新的入队请求（契约明文）。
      //
      // 同样要处理撞号：`(conversationId, seq)` 上有唯一索引，撞了插入会失败，而这条
      // 消息是**已经出过队的**，丢了就真丢了。撞了就继续往下减。
      for (let attempt = 0; attempt < ENQUEUE_MAX_ATTEMPTS; attempt += 1) {
        const current = await list(conversationId);
        const head = current[0];
        const seq = head === undefined ? item.seq : Math.min(item.seq, head.seq - 1) - attempt;
        if (await insert({ ...item, conversationId, seq })) {
          break;
        }
      }
      return await list(conversationId);
    },
  };
}
