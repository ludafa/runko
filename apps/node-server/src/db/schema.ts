/**
 * 这个应用自己的表——**Kysely 的类型声明，不是建表语句**（建表在 `migrations.ts`）。
 *
 * ## 库里有三拨表，各有各的主人
 *
 * | 谁的 | 表 | 谁建 |
 * |---|---|---|
 * | better-auth 的 | `user` `session` `account` `verification` `rateLimit` | better-auth 自己的迁移接口 |
 * | 本应用的 | `conversations` `push_subscriptions` `conversation_grants` | `migrations.ts` |
 * | 框架的 | `agent_ledger` `agent_decisions` `agent_queue` `agent_leases` | `@runko/persist-kysely` 的 `migrate()` |
 *
 * 三拨共用**同一个 Kysely 实例**：`ChatDatabase` 继承 `RunkoDatabase`（框架那四张），
 * 所以同一个实例既能查自己的表，也能原样交给 `kyselyPersistence` 与 `leaseArbitration`。
 * 这正是官方包写在 README 里的用法——宿主本来就有自己的库，框架的表跟着进去就行。
 *
 * ## 时间一律存毫秒整数
 *
 * 跟框架那四张表对齐（`RunkoDatabase` 的 `ts`/`created_at` 都是毫秒）。三种库都能原样
 * 存下：SQLite 是 `INTEGER`，Postgres 是 `bigint`，毫秒时间戳离 2^53 还很远。
 *
 * 设计见 docs/ingress/tech/unified-demo.md §2.2。
 */
import type { RunkoDatabase } from '@runko/persist-kysely';

/**
 * better-auth 的用户表——**它建的，不是我们建的**，这里只声明本应用会碰到的那几列：
 * 外键指向它，测试夹具也要往里插一行。
 *
 * 列名是 better-auth 的缺省（驼峰）。`emailVerified` 在 SQLite 上是 0/1，日期是 ISO
 * 字符串——它的 Kysely 适配器在不支持日期类型的库上就这么存。
 */
export interface UserTable {
  id: string;
  name: string;
  email: string;
  emailVerified: number;
  image: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 沙盒 provider（docs/host/contract/tech/sandbox-provider.md）：这次会话跑在哪一档沙盒上，建会话时选定、1:1 绑定、运行中不切换。 */
export type ConversationProvider = 'vercel' | 'e2b';

export type ConversationStatus = 'active' | 'sleeping' | 'expired';

/**
 * 一个会话一行（对话线程），绑定一个沙盒与一条工作分支。
 *
 * **[账本](../../../../docs/terms.md)、[裁决表](../../../../docs/terms.md)、
 * [待发队列](../../../../docs/terms.md)、归属都不在这张表上**——它们是框架那四张表，
 * 由 `@runko/persist-kysely` 管。这里只剩本应用自己的产品数据。
 */
export interface ConversationsTable {
  id: string;
  user_id: string;
  title: string;
  repo: string;
  branch_name: string;
  sandbox_name: string;
  provider: ConversationProvider;
  /** E2B 的[重连令牌](../../../../docs/terms.md)：建盒后服务端分配的 sandboxId，落库才能跨进程恢复。Vercel 按确定性沙盒名恢复，恒为空。 */
  sandbox_id: string | null;
  status: ConversationStatus;
  last_active_at: number;
  /**
   * [skill 清单](../../../../docs/terms.md)缓存（`{name, description}[]` 的 JSON）。
   *
   * **是缓存，不是事实来源**：事实来源是沙盒里的 `.agents/skills/` 目录。之所以缓存，
   * 是因为沙盒会[休眠](../../../../docs/terms.md)，为了列个下拉菜单去唤醒它，代价与
   * 收益完全不成比例。代价是清单最多滞后一轮。坏了也不影响正确性，最坏是菜单空着。
   */
  available_skills_json: string;
  created_at: number;
}

/**
 * [推送订阅](../../../../docs/terms.md)：一台设备的一个浏览器一行。
 *
 * `endpoint` 直接当主键——它本来就是「一台设备 + 一个站点」的唯一地址，由浏览器保证，
 * 于是页面每次加载的幂等重报天然是一次 upsert。同一台设备换个账号登录时 `user_id`
 * 会被覆盖：通知该跟着「这台设备现在是谁在用」走。
 *
 * `last_sent_at` / `last_error` 纯属运维可见性，没有代码读它们做判断。
 */
export interface PushSubscriptionsTable {
  endpoint: string;
  user_id: string;
  /** 载荷加密用的公钥（浏览器生成，Base64URL）。 */
  p256dh: string;
  /** 载荷加密用的认证密钥（浏览器生成，Base64URL）。 */
  auth: string;
  /** 只为让人认出「这是我哪台设备」，不参与判断。 */
  user_agent: string | null;
  created_at: number;
  last_sent_at: number | null;
  last_error: string | null;
}

/**
 * 会话级授权：用户在审批卡片上点过「本会话都允许」之后落一行，同一条调用后续直接放行。
 *
 * 与[裁决表](../../../../docs/terms.md)的分别：那张记的是「这一次是怎么裁的」这个事实
 * （框架的审计表），这张记的是「以后同样的调用直接放行」这条规则（本应用的产品决策）。
 *
 * `user_id` 是点按钮的那个人：授权只放行**授权者本人**的调用，将来一个会话多人时
 * A 的授权不会悄悄放行 B 的操作。
 */
export interface ConversationGrantsTable {
  conversation_id: string;
  user_id: string;
  /** `${工具名} ${稳定序列化的入参}`，见 `agent/conversation-grants.ts` 的 `grantKey`。 */
  grant_key: string;
  created_at: number;
}

/** 本应用与 better-auth 的表；框架那四张由 `RunkoDatabase` 带进来。 */
export interface ChatDatabase extends RunkoDatabase {
  user: UserTable;
  conversations: ConversationsTable;
  push_subscriptions: PushSubscriptionsTable;
  conversation_grants: ConversationGrantsTable;
}
