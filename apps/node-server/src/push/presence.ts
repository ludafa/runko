/**
 * [在场](../../../../docs/terms.md)（docs/ingress/tech/push-notification.md §5.2）——
 * 「此刻这个用户正盯着这条会话」。[前台抑制](../../../../docs/terms.md)靠它：在场就
 * 不推送，因为审批卡片已经在人眼前了。
 *
 * **为什么必须由页面上报，服务端猜不出来**：服务端能看到的只有「这条会话有没有
 * 活的 SSE 连接」，而一个**被切到后台的标签页照样开着 SSE 连接**——那恰恰是最需要
 * 通知的情形。页面可见性与窗口聚焦只有页面自己知道。
 *
 * **为什么进库而不是留在内存**：多副本时，心跳打到哪个副本是负载均衡说了算，而读它的
 * 是**正在跑这一轮的那个副本**——两者常常不是同一个。留在内存里就等于「该抑制的没抑制」，
 * 用户会收到本来不该收到的通知。这份状态寿命只有几十秒、写多读少，进库的代价可以忽略。
 *
 * **不转发给持有者**：在场是在轮与轮之间上报的，那时候常常根本没有持有者。
 */
import type { Db } from '../db/instance.js';

/** 心跳周期 20 秒的两倍多一点——容得下一次丢包，又不至于人走开后还「在场」太久。 */
const PRESENCE_TTL_MS = 45_000;

/** 页面上报「我正看着这条会话」。每次续 45 秒，不累加。 */
export async function markPresent(
  db: Db,
  userId: string,
  conversationId: string,
): Promise<void> {
  const expiresAt = Date.now() + PRESENCE_TTL_MS;
  await db
    .insertInto('chat_presence')
    .values({
      user_id: userId,
      conversation_id: conversationId,
      expires_at: expiresAt,
    })
    .onConflict((oc) =>
      oc
        .columns(['user_id', 'conversation_id'])
        .doUpdateSet({ expires_at: expiresAt }),
    )
    .execute();
  // 顺手清掉过期的行。写入很稀（每人每 20 秒一次），多这一句换来「这张表不会长胖」。
  await db
    .deleteFrom('chat_presence')
    .where('expires_at', '<=', Date.now())
    .execute();
}

/** 页面上报「我不看了」（切标签页、失焦、卸载）。立即生效，不等过期。 */
export async function clearPresent(
  db: Db,
  userId: string,
  conversationId: string,
): Promise<void> {
  await db
    .deleteFrom('chat_presence')
    .where('user_id', '=', userId)
    .where('conversation_id', '=', conversationId)
    .execute();
}

/** 过期的行读到了也当作不在场——清理交给下一次写入，读这条路上不删。 */
export async function isPresent(
  db: Db,
  userId: string,
  conversationId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('chat_presence')
    .select('expires_at')
    .where('user_id', '=', userId)
    .where('conversation_id', '=', conversationId)
    .executeTakeFirst();
  return row !== undefined && Number(row.expires_at) > Date.now();
}
