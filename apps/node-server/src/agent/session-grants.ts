/**
 * 会话级授权（session grant，docs/terms.md §四 / docs/app/chat-webapp/tech.md §2.2c）：
 * 人在审批卡片上点「会话内都允许」后记一条放行——同一会话内**同一用户**的同样
 * 调用后续直接放行、不再弹卡片；没记过的仍照常走审批链。
 *
 * ---- 记账粒度：bash 走分段授权（docs/app/approval-grant-split/tech.md） ----
 *
 * bash 调用按[命令段](../../../../docs/terms.md)记账：一条复合命令拆成 N 段、记
 * N 行；后续调用**每一段都记过**才放行。这样 `cd X && rm -rf y && npm i a` 授权
 * 之后，`cd X && npm i a` 直接放行，只有真正新出现的段才再弹卡片——整串指纹时代
 * 「命令稍变即重新审批」的组合爆炸就消掉了。
 *
 * 段的键是**去引号后的 argv 数组** + cwd + 重定向，不是命令名、也不是段的字符串
 * 原文：按命令名记会让 `rm -rf node_modules` 的授权放行 `rm -rf /`（授权的语义是
 * 「我认可这个具体动作」，不是「我认可这个程序」）；按字符串原文记会让
 * `rm -rf "my dir"` 与 `rm -rf my dir` 撞同一个键（一个目录 vs 两个）。`cwd` 进键
 * （同一条 `rm -rf build` 在 `/` 与在 `/repo` 危险程度不同），`timeout_ms` 不进键
 * （不影响这条命令做什么，进键只会平白增加重复审批）。
 *
 * **拆不动就退回整串**：`splitCommand` 对任何看不透的构造返回 `undefined`
 * （命令替换、heredoc、控制结构……见该模块的拒绝清单），此时按整条调用指纹记/查，
 * 与本功能上线前逐字一致。非 bash 工具同样走整串。两种键形态**并存且都参与查询**，
 * 所以上线前已存在的授权行继续有效，无需迁移。
 *
 * 三条纪律：
 *
 * 1. **持久化到会话（DB，非内存耗材）**：落 `conversation_grants` 子表，随会话
 *    存续、跨进程重启存活、会话删除即随 conversation 级联清。这与「单次授权」
 *    （turn-runner 的 pendingReview，本轮内存态、答复即消费）分工不同——会话级是
 *    刻意要跨轮、跨重启记住的。「会话结束即失效」= 会话被删（级联），而不是进程重启。
 * 2. **按 (会话, **用户**, 记账键) 记账**：`user_id` = 做出授权的人（点按钮的
 *    已认证用户）。查时按**本轮发起者**匹配（routes/chat.ts）——单用户下
 *    发起者≡审批人≡唯一用户，行为无差；将来一个 conversation 多用户时天然是
 *    「每人管自己的授权」，A 的授权不放行 B 的操作。粒度按**具体命令**而非工具名，
 *    是为 bash 安全：授权 `rm -rf build` 不等于放行之后任意 bash（`git push -f` 仍拦）。
 * 3. **只影响会话分类器的放行**：授权命中即在 `onApproval`（routes/chat.ts）里
 *    短路成 `allow`、不弹卡片；未命中回落到现有危险命令分类。产品功能不依赖它——
 *    清空只是「又开始问了」，不影响任何账本数据。
 */
import type { JsonValue } from '@nimbo/core';
import { and, eq, inArray } from 'drizzle-orm';

import { conversationGrants } from '../db/schema.js';
import { splitCommand } from './split-command.js';
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

/** (toolName + 入参指纹) → 整串记账键（`conversation_grants.grant_key`）。` ` 分隔，工具名里不会出现。 */
function grantKey(toolName: string, input: JsonValue): string {
  return `${toolName} ${stableStringify(input)}`;
}

const BASH_TOOL_NAME = 'bash';

/**
 * 分段键的前缀。`#` 不是合法工具名字符（工具名是 kebab-case 标识符），因此分段键
 * 与整串键 `${toolName} ...` 永不撞车——两种形态可以同住一个 `grant_key` 文本列，
 * 不需要加列、也不需要 DB 迁移。
 */
const SEGMENT_KEY_PREFIX = `${BASH_TOOL_NAME}#seg `;

/** bash 入参里与授权相关的两个字段。`timeout_ms` 刻意不取（见本文件头）。 */
interface BashCall {
  command: string;
  cwd: string | null;
}

/** 结构化提取 bash 的 `{ command, cwd? }`——形状检查收窄 `JsonValue`，不用 any/断言（同 approval-policy.ts 的 `extractBashCommand`）。 */
function extractBashCall(
  toolName: string,
  input: JsonValue,
): BashCall | undefined {
  if (toolName !== BASH_TOOL_NAME) return undefined;
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    return undefined;
  const command = input.command;
  if (typeof command !== 'string') return undefined;
  const cwd = input.cwd;
  return { command, cwd: typeof cwd === 'string' ? cwd : null };
}

/**
 * 这次调用的分段键（去重后）。返回 `undefined` = **不能分段**（非 bash 工具、
 * 入参形状不符、或 `splitCommand` 认怂），调用方必须退回整串键——绝不可把它当成
 * 「没有段 = 放行」。
 */
function segmentKeys(toolName: string, input: JsonValue): string[] | undefined {
  const call = extractBashCall(toolName, input);
  if (call === undefined) return undefined;
  const segments = splitCommand(call.command);
  if (segments === undefined) return undefined;

  const keys = segments.map(
    (segment) =>
      SEGMENT_KEY_PREFIX +
      stableStringify({
        argv: segment.argv,
        cwd: call.cwd,
        redirects: segment.redirects,
      }),
  );
  // `a && a` 只记一行；也让 hasSessionGrant 的「命中数 === 键数」比较成立。
  return [...new Set(keys)];
}

/**
 * 记一条会话级放行（人点「会话内都允许」时，routes/chat.ts 经 `resolveReview` 调）。
 * `userId` = 审批人。幂等（PK 冲突即忽略）。
 *
 * 拆得动的 bash 记 N 行分段键，其余（非 bash、形状不符、拆不动）记 1 行整串键。
 */
export function grantSessionApproval(
  db: Db,
  conversationId: string,
  userId: string,
  toolName: string,
  input: JsonValue,
): void {
  const keys = segmentKeys(toolName, input) ?? [grantKey(toolName, input)];
  const createdAt = new Date();
  db.insert(conversationGrants)
    .values(
      keys.map((key) => ({ conversationId, userId, grantKey: key, createdAt })),
    )
    .onConflictDoNothing()
    .run();
}

/**
 * 这次调用是否已被会话级授权（`onApproval` 分类前先查它）。`userId` = 本轮发起者。
 *
 * 两条命中路径，取并集（一次 `IN` 查询同时覆盖，不做 N 次往返）：
 *
 * 1. **整串键命中** —— 非 bash 工具、拆不动的 bash，以及本功能上线**前**落下的
 *    历史授权行（向后兼容，无需迁移回填）。
 * 2. **全部分段键命中** —— 拆得动的 bash：每一段都记过才放行；有任何一段是新的
 *    就返回 false、照常弹卡片。
 */
export function hasSessionGrant(
  db: Db,
  conversationId: string,
  userId: string,
  toolName: string,
  input: JsonValue,
): boolean {
  const wholeKey = grantKey(toolName, input);
  const segKeys = segmentKeys(toolName, input);
  const candidates =
    segKeys === undefined ? [wholeKey] : [wholeKey, ...segKeys];

  const matched = new Set(
    db
      .select({ key: conversationGrants.grantKey })
      .from(conversationGrants)
      .where(
        and(
          eq(conversationGrants.conversationId, conversationId),
          eq(conversationGrants.userId, userId),
          inArray(conversationGrants.grantKey, candidates),
        ),
      )
      .all()
      .map((row) => row.key),
  );

  if (matched.has(wholeKey)) return true;
  if (segKeys === undefined) return false;
  return segKeys.every((key) => matched.has(key));
}

/** 清空某会话的全部授权（所有用户）。会话删除时 FK 级联已自动清，这是显式入口（如「重置本会话授权」）。 */
export function clearSessionGrants(db: Db, conversationId: string): void {
  db.delete(conversationGrants)
    .where(eq(conversationGrants.conversationId, conversationId))
    .run();
}
