import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

// ---------------------------------------------------------------------------
// better-auth tables
// ---------------------------------------------------------------------------

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull(),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id),
  token: text('token').notNull().unique(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', {
    mode: 'timestamp',
  }),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', {
    mode: 'timestamp',
  }),
  scope: text('scope'),
  idToken: text('id_token'),
  password: text('password'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
});

// ---------------------------------------------------------------------------
// Application tables — add yours here.
// ---------------------------------------------------------------------------

// Chat agent (docs/tech/chat-webapp.md §2.2, docs/tech/single-ledger.md §5 单-3 "UIMessage 单账本"): one row per
// conversation（对话线程——2026-07-17 由 `chat_sessions` 更名，解开系统里
// "session" 的三重超载：better-auth 的登录态 `session` 表、这里的对话、
// SDK 的 agent 会话），bound 1:1 to a Vercel sandbox (`sandboxName`) and a
// dedicated git branch (`branchName`). SDK 侧 `SessionState`（`@nimbo/core`）
// 不整块存 JSON：its `messages` (`NimboUIMessage[]`) live in
// `conversation_events` (the `kind = 'message'` rows, one row per message,
// seq order = ledger order), and its three scalars (`id`/`createdAt`/`turn`)
// live in the three `agent_session_*` columns below — a small "agent session
// header", not the whole account（表/列名刻意不带产品名，产品更名不迁库）。
// All three are `null` until this conversation's very first turn actually
// completes (the SDK hasn't generated an agent session id yet — see
// src/agent/store.ts's `loadResumeState`); the sandbox's filesystem
// (including the branch's code) is restored separately, from the Vercel
// snapshot (sandbox-manager.ts).
export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id),
  title: text('title').notNull(),
  repo: text('repo').notNull(),
  branchName: text('branch_name').notNull(),
  sandboxName: text('sandbox_name').notNull(),
  status: text('status', { enum: ['active', 'sleeping', 'expired'] })
    .notNull()
    .default('active'),
  lastActiveAt: integer('last_active_at', { mode: 'timestamp' }).notNull(),
  /** `SessionState.id` (the SDK's own agent-session id, distinct from this row's own `id`) as of the last turn that finished. */
  agentSessionId: text('agent_session_id'),
  /** `SessionState.createdAt` — set once, on the first turn that finishes, and never touched again (matches the SDK's own "assigned once at `createSession`-time, carried through every `resume`" semantics). */
  agentSessionCreatedAt: integer('agent_session_created_at', {
    mode: 'timestamp',
  }),
  /** `SessionState.turn` as of the last turn that finished — resumed agent sessions start their next turn at `agentSessionTurn + 1`. */
  agentSessionTurn: integer('agent_session_turn'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

// docs/tech/single-ledger.md §5 单-3: the single ledger for a
// conversation's agent activity（2026-07-17 由 `agent_events` 更名——事件属于
// conversation 这个父实体，"agent" 是悬空修饰词），two kinds of row (`kind`)
// sharing one seq space (monotonic per conversation, continues across
// process restarts — from `MAX(seq)`, see src/agent/store.ts's
// `getMaxEventSeq` — not a global autoincrement):
//
// - `kind = 'message'`: one *finished* `NimboUIMessage` (`@nimbo/core`),
//   `payloadJson` holding the message verbatim, byte-for-byte the same shape
//   `Session.toJSON().messages` would produce — this is what agent-session
//   resume reads back (src/agent/store.ts's `loadResumeState`), and it's
//   also permanent history for replay: never deleted, never rewritten.
// - `kind = 'chunk'`: one *durable* `NimboChunk` (ai's `UIMessageChunk`
//   vocabulary — tool state incl. approval-requested/responded, data parts,
//   step markers, message start/finish/metadata; NOT text-delta/
//   reasoning-delta/transient data parts, which only ever live on the SSE
//   wire, see turn-runner.ts's `isDurableChunk`) belonging to the
//   *in-progress* turn currently being driven. These rows exist so a page
//   refresh mid-turn can still reconstruct pending approvals/questions from
//   a replay; every one of them is deleted the instant its turn finishes
//   gracefully (superseded by that turn's own `kind = 'message'` rows —
//   src/agent/store.ts's `deleteChunkEventsAfter`, called from
//   turn-runner.ts's `driveTurn`). A `kind = 'chunk'` row surviving past its
//   turn only ever means that turn crashed mid-flight without a graceful
//   finish (docs/tech/single-ledger.md §5 单-3 "crash mid-turn（无收尾）：本轮无 message 条目、
//   chunk 条目残留") — accepted residue, not cleaned up later.
//
// 旧 `type` 列（`payloadJson` 判别字段的冗余镜像，纯调试便利、无代码读取）
// 已随更名删除——临时查询用 `json_extract(payload_json, '$.type')`。
export const conversationEvents = sqliteTable(
  'conversation_events',
  {
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id),
    seq: integer('seq').notNull(),
    ts: integer('ts', { mode: 'timestamp' }).notNull(),
    kind: text('kind', { enum: ['message', 'chunk'] }).notNull(),
    payloadJson: text('payload_json').notNull(),
  },
  (table) => [primaryKey({ columns: [table.conversationId, table.seq] })],
);

// 会话级授权（session grant，docs/tech/chat-webapp.md §6 / docs/terms.md §四）持久化：
// 用户在审批卡片点「会话内都允许」后落一行——本会话内**该用户**的同一条具体调用
// （tool + 入参指纹）后续直接放行、不再弹卡片。存 DB 而非内存耗材：随会话持久、
// 跨重启存活、会话删除即随 conversation 级联清。
//
// `user_id` = 做出这次授权的人（点按钮的已认证用户）。当前单用户下它恒等于会话
// owner；记它是为**将来一个 conversation 多用户**时按用户隔离授权留好数据——授权
// 只放行**授权者本人**的调用（`hasSessionGrant` 按本轮发起者查），A 的授权不会
// 悄悄放行 B 的操作。多用户的卡片可见性/可点性是未来的渲染层决策，不影响这张表。
export const conversationGrants = sqliteTable(
  'conversation_grants',
  {
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    /** `${toolName} ${稳定序列化(input)}` —— 见 src/agent/session-grants.ts 的 `grantKey`。 */
    grantKey: text('grant_key').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.conversationId, table.userId, table.grantKey],
    }),
  ],
);
