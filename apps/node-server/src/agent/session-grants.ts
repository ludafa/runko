/**
 * 会话级授权（session grant，docs/terms.md §四 / docs/tech/chat-webapp.md §2.2c）：
 * 人在审批卡片上点「会话内都允许」后，对**这一次具体调用**记一条放行——同一会话内
 * **同一用户**的**完全相同**调用（同工具、同入参）后续直接放行、不再弹卡片；换个
 * 命令（指纹不同）仍照常走审批链。
 *
 * 三条纪律：
 *
 * 1. **持久化到会话（DB，非内存耗材）**：落 `conversation_grants` 子表，随会话
 *    存续、跨进程重启存活、会话删除即随 conversation 级联清。这与「单次授权」
 *    （turn-runner 的 pendingReview，本轮内存态、答复即消费）分工不同——会话级是
 *    刻意要跨轮、跨重启记住的。「会话结束即失效」= 会话被删（级联），而不是进程重启。
 * 2. **按 (会话, **用户**, 工具, 入参指纹) 记账**：`user_id` = 做出授权的人（点
 *    按钮的已认证用户）。查时按**本轮发起者**匹配（routes/chat.ts）——单用户下
 *    发起者≡审批人≡唯一用户，行为无差；将来一个 conversation 多用户时天然是
 *    「每人管自己的授权」，A 的授权不放行 B 的操作。粒度按**具体调用**而非工具名，
 *    是为 bash 安全：授权 `rm -rf build` 不等于放行之后任意 bash（`git push -f` 仍拦）。
 * 3. **只影响会话分类器的放行**：授权命中即在 `onApproval`（routes/chat.ts）里
 *    短路成 `allow`、不弹卡片；未命中回落到现有危险命令分类。产品功能不依赖它——
 *    清空只是「又开始问了」，不影响任何账本数据。
 */
import type { JsonValue } from '@nimbo/core';
import { and, eq } from 'drizzle-orm';

import { conversationGrants } from '../db/schema.js';
import type { Db } from './store.js';

/**
 * 稳定序列化：对象键递归排序，保证同一 JSON 值无论键序都得到同一字符串。
 * 用它而不是 `JSON.stringify` 直接算指纹，是因为模型两次发出的同一调用，其
 * 入参对象的键顺序不保证一致。
 */
function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys
    .map(
      (key) => `${JSON.stringify(key)}:${stableStringify(value[key] ?? null)}`,
    )
    .join(',')}}`;
}

/** (toolName + 入参指纹) → 单一记账键（`conversation_grants.grant_key`）。` ` 分隔，工具名里不会出现。 */
function grantKey(toolName: string, input: JsonValue): string {
  return `${toolName} ${stableStringify(input)}`;
}

/** 记一条会话级放行（人点「会话内都允许」时，routes/chat.ts 经 `resolveReview` 调）。`userId` = 审批人。幂等（PK 冲突即忽略）。 */
export function grantSessionApproval(
  db: Db,
  conversationId: string,
  userId: string,
  toolName: string,
  input: JsonValue,
): void {
  db.insert(conversationGrants)
    .values({
      conversationId,
      userId,
      grantKey: grantKey(toolName, input),
      createdAt: new Date(),
    })
    .onConflictDoNothing()
    .run();
}

/** 这次调用是否已被会话级授权（`onApproval` 分类前先查它）。`userId` = 本轮发起者。 */
export function hasSessionGrant(
  db: Db,
  conversationId: string,
  userId: string,
  toolName: string,
  input: JsonValue,
): boolean {
  return (
    db
      .select({ key: conversationGrants.grantKey })
      .from(conversationGrants)
      .where(
        and(
          eq(conversationGrants.conversationId, conversationId),
          eq(conversationGrants.userId, userId),
          eq(conversationGrants.grantKey, grantKey(toolName, input)),
        ),
      )
      .get() !== undefined
  );
}

/** 清空某会话的全部授权（所有用户）。会话删除时 FK 级联已自动清，这是显式入口（如「重置本会话授权」）。 */
export function clearSessionGrants(db: Db, conversationId: string): void {
  db.delete(conversationGrants)
    .where(eq(conversationGrants.conversationId, conversationId))
    .run();
}
