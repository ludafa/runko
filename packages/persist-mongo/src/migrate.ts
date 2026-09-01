/**
 * 建索引。Mongo 里集合是隐式创建的，所以这里没有「建表」——**只有建索引**，但它一样
 * 是必需的：账本与裁决表的**幂等写入靠唯一索引兜底**，没有它并发写会写出两行。
 *
 * 沿用 `migrate()` 这个名字（而不是 `ensureIndexes()`）是刻意的：四个持久化包对宿主
 * 呈现同一套动作——装包、`migrate()`、传进装配。名字不一样只会让人以为语义不一样。
 *
 * **幂等**：`createIndex` 同名同选项重复建是 no-op。同名但**选项不同**时 Mongo 会拒绝
 * （`IndexOptionsConflict`/`IndexKeySpecsConflict`），所以 `ensureIndex` 会把旧的删掉重建
 * ——否则升级到「队列索引改唯一」这一版的人，`migrate()` 会直接崩在启动上。
 */
import type { Db, IndexSpecification, CreateIndexesOptions } from "mongodb";

import {
  DECISIONS_COLLECTION,
  LEDGER_COLLECTION,
  QUEUE_COLLECTION,
} from "./collections.js";

/** 同名索引已存在但选项不同时 Mongo 报的两个 code。 */
const INDEX_CONFLICT_CODES = new Set([85, 86]);

function isIndexConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "number" &&
    INDEX_CONFLICT_CODES.has((error as { code: number }).code)
  );
}

/**
 * 建一个具名索引，**同名不同选项时删了重建**。
 *
 * 这是 `migrate()` 唯一做的一点「演进」，范围限定在本包自己那三个具名索引上：不这么做
 * 的话，任何一次索引选项的变更（比如队列索引从非唯一改成唯一）都会让老库上的
 * `migrate()` 抛 `IndexOptionsConflict` 而启动失败——而 `migrate()` 对外承诺是幂等的。
 *
 * 重建可能失败（存量数据违反新的唯一性），那时照常抛——那种情况需要人介入，不该静默。
 */
async function ensureIndex(
  db: Db,
  collection: string,
  keys: IndexSpecification,
  options: CreateIndexesOptions & { name: string },
): Promise<void> {
  try {
    await db.collection(collection).createIndex(keys, options);
  } catch (error) {
    if (!isIndexConflict(error)) {
      throw error;
    }
    await db.collection(collection).dropIndex(options.name);
    await db.collection(collection).createIndex(keys, options);
  }
}

export async function migrate(db: Db): Promise<void> {
  await Promise.all([
    // 账本：`(conversationId, seq)` 唯一——契约要求同一对重复写入**不得写出两行**。
    // 顺序也正好是读路径要的（按会话过滤 + 按 seq 升序），一个索引两用。
    ensureIndex(db, LEDGER_COLLECTION, { conversationId: 1, seq: 1 }, {
      unique: true,
      name: "nimbo_ledger_conversation_seq",
    }),
    // 裁决表：`(conversationId, toolCallId)` 唯一，同上。
    ensureIndex(db, DECISIONS_COLLECTION, { conversationId: 1, toolCallId: 1 }, {
      unique: true,
      name: "nimbo_decisions_conversation_call",
    }),
    // 队列：**唯一**。除了「按会话取、按 seq 排」（`findOneAndDelete` 走的就是它），它还
    // 承担一件事——**保证 seq 不重号**。应用层「先查最大值再插」在并发下必然有窗口：
    // 两个请求读到同一份快照就算出同一个号，之后按 seq 排序平局，先到先发不再成立。
    // 有了唯一索引，撞号那条插入直接失败，调用方换个号重来（见 `stores.ts` 的 `enqueue`）。
    ensureIndex(db, QUEUE_COLLECTION, { conversationId: 1, seq: 1 }, {
      unique: true,
      name: "nimbo_queue_conversation_seq",
    }),
  ]);
}
