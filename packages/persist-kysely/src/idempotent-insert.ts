/**
 * **幂等插入**——三个方言唯一需要分支的写法（见 `flavor.ts` 那张表）。
 *
 * 抽成独立模块而不是留在某个 Store 里：`stores.ts` 与 `arbitration.ts` 都要用它，
 * 而「MySQL 走另一条路」这件事只该有一处实现。第一版就是因为 `arbitration.ts` 自己
 * 手写了 `onConflict`，在 MySQL 上直接语法错误。
 */
import type { InsertQueryBuilder } from "kysely";
import { sql } from "kysely";

import type { FlavorTraits } from "./flavor.js";
import type { RunkoDatabase } from "./schema.js";

/**
 * 幂等插入——**这是三个方言唯一需要分支的写法**（见 `flavor.ts` 那张表）。
 *
 * 抽成一个泛型函数而不是在每个 Store 里写一遍 `if`：三处调用点形状一样，重复三遍
 * 只会让「MySQL 走另一条路」这件事散在三个地方。
 */
export function insertOrIgnore<T extends keyof RunkoDatabase, O>(
  traits: FlavorTraits,
  query: InsertQueryBuilder<RunkoDatabase, T, O>,
  conflictColumns: readonly string[],
): InsertQueryBuilder<RunkoDatabase, T, O> {
  if (traits.idempotentInsert === "on-duplicate-key") {
    // **不能用 `INSERT IGNORE`。** 它把所有可恢复错误一起降级成 warning（超长截断、
    // 约束失败整行跳过），调用方却拿到「写成功了」——静默丢数据，而且丢的那一档正好是
    // 三个方言里唯一静默的。`ON DUPLICATE KEY UPDATE <某列>=<某列>` 是一个无操作的
    // 更新，只吞重复键，语义与另两家的 `DO NOTHING` 对齐。详见 `flavor.ts` 的坑 ②。
    const noop = conflictColumns[0];
    if (noop === undefined) {throw new Error("insertOrIgnore requires at least one conflict column");}
    return query.onDuplicateKeyUpdate({ [noop]: sql.ref(noop) } as never);
  }
  return query.onConflict((oc) => oc.columns([...conflictColumns] as never).doNothing());
}
