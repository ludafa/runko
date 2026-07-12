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

// Chat agent (docs/08-chat-agent-webapp.md §2.2): one row per chat session,
// bound 1:1 to a Vercel sandbox (`sandboxName`) and a dedicated git branch
// (`branchName`). `nimboStateJson` is `Session.toJSON()` (nimbo's own
// `SessionState`, message history + turn count), updated at the end of every
// turn — the sandbox's filesystem (including the branch's code) is restored
// separately, from the Vercel snapshot (see src/agent/sandbox-manager.ts).
export const chatSessions = sqliteTable('chat_sessions', {
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
  nimboStateJson: text('nimbo_state_json'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

// The drizzle version of examples/shared/transcript-store.ts's `events`
// table: one row per `SessionEvent` (plus the server's own `turn.result`
// sentinel), `payloadJson` holding the event verbatim. `seq` is monotonic
// per session and continues across process restarts (from `MAX(seq)`, see
// src/agent/store.ts's `getMaxEventSeq`), not a global autoincrement.
export const agentEvents = sqliteTable(
  'agent_events',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => chatSessions.id),
    seq: integer('seq').notNull(),
    ts: integer('ts', { mode: 'timestamp' }).notNull(),
    type: text('type').notNull(),
    payloadJson: text('payload_json').notNull(),
  },
  (table) => [primaryKey({ columns: [table.sessionId, table.seq] })],
);
