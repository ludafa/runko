/**
 * `push_subscriptions` 的读写（docs/app/push-notification/tech.md §2）——与
 * `agent/store.ts` 同一姿态：一组吃注入 `Db` 的纯函数，测试可以指向内存库而不必
 * 碰 `db/instance.ts` 的单例。
 */
import type { InferSelectModel } from 'drizzle-orm';
import { eq } from 'drizzle-orm';

import type { Db } from '../agent/store.js';
import { pushSubscriptions } from '../db/schema.js';

export type PushSubscriptionRow = InferSelectModel<typeof pushSubscriptions>;

export interface UpsertSubscriptionInput {
  endpoint: string;
  userId: string;
  p256dh: string;
  auth: string;
  /** 浏览器 UA，只为让人认出设备；没有就省略。 */
  userAgent?: string;
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
export function upsertSubscription(
  db: Db,
  input: UpsertSubscriptionInput,
): void {
  const now = new Date();
  db.insert(pushSubscriptions)
    .values({
      endpoint: input.endpoint,
      userId: input.userId,
      p256dh: input.p256dh,
      auth: input.auth,
      userAgent: input.userAgent ?? null,
      createdAt: now,
      lastSentAt: null,
      lastError: null,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        userId: input.userId,
        p256dh: input.p256dh,
        auth: input.auth,
        userAgent: input.userAgent ?? null,
        lastError: null,
      },
    })
    .run();
}

export function listSubscriptions(
  db: Db,
  userId: string,
): PushSubscriptionRow[] {
  return db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId))
    .all();
}

/** 删一行。不存在也不是错——调用方（退订接口、410 回收）都不关心它之前在不在。 */
export function deleteSubscription(db: Db, endpoint: string): void {
  db.delete(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, endpoint))
    .run();
}

/** 投递成功：记时刻并清掉上一次的失败原因。 */
export function markSent(db: Db, endpoint: string): void {
  db.update(pushSubscriptions)
    .set({ lastSentAt: new Date(), lastError: null })
    .where(eq(pushSubscriptions.endpoint, endpoint))
    .run();
}

/** 投递失败但**不删行**（非 404/410 的错误，见 `sender.ts`）：只留个痕迹供排查。 */
export function markError(db: Db, endpoint: string, message: string): void {
  db.update(pushSubscriptions)
    .set({ lastError: message })
    .where(eq(pushSubscriptions.endpoint, endpoint))
    .run();
}
