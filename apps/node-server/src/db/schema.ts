import {
  index,
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
  /** 沙盒 provider（docs/tech/sandbox-provider.md）：这次会话跑在哪家云沙盒上，建会话时选定、1:1 绑定、运行中不切换。存量行迁移回填 'vercel'。 */
  provider: text('provider', { enum: ['vercel', 'e2b'] })
    .notNull()
    .default('vercel'),
  /** E2B 的[重连令牌](docs/terms.md)：服务端分配的 sandboxId，建盒后落库、下次 `Sandbox.connect` 用它恢复。Vercel 恒 null（它按确定性 `sandbox_name` 恢复，不需要）。 */
  sandboxId: text('sandbox_id'),
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
  /**
   * 待发队列（[排队](../../../../docs/terms.md)，docs/tech/steer-and-queue.md §2）：
   * `QueuedMessage[]` 的 JSON——一轮进行中用户发的消息若走默认的排队路径就落这里，
   * 本轮收尾后由 `@nimbo/agent` 的[自动出队](../../../../docs/terms.md)取队首起下一轮。
   *
   * **刻意不进 `conversation_events` 账本**：账本记的是「已发生的事」（`kind='message'`
   * 行永不删除、`seq` 单调且被回放/断线续传/`finalizeTurnPersistence` 的 GC 阈值三处
   * 依赖），而排队消息是「尚未发生的意图」，可删可清空——两种语义混在一张表里会同时
   * 破坏「永不删除」与 seq 空间。也刻意不另开子表：队列与 conversation 天然 1:1、有序、
   * 量小（框架的 `queue.max`，默认 10）、永远整体读写，没有按条件查询的需求来兑现一张表的代价。
   *
   * 读回一律走 `store.ts` 的 `queuedMessagesSchema.safeParse`（不是类型断言）——这是
   * JSON 列的反序列化边界。
   */
  queuedMessagesJson: text('queued_messages_json').notNull().default('[]'),
  /**
   * [skill 清单](../../../../docs/terms.md)缓存（docs/tech/composer-skill-mention.md
   * §2.1）：`SkillSummary[]` 的 JSON——`{name, description}` 两个字段，供
   * [composer](../../../../docs/terms.md) 里打 `/` 时列菜单。
   *
   * **是缓存，不是事实来源**。事实来源永远是沙盒 `.agents/skills/` 目录；这一列
   * 由「会话创建」与「每轮起轮」两处幂等覆盖写入。之所以缓存而不是让前端现读
   * 沙盒：沙盒会[休眠](../../../../docs/terms.md)，为了列个下拉菜单去唤醒它要让
   * 用户干等几十秒，代价与收益完全不成比例，还会把一个只读操作变成能改变沙盒
   * 生命周期的副作用操作。代价是清单最多滞后一轮。
   *
   * 这一列空了/坏了不影响正确性：`buildSession` 照常自己扫沙盒加载 skill，agent
   * 照常能用，最坏只是菜单空着。读回一律走 `store.ts` 的
   * `availableSkillsSchema.safeParse`（不是类型断言）——JSON 列的反序列化边界，
   * 与上面 `queuedMessagesJson` 同一姿态。
   */
  availableSkillsJson: text('available_skills_json').notNull().default('[]'),
  /**
   * [起轮标记](../../../../docs/terms.md)（`@nimbo/agent` 的[归属仲裁机制](../../../../docs/terms.md)
   * 在这一档的落地）：起轮时写下「这一轮由谁在跑」，收尾时置回 null。
   *
   * **它不是「为多机预留」**，是[进行中草稿](../../../../docs/terms.md)搬进内存的直接
   * 依赖：草稿一不落库，旧的[孤儿轮](../../../../docs/terms.md)判据（「事件行以
   * `kind='chunk'` 收尾」）就永远为假，崩溃残留的会话会静默地停在「正在干活」。
   * 换成直接判据之后——**启动时这一列还非空 = 那一轮没人管了**，补一条「已停止」。
   *
   * 目前只有「谁在跑」，还没有心跳、没有[租期标识](../../../../docs/terms.md)：单进程
   * 部署下这就够了。将来上多进程时在它上面长（加心跳列 + CAS），不用推倒重来。
   */
  turnHolder: text('turn_holder'),
  /** 这一轮是什么时候起的——纯运维可见性（「这个标记卡了多久」），没有代码读它做判断。 */
  turnStartedAt: integer('turn_started_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

// docs/tech/single-ledger.md §5 单-3: the single ledger for a
// conversation's agent activity（2026-07-17 由 `agent_events` 更名——事件属于
// conversation 这个父实体，"agent" 是悬空修饰词），two kinds of row (`kind`)
// sharing one seq space (monotonic per conversation, continues across
// process restarts — from `MAX(seq)`, see src/agent/persistence.ts's
// `maxSeq` — not a global autoincrement):
//
// - `kind = 'message'`: one *finished* `NimboUIMessage` (`@nimbo/core`),
//   `payloadJson` holding the message verbatim, byte-for-byte the same shape
//   `Session.toJSON().messages` would produce — this is what agent-session
//   resume reads back (src/agent/store.ts's `loadResumeState`), and it's
//   also permanent history for replay: never deleted, never rewritten.
// - `kind = 'chunk'`: **不再写入**。[进行中草稿](../../../../docs/terms.md)搬进内存
//   之后（`@nimbo/agent`），这一档只剩迁移前留下的存量行；`agent/persistence.ts` 的
//   `read` 读时把它们过滤掉，`maxSeq` 则仍然数上它们（否则新写的 seq 会跟这些旧行撞
//   主键）。存量行没有清理计划——读时过滤零成本零风险，真删要跑一次一次性脚本。
//   历史背景：它们当初存在是为了让「跑到一半刷新页面」能从回放里重建挂起的审批；
//   现在这件事由直播流重连时补发内存草稿完成。
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
// 只放行**授权者本人**的调用（`hasConversationGrant` 按本轮发起者查），A 的授权不会
// 悄悄放行 B 的操作。多用户的卡片可见性/可点性是未来的渲染层决策，不影响这张表。
// [推送订阅](docs/terms.md)（docs/tech/push-notification.md §2）：一台设备的一个
// 浏览器一行——用户点铃铛开启通知时，浏览器生成一张「投递地址」（endpoint URL +
// 两把加密密钥）交给我们，服务端拿着它才能往这台设备投递。
//
// 三个设计点：
//
// - **`endpoint` 当主键，不另发 id**。它本来就是「一台设备 + 一个站点」的唯一
//   地址，由浏览器保证。拿它当主键，重复上报（页面每次加载都会幂等重报一次，
//   见 docs/tech/push-notification.md §3.1）天然是 upsert，不需要先查再插。
// - **`user_id` 可以被覆盖**。同一台设备换个账号登录，浏览器给的还是同一个
//   endpoint——upsert 时直接把归属改成新的人。这是对的：通知该跟着「这台设备
//   现在是谁在用」走，而不是跟着第一个用它登录过的人。
// - **不存偏好**。这一期没有按事件类型的用户开关（docs/features/push-notification.md
//   附录 A.2）：服务端总闸是环境变量（`CHAT_PUSH_EVENTS`），设备级开关就是
//   「这一行在不在」。将来真要做 per-user 偏好，是另一张表，不是往这里加列。
//
// `last_sent_at`/`last_error` 纯属运维可见性（"这台设备最后一次投递成功/失败是
// 什么时候"），没有任何代码读它们做判断——投递失败的**处置**是就地删行
// （404/410）或原样留着（其余错误），见 src/push/sender.ts。
export const pushSubscriptions = sqliteTable(
  'push_subscriptions',
  {
    /** 浏览器给的投递 URL（FCM/autopush 的一个端点），天然唯一，故直接当主键。 */
    endpoint: text('endpoint').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** 载荷加密用的公钥（浏览器生成，Base64URL）。 */
    p256dh: text('p256dh').notNull(),
    /** 载荷加密用的认证密钥（浏览器生成，Base64URL）。 */
    auth: text('auth').notNull(),
    /** 只为让人认出「这是我哪台设备」，不参与任何判断；浏览器没给就是 null。 */
    userAgent: text('user_agent'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    /** 最后一次投递成功的时刻；null = 还没成功投过。 */
    lastSentAt: integer('last_sent_at', { mode: 'timestamp' }),
    /** 最后一次投递失败的原因；null = 没失败过（每次成功都会清回 null）。 */
    lastError: text('last_error'),
  },
  (table) => [index('push_subscriptions_user_id_idx').on(table.userId)],
);

/**
 * [人工裁决](../../../../docs/terms.md)留底（`@nimbo/agent` 的 `DecisionStore` 在这一档
 * 的落地）：agent 每请求一次人审 / 每问用户一个问题就记一行待定，人答复（或超时）时
 * 补上结局。
 *
 * **是纯审计表**：人的答复走的是框架内存里那条 promise 路由，不是读这张表——落库是
 * 为了留底（谁在什么时候批了什么）与将来的[挂起](../../../../docs/terms.md)恢复（人隔
 * 几小时回来时，裁决要能跨进程读回来）。这张表坏了不影响任何一轮跑完。
 *
 * 与 `conversation_grants` 的分别：那张记的是「以后同样的调用直接放行」这条**规则**
 * （产品概念，chat 层自己的），这张记的是「这一次调用当时是怎么裁的」这个**事实**。
 */
export const conversationDecisions = sqliteTable(
  'conversation_decisions',
  {
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /** core 的 `ApprovalContext.callId`——对应[账本](../../../../docs/terms.md)里那次工具调用。 */
    toolCallId: text('tool_call_id').notNull(),
    kind: text('kind', { enum: ['approval', 'question'] }).notNull(),
    /** 审批才有（提问没有工具名）。 */
    toolName: text('tool_name'),
    /** 这次调用的入参（审批）或问题正文（提问），JSON。 */
    payloadJson: text('payload_json'),
    /** 待定时为 null。 */
    outcome: text('outcome', {
      enum: ['allow', 'deny', 'answered', 'timeout'],
    }),
    /**
     * 这次裁决管多远。框架只**记**、不执行——真正的放行判断走 `conversation_grants`
     * 那张表（记账粒度是 chat 层自己的产品决策，见 `agent/conversation-grants.ts`）。
     * 本表是纯审计表。
     */
    scope: text('scope', { enum: ['once', 'conversation'] }),
    decidedBy: text('decided_by'),
    /** 拒绝理由 / 回答正文。 */
    message: text('message'),
    requestedAt: integer('requested_at', { mode: 'timestamp' }).notNull(),
    decidedAt: integer('decided_at', { mode: 'timestamp' }),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.toolCallId] }),
  ],
);

export const conversationGrants = sqliteTable(
  'conversation_grants',
  {
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    /** `${toolName} ${稳定序列化(input)}` —— 见 src/agent/conversation-grants.ts 的 `grantKey`。 */
    grantKey: text('grant_key').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.conversationId, table.userId, table.grantKey],
    }),
  ],
);
