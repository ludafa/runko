/**
 * **[工具收尾](../../../docs/terms.md)记录的 Kysely 实现**——[交权](../../../docs/terms.md)
 * 那一刻还在跑、留在旧节点上跑完的那次调用，落在独立表 `agent_tool_tails`。
 *
 * `complete` / `requestStop` 都走「条件 UPDATE + 读回确认」，不看 affectedRows——
 * 理由见 `arbitration.ts` 文件头第 ③ 条（MySQL 把「匹配到但值没变」也报成 0 行）。
 */
import type { TailOutcome, ToolTailRecord, ToolTailStore, WriteResult } from "@runko/agent";
import type { JsonValue } from "@runko/core";
import type { Kysely } from "kysely";

import type { FlavorTraits } from "./flavor.js";
import { decodeJson, encodeJson, toNumber } from "./flavor.js";
import { insertOrIgnore } from "./idempotent-insert.js";
import type { RunkoDatabase, ToolTailsTable } from "./schema.js";
import { TAILS_TABLE } from "./schema.js";

const OK: WriteResult = { ok: true };

/** `outcome` 列存的就是调用方传给 `complete` 的那个 `TailOutcome`，这里原样校验回来。 */
function isTailOutcome(value: unknown): value is TailOutcome {
  if (typeof value !== "object" || value === null || !("kind" in value)) {return false;}
  if (value.kind === "output") {return "output" in value;}
  if (value.kind === "error") {return "errorText" in value && typeof value.errorText === "string";}
  return false;
}

function decodeTailOutcome(traits: FlavorTraits, column: unknown): TailOutcome | undefined {
  if (column === null) {return undefined;}
  const decoded = decodeJson(traits, column);
  return isTailOutcome(decoded) ? decoded : undefined;
}

/**
 * `JsonValue` 深比较，与对象键的排列顺序无关——Postgres 的 jsonb / MySQL 的 json
 * 落盘时会重排对象的键，`JSON.stringify` 直接比较会把「同一个对象、键序不同」误判成不相等。
 */
function jsonValueEquals(a: JsonValue, b: JsonValue): boolean {
  if (a === b) {return true;}
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {return false;}
    // 用 `b.at(index)` 取值再判 `undefined`。`JsonValue` 不含 `undefined`，所以它只表示越界。
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

export function createToolTailStore(db: Kysely<RunkoDatabase>, traits: FlavorTraits): ToolTailStore {
  const toRecord = (row: ToolTailsTable): ToolTailRecord => {
    const outcome = decodeTailOutcome(traits, row.outcome);
    return {
      conversationId: row.conversation_id,
      toolCallId: row.tool_call_id,
      toolName: row.tool_name,
      runner: row.runner,
      startedAt: toNumber(row.started_at),
      deadline: toNumber(row.deadline),
      ...(outcome !== undefined ? { outcome } : {}),
      ...(row.settled_at !== null ? { settledAt: toNumber(row.settled_at) } : {}),
      stopRequested: toNumber(row.stop_requested) !== 0,
    };
  };

  return {
    async begin(record): Promise<WriteResult> {
      // 同 `(conversationId, toolCallId)` 重复登记**幂等**——用幂等插入，不覆盖已有的行
      // （已经在跑或已经有结果的那次调用，不该被重新登记的 `begin` 抹掉）。
      await insertOrIgnore(
        traits,
        db.insertInto(TAILS_TABLE).values({
          conversation_id: record.conversationId,
          tool_call_id: record.toolCallId,
          tool_name: record.toolName,
          runner: record.runner,
          started_at: record.startedAt,
          deadline: record.deadline,
          outcome: null,
          settled_at: null,
          stop_requested: 0,
        }),
        ["conversation_id", "tool_call_id"],
      ).execute();
      return OK;
    },

    async complete(conversationId, toolCallId, outcome, settledAt): Promise<boolean> {
      await db
        .updateTable(TAILS_TABLE)
        .set({ outcome: encodeJson(outcome), settled_at: settledAt })
        .where("conversation_id", "=", conversationId)
        .where("tool_call_id", "=", toolCallId)
        .where("outcome", "is", null)
        .execute();

      const row = await db
        .selectFrom(TAILS_TABLE)
        .select(["outcome", "settled_at"])
        .where("conversation_id", "=", conversationId)
        .where("tool_call_id", "=", toolCallId)
        .executeTakeFirst();
      if (row === undefined) {return false;}
      const stored = decodeTailOutcome(traits, row.outcome);
      // 读回来的必须**正是我刚写的那条**——不是「有没有结果」，因为没抢到这次写入时，
      // 那一行本来就已经有一个（别人的）结果，`outcome` 同样非空，不能被误判成成功。
      return stored !== undefined && outcomeEquals(stored, outcome) && row.settled_at !== null && toNumber(row.settled_at) === settledAt;
    },

    async get(conversationId, toolCallId): Promise<ToolTailRecord | undefined> {
      const row = await db
        .selectFrom(TAILS_TABLE)
        .selectAll()
        .where("conversation_id", "=", conversationId)
        .where("tool_call_id", "=", toolCallId)
        .executeTakeFirst();
      return row === undefined ? undefined : toRecord(row);
    },

    async requestStop(conversationId, toolCallId): Promise<boolean> {
      await db
        .updateTable(TAILS_TABLE)
        .set({ stop_requested: 1 })
        .where("conversation_id", "=", conversationId)
        .where("tool_call_id", "=", toolCallId)
        .where("outcome", "is", null)
        .execute();

      const row = await db
        .selectFrom(TAILS_TABLE)
        .select(["outcome", "stop_requested"])
        .where("conversation_id", "=", conversationId)
        .where("tool_call_id", "=", toolCallId)
        .executeTakeFirst();
      return row !== undefined && row.outcome === null && toNumber(row.stop_requested) !== 0;
    },
  };
}
