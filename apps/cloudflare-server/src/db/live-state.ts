/**
 * 会话列表要的那三样实时状态（排队消息、有没有轮在跑、几处在等你）的 D1 副本。
 *
 * 权威答案在每个会话自己的会话对象里，但列表要一次给全部会话——挨个叫醒会话对象太贵，
 * 所以会话对象在状态变化时把它们回写到这张表（`conversation_live`），列表只读这张表。
 * 详情页只看一个会话，直接问会话对象。
 */
import type { ConversationLiveState } from '@runko-chat/shared/routes/chat';
import type { QueuedMessage } from '@runko-chat/shared/schemas/chat';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Migration } from 'kysely/migration';

export interface ConversationLiveTable {
  conversation_id: string;
  queued_json: string;
  turn_in_progress: number;
  pending_decisions: number;
  updated_at: number;
}

export interface LiveTables {
  conversation_live: ConversationLiveTable;
}

const CONVERSATION_LIVE_DDL = `CREATE TABLE "conversation_live" (
  "conversation_id" varchar(255) PRIMARY KEY NOT NULL REFERENCES "conversations" ("id") ON DELETE CASCADE,
  "queued_json" text NOT NULL,
  "turn_in_progress" integer NOT NULL,
  "pending_decisions" integer NOT NULL,
  "updated_at" integer NOT NULL
)`;

/**
 * Cloudflare 版独有的表的 Kysely 迁移。D1 上不跑迁移器：`scripts/generate-d1-migrations.ts` 把它们
 * 与共用层的迁移一起跑、导出成 SQL 文件。改表就往这里加一段（名字以 `cf_` 开头、编号往后排）
 * 再重新导出；已有的几段别改。
 */
export const CLOUDFLARE_MIGRATIONS: Record<string, Migration> = {
  cf_001_conversation_live: {
    up: async (db) => {
      await sql.raw(CONVERSATION_LIVE_DDL).execute(db);
    },
  },
};

function parseQueue(json: string): QueuedMessage[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? (value as QueuedMessage[]) : [];
  } catch {
    return [];
  }
}

/** D1 一条查询最多绑 100 个参数，`IN` 列表按这个数分批。 */
const D1_MAX_BOUND_PARAMS = 100;

export async function readLiveStates<DB>(
  host: Kysely<DB>,
  conversationIds: readonly string[],
): Promise<Map<string, ConversationLiveState>> {
  const out = new Map<string, ConversationLiveState>();
  if (conversationIds.length === 0) {
    return out;
  }
  // `Kysely<DB>` 在 DB 上不变，这里只查这一张表，收窄是安全的。
  const db = host as unknown as Kysely<LiveTables>;
  for (
    let start = 0;
    start < conversationIds.length;
    start += D1_MAX_BOUND_PARAMS
  ) {
    const batch = conversationIds.slice(start, start + D1_MAX_BOUND_PARAMS);
    const rows = await db
      .selectFrom('conversation_live')
      .selectAll()
      .where('conversation_id', 'in', batch)
      .execute();
    for (const row of rows) {
      out.set(row.conversation_id, {
        queuedMessages: parseQueue(row.queued_json),
        turnInProgress: row.turn_in_progress === 1,
        pendingDecisions: row.pending_decisions,
      });
    }
  }
  return out;
}

export async function writeLiveState<DB>(
  host: Kysely<DB>,
  conversationId: string,
  live: ConversationLiveState,
): Promise<void> {
  const db = host as unknown as Kysely<LiveTables>;
  const row = {
    queued_json: JSON.stringify(live.queuedMessages),
    turn_in_progress: live.turnInProgress ? 1 : 0,
    pending_decisions: live.pendingDecisions,
    updated_at: Date.now(),
  };
  await db
    .insertInto('conversation_live')
    .values({ conversation_id: conversationId, ...row })
    .onConflict((oc) => oc.column('conversation_id').doUpdateSet(row))
    .execute();
}
