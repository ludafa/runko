/**
 * **[工具收尾](../../../docs/terms.md)记录的 MongoDB 实现**——[交权](../../../docs/terms.md)
 * 那一刻还在跑、留在旧节点上跑完的那次调用。
 */
import type { TailOutcome, ToolTailRecord, ToolTailStore, WriteResult } from "@runko/agent";
import type { JsonValue } from "@runko/core";
import type { Db } from "mongodb";

import type { ToolTailDoc } from "./collections.js";
import { fromBson, TAILS_COLLECTION, toBson } from "./collections.js";
import { ignoringDuplicateKey } from "./errors.js";

const OK: WriteResult = { ok: true };

/**
 * `JsonValue` 深比较，与对象键的排列顺序无关——MongoDB 的驱动/序列化过程不保证
 * 写入与读回时对象键的顺序一致，`JSON.stringify` 直接比较会把「同一个对象、键序不同」
 * 误判成不相等。
 */
function jsonValueEquals(a: JsonValue, b: JsonValue): boolean {
  if (a === b) {return true;}
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {return false;}
    // `noUncheckedIndexedAccess` 下按下标取值会带 `undefined`——`JsonValue` 本身不含
    // `undefined`，所以它就等价于「越界/键不存在」，不需要另外判断。
    return a.every((item, index) => {
      const other = b.at(index);
      return other !== undefined && jsonValueEquals(item, other);
    });
  }
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const aEntries = Object.entries(a);
    const bKeys = Object.keys(b);
    if (aEntries.length !== bKeys.length) {return false;}
    return aEntries.every(([key, value]) => {
      const other = b[key];
      return other !== undefined && jsonValueEquals(value, other);
    });
  }
  return false;
}

/** 结构相等：用来判断「读回来的那条是不是我刚写的那条」（见 `complete` 的读回确认）。 */
function outcomeEquals(a: TailOutcome, b: TailOutcome): boolean {
  if (a.kind !== b.kind) {return false;}
  if (a.kind === "output" && b.kind === "output") {return jsonValueEquals(a.output, b.output);}
  if (a.kind === "error" && b.kind === "error") {return a.errorText === b.errorText;}
  return false;
}

function toRecord(doc: ToolTailDoc): ToolTailRecord {
  return {
    conversationId: doc.conversationId,
    toolCallId: doc.toolCallId,
    toolName: doc.toolName,
    runner: doc.runner,
    startedAt: doc.startedAt,
    deadline: doc.deadline,
    ...(doc.outcome !== null ? { outcome: fromBson<TailOutcome>(doc.outcome) } : {}),
    ...(doc.settledAt !== null ? { settledAt: doc.settledAt } : {}),
    stopRequested: doc.stopRequested,
  };
}

export function createToolTailStore(db: Db): ToolTailStore {
  const col = db.collection<ToolTailDoc>(TAILS_COLLECTION);

  return {
    async begin(record): Promise<WriteResult> {
      // 同 `(conversationId, toolCallId)` 重复登记**幂等**——`$setOnInsert` 只在真的插入
      // 时生效，不会覆盖已经在跑或已经有结果的那一行。
      await ignoringDuplicateKey(() =>
        col.updateOne(
          { conversationId: record.conversationId, toolCallId: record.toolCallId },
          {
            $setOnInsert: {
              toolName: record.toolName,
              runner: record.runner,
              startedAt: record.startedAt,
              deadline: record.deadline,
              outcome: null,
              settledAt: null,
              stopRequested: false,
            },
          },
          { upsert: true },
        ),
      );
      return OK;
    },

    async complete(conversationId, toolCallId, outcome, settledAt): Promise<boolean> {
      // **只在 outcome 还空着时写得进**——条件写 + 读回确认，不是「有没有结果」而是
      // 「读回来的正是我刚写的那条」：没抢到这次写入时，那一行本来就已经有一个（别人的）
      // 结果，`outcome` 同样非空，不能被误判成成功。
      await col.updateOne(
        { conversationId, toolCallId, outcome: null },
        { $set: { outcome: toBson(outcome), settledAt } },
      );
      const doc = await col.findOne({ conversationId, toolCallId }, { projection: { outcome: 1, settledAt: 1 } });
      if (doc === null || doc.outcome === null) {return false;}
      return outcomeEquals(fromBson<TailOutcome>(doc.outcome), outcome) && doc.settledAt === settledAt;
    },

    async get(conversationId, toolCallId): Promise<ToolTailRecord | undefined> {
      const doc = await col.findOne({ conversationId, toolCallId }, { projection: { _id: 0 } });
      return doc === null ? undefined : toRecord(doc);
    },

    async requestStop(conversationId, toolCallId): Promise<boolean> {
      await col.updateOne({ conversationId, toolCallId, outcome: null }, { $set: { stopRequested: true } });
      const doc = await col.findOne({ conversationId, toolCallId }, { projection: { outcome: 1, stopRequested: 1 } });
      return doc !== null && doc.outcome === null && doc.stopRequested === true;
    },
  };
}
