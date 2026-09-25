/**
 * 直接查框架那几张表的地方——**只有这一处**，而且只做一件事：会话列表要显示「有几处在
 * 等你答」，一次分组查询拿全。
 *
 * 为什么不走接口：接口是按会话问的（`decisions.listPending(id)`），列表页有多少个会话就
 * 要问多少次。这一句 SQL 顶掉那一串往返。
 *
 * 为什么只有这一处这么干：表结构是 `@runko/persist-kysely` 的公开契约（它的 `schema.sql`），
 * 但**绕开接口就绕开了它的语义**（比如列里 `null` 与「键不存在」的翻译）。数个数不涉及
 * 这些翻译，所以是安全的；其余一律走接口。
 */
import type { Db } from '../db/instance.js';

/**
 * 一条正在跑的[租约](../../../../docs/terms.md)：会话 + 谁持有 + 持有者多久前续过约。
 * [集群控制台](../../../../docs/terms.md)靠它把会话挂到节点下面（`routes/console.ts`）。
 */
export interface ActiveLeaseRow {
  conversationId: string;
  title: string;
  ownerEmail: string;
  /** 持有者的可达地址，与租约表的 `holder` 原样一致。 */
  holder: string;
  heartbeatAt: number;
}

/**
 * 全部「此刻正在跑」的租约（`lease_token` 非空），带上会话标题与持有人邮箱。
 *
 * **这是本应用第二处直接读框架表**（第一处是 `countPendingDecisions`）：接口是按会话
 * 问的，集群控制台要一次性列出全部会话的持有情况，按会话轮询就是 N 次往返；这里
 * 只原样读 `holder`/`heartbeat_at` 两列，不涉及接口层的语义翻译，所以是安全的
 * （docs/host/node/tech/cluster-console.md §2）。
 */
export async function listActiveLeases(db: Db): Promise<ActiveLeaseRow[]> {
  const rows = await db
    .selectFrom('agent_leases')
    .innerJoin(
      'conversations',
      'conversations.id',
      'agent_leases.conversation_id',
    )
    .innerJoin('user', 'user.id', 'conversations.user_id')
    .select([
      'agent_leases.conversation_id as conversationId',
      'agent_leases.holder as holder',
      'agent_leases.heartbeat_at as heartbeatAt',
      'conversations.title as title',
      'user.email as ownerEmail',
    ])
    .where('agent_leases.lease_token', 'is not', null)
    .execute();

  const leases: ActiveLeaseRow[] = [];
  for (const row of rows) {
    // `holder` 理论上不该为空：租约表的不变量是「`lease_token` 非空则 `holder` 也非空」。
    // 这里只是防御性地跳过，不让一条不该出现的行把整个查询炸掉。
    if (row.holder === null) {
      continue;
    }
    leases.push({ ...row, holder: row.holder });
  }
  return leases;
}

/**
 * 每个会话还有几张卡片在等人答（审批或提问）。
 *
 * [内存窗口](../../../../docs/terms.md)里等着的与已[挂起](../../../../docs/terms.md)的都算——
 * 对用户来说都是「这里有事要你拍板」。崩溃残留的孤儿行会被启动扫描结清，不会一直算在里面。
 */
export async function countPendingDecisions(
  db: Db,
  conversationIds: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (conversationIds.length === 0) {
    return counts;
  }
  const rows = await db
    .selectFrom('agent_decisions')
    .select((eb) => ['conversation_id', eb.fn.countAll<number>().as('pending')])
    .where('conversation_id', 'in', [...conversationIds])
    .where('decided_at', 'is', null)
    .groupBy('conversation_id')
    .execute();
  for (const row of rows) {
    counts.set(row.conversation_id, Number(row.pending));
  }
  return counts;
}

/**
 * [待发队列](../../../../docs/terms.md)里还剩几条。
 *
 * 推送那边用它做「队列抑制」：队列非空说明下一轮马上就开始，这不是「活干完了」，
 * 不该叫醒用户。那边够不着框架的运行时（`push/` 不认识 `@runko/agent`），所以这里
 * 直接数一下——只数个数，不碰列里的 JSON。
 */
export async function countQueued(
  db: Db,
  conversationId: string,
): Promise<number> {
  const row = await db
    .selectFrom('agent_queue')
    .select((eb) => eb.fn.countAll<number>().as('queued'))
    .where('conversation_id', '=', conversationId)
    .executeTakeFirst();
  return row === undefined ? 0 : Number(row.queued);
}
