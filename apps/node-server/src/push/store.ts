/**
 * `push_subscriptions` 的读写（docs/ingress/tech/push-notification.md §2）——与
 * `agent/store.ts` 同一姿态：一组吃注入 `Db` 的纯函数，测试可以指向内存库而不必
 * 碰 `db/instance.ts` 的单例。
 */
import type { Selectable } from 'kysely';

import type { Db } from '../db/instance.js';
import type { PushSubscriptionsTable } from '../db/schema.js';

/** 对外的领域类型：驼峰字段、时间用 `Date`。列名 snake_case、时间是毫秒整数，转换见 `toRow`。 */
export interface PushSubscriptionRow {
  endpoint: string;
  userId: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  createdAt: Date;
  lastSentAt: Date | null;
  lastError: string | null;
}

export interface UpsertSubscriptionInput {
  endpoint: string;
  userId: string;
  p256dh: string;
  auth: string;
  /** 浏览器 UA，只为让人认出设备；没有就省略。 */
  userAgent?: string;
}

/** 一行 `push_subscriptions` → `PushSubscriptionRow`。毫秒 ↔ `Date` 的转换只在这里做一次。 */
function toRow(row: Selectable<PushSubscriptionsTable>): PushSubscriptionRow {
  return {
    endpoint: row.endpoint,
    userId: row.user_id,
    p256dh: row.p256dh,
    auth: row.auth,
    userAgent: row.user_agent,
    createdAt: new Date(row.created_at),
    lastSentAt: row.last_sent_at === null ? null : new Date(row.last_sent_at),
    lastError: row.last_error,
  };
}

/**
 * 按 `endpoint` 幂等落一行。
 *
 * **冲突时连 `user_id` 一起覆盖**：同一台设备换账号登录，浏览器给的还是同一个
 * endpoint，这一行就该改归属（见 `db/schema.ts` 的表注释）。同时把
 * `last_error` 清回 null——用户刚重新授权/重新上报，上一次的失败已经没有意义了。
 *
 * `created_at` 不在冲突分支里更新：它记的是「这台设备第一次开启通知」的时刻，
 * 每次加载页面都重报一次不该把它刷新掉。
 */
export async function upsertSubscription(
  db: Db,
  input: UpsertSubscriptionInput,
): Promise<void> {
  await db
    .insertInto('push_subscriptions')
    .values({
      endpoint: input.endpoint,
      user_id: input.userId,
      p256dh: input.p256dh,
      auth: input.auth,
      user_agent: input.userAgent ?? null,
      created_at: Date.now(),
      last_sent_at: null,
      last_error: null,
    })
    .onConflict((oc) =>
      oc.column('endpoint').doUpdateSet({
        user_id: input.userId,
        p256dh: input.p256dh,
        auth: input.auth,
        user_agent: input.userAgent ?? null,
        last_error: null,
      }),
    )
    .execute();
}

export async function listSubscriptions(
  db: Db,
  userId: string,
): Promise<PushSubscriptionRow[]> {
  const rows = await db
    .selectFrom('push_subscriptions')
    .selectAll()
    .where('user_id', '=', userId)
    .execute();
  return rows.map(toRow);
}

/** 删一行。不存在也不是错——调用方（退订接口、410 回收）都不关心它之前在不在。 */
export async function deleteSubscription(
  db: Db,
  endpoint: string,
): Promise<void> {
  await db
    .deleteFrom('push_subscriptions')
    .where('endpoint', '=', endpoint)
    .execute();
}

/** 投递成功：记时刻并清掉上一次的失败原因。 */
export async function markSent(db: Db, endpoint: string): Promise<void> {
  await db
    .updateTable('push_subscriptions')
    .set({ last_sent_at: Date.now(), last_error: null })
    .where('endpoint', '=', endpoint)
    .execute();
}

/** 投递失败但**不删行**（非 404/410 的错误，见 `sender.ts`）：只留个痕迹供排查。 */
export async function markError(
  db: Db,
  endpoint: string,
  message: string,
): Promise<void> {
  await db
    .updateTable('push_subscriptions')
    .set({ last_error: message })
    .where('endpoint', '=', endpoint)
    .execute();
}
