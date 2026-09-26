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

/**
 * 幂等插入的**兜底那一半**：吞掉重复键，其余错误照抛。
 *
 * 幂等本身靠 `upsert` + `$setOnInsert`（在调用点写），不靠异常——「先查再插」有竞态
 * 窗口，「插了 catch」会把真正的写失败也一起吞掉。
 *
 * 但 `upsert` 在并发下**仍可能抛重复键**：两个请求同时发现不存在、同时插，唯一索引
 * 挡下后一个。这是 MongoDB 明确记录的行为，不是 bug。那一支的结果照样是「已经有了
 * 一行」——契约要的是「不得写出两行」，满足了，所以吞掉。
 *
 * 收在这里（而不是各自 store 一份）是因为 `stores.ts` 与 `tails.ts` 都要用它。
 */
export async function ignoringDuplicateKey<T>(write: () => Promise<T>): Promise<T | undefined> {
  try {
    return await write();
  } catch (error: unknown) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }
    return undefined;
  }
}
