/**
 * 认 MongoDB 驱动抛出来的两类错误。
 *
 * **它们是本包里唯一需要「看错误内部」的地方**，所以收在一个文件里：驱动抛的是
 * `MongoServerError`，但 `instanceof` 在跨 driver 实例（宿主装的那份 vs 我们看到的那份）
 * 时不可靠，判 `code` 才稳。
 *
 * **一个断言都没有**：`typeof x === "object"` + `x !== null` + `"code" in x` 三步之后，
 * TypeScript 已经把它收窄成「有 `code` 这个键的对象」，直接读就行（`in` 的收窄行为从
 * TS 4.9 起就有了）。这正是仓库规范要的写法——用类型守卫，不用 `as`。
 */

/** 重复键。唯一索引挡下并发插入 / upsert 时驱动抛这个。 */
const DUPLICATE_KEY = 11000;

/** 同名索引已存在但选项或键不同时 Mongo 报的两个 code。 */
const INDEX_CONFLICT_CODES = new Set([85, 86]);

/** 取出 `error.code`，拿不到就 `undefined`。 */
function codeOf(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return error.code;
}

export function isDuplicateKeyError(error: unknown): boolean {
  return codeOf(error) === DUPLICATE_KEY;
}

export function isIndexConflict(error: unknown): boolean {
  const code = codeOf(error);
  return typeof code === "number" && INDEX_CONFLICT_CODES.has(code);
}
