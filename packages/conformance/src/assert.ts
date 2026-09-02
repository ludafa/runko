/**
 * 本套件自己的断言——**刻意不 import 任何东西**，连 `node:assert` 都不用。
 *
 * 理由是这个包的定位：它要能在**任何**测试环境里跑（vitest / jest / node:test /
 * Workers / 浏览器），而套件本身不该对「用哪个测试框架」有任何意见。断言失败就抛一个
 * 普通 `Error`——所有测试框架都把抛出当失败，这是唯一通用的契约。
 *
 * 消息里带上实际值与期望值：套件的用户是**在实现自己的适配器**的人，报错要能直接指向
 * 「你哪儿没满足契约」，而不是只说一句 assertion failed。
 */

/** 断言失败。带 `expected` / `actual` 让测试框架的 diff 视图能用上。 */
export class ConformanceAssertionError extends Error {
  readonly expected: unknown;
  readonly actual: unknown;

  constructor(message: string, expected: unknown, actual: unknown) {
    super(message);
    this.name = "ConformanceAssertionError";
    this.expected = expected;
    this.actual = actual;
  }
}

function show(value: unknown): string {
  if (typeof value === "string") {return JSON.stringify(value);}
  if (value === undefined) {return "undefined";}
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function fail(what: string, expected: unknown, actual: unknown): never {
  throw new ConformanceAssertionError(`${what}\n  期望: ${show(expected)}\n  实际: ${show(actual)}`, expected, actual);
}

/**
 * 结构化深比较。`undefined` 的键与缺失的键**视为相同**（与 JSON 往返后的形状一致）。
 *
 * **内置对象必须逐个特判。** 只按「自有可枚举键」比的话，`Date` / `Map` / `Set` / `Error`
 * 全都没有自有可枚举键，于是任意两个都会被判成相等——`new Date(0)` 等于 `new Date(9e9)`。
 * 这个包的用户是**在写适配器的人**，一个把时间戳存成 `Date`、把附加信息存成 `Map` 的实现
 * 会因此拿到错误的绿灯，而那正是这套套件唯一不能出的错。
 */
function deepEquals(a: unknown, b: unknown, seen: PairSet = new PairSet()): boolean {
  if (Object.is(a, b)) {return true;}
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {return false;}

  // 循环引用：同一对对象再遇到就当相等（否则无限递归成 RangeError，报错会指向断言库
  // 自己的调用栈，而不是「你哪儿没满足契约」）。
  if (seen.has(a, b)) {return true;}
  seen.add(a, b);

  const exotic = compareExotic(a, b, seen);
  if (exotic !== undefined) {return exotic;}

  if (Array.isArray(a) !== Array.isArray(b)) {return false;}
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {return false;}
    return a.every((item, i) => deepEquals(item, b[i], seen));
  }
  const ao = toRecord(a);
  const bo = toRecord(b);
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const key of keys) {
    if (!deepEquals(ao[key], bo[key], seen)) {return false;}
  }
  return true;
}

/**
 * 内置对象的特判。返回 `undefined` 表示「两边都不是这些类型，按普通对象继续比」。
 *
 * 只要**有一边**是这些类型就必须在这里出结果：`equal(new Date(0), { })` 该判不等，
 * 而不是掉进普通对象那一支（`Date` 没有自有可枚举键，会被判成相等）。
 */
function compareExotic(a: object, b: object, seen: PairSet): boolean | undefined {
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (a instanceof RegExp || b instanceof RegExp) {
    return a instanceof RegExp && b instanceof RegExp && a.source === b.source && a.flags === b.flags;
  }
  if (a instanceof Error || b instanceof Error) {
    return a instanceof Error && b instanceof Error && a.name === b.name && a.message === b.message;
  }
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) {return false;}
    // 键可能是对象，不能只靠 `b.get(key)`——逐个找一个深相等的对应项。
    const rest = [...b];
    return [...a].every(([key, value]) => {
      const at = rest.findIndex(([k, v]) => deepEquals(k, key, seen) && deepEquals(v, value, seen));
      if (at < 0) {return false;}
      rest.splice(at, 1);
      return true;
    });
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) {return false;}
    const rest = [...b];
    return [...a].every((item) => {
      const at = rest.findIndex((candidate) => deepEquals(candidate, item, seen));
      if (at < 0) {return false;}
      rest.splice(at, 1);
      return true;
    });
  }
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b)) {return false;}
    const av = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const bv = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    return av.length === bv.length && av.every((byte, i) => byte === bv[i]);
  }
  return undefined;
}

/**
 * 部分匹配：`actual` 里**至少**要有 `expected` 描述的那些键，多的不管。
 *
 * 与 `deepEquals` 的两处刻意差别，跟 vitest 的 `toMatchObject` 对齐：
 * ① `expected` 里写了一个值为 `undefined` 的键，`actual` 上**必须真的有这个键**
 *    （「我期望这里是 undefined」和「我没提这个键」是两回事）；
 * ② `expected` 是普通对象时 `actual` 也必须是普通对象——不然 `matches([1,2,3], { length: 3 })`
 *    会通过，形状完全没校验到。
 */
function deepMatches(actual: unknown, expected: unknown, seen: PairSet = new PairSet()): boolean {
  if (typeof expected !== "object" || expected === null) {return deepEquals(actual, expected, seen);}
  if (typeof actual !== "object" || actual === null) {return false;}
  if (seen.has(actual, expected)) {return true;}
  seen.add(actual, expected);
  // 内置对象没有「部分」可言，整体比。
  const exotic = compareExotic(actual, expected, seen);
  if (exotic !== undefined) {return exotic;}
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {return false;}
    return expected.every((item, i) => deepMatches(actual[i], item, seen));
  }
  if (Array.isArray(actual)) {return false;}
  const ao = toRecord(actual);
  const eo = toRecord(expected);
  return Object.keys(eo).every((key) => key in ao && deepMatches(ao[key], eo[key], seen));
}

/** 记「这两个对象已经在比了」，用来断掉循环引用。 */
class PairSet {
  readonly #pairs = new WeakMap<object, WeakSet<object>>();

  has(a: object, b: object): boolean {
    return this.#pairs.get(a)?.has(b) ?? false;
  }

  add(a: object, b: object): void {
    const set = this.#pairs.get(a) ?? new WeakSet<object>();
    set.add(b);
    this.#pairs.set(a, set);
  }
}

/** 把一个对象当成字符串键的字典读——比对键值时唯一需要的视角。 */
function toRecord(value: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = item;
  }
  return out;
}

/** 严格相等（`Object.is`）。 */
export function same(actual: unknown, expected: unknown, hint = "值不相等"): void {
  if (!Object.is(actual, expected)) {fail(hint, expected, actual);}
}

export function notSame(actual: unknown, unexpected: unknown, hint = "值不该相等"): void {
  if (Object.is(actual, unexpected)) {fail(hint, `不等于 ${show(unexpected)}`, actual);}
}

/** 深相等。 */
export function equal(actual: unknown, expected: unknown, hint = "结构不相等"): void {
  if (!deepEquals(actual, expected)) {fail(hint, expected, actual);}
}

/** 部分匹配——只看 `expected` 列出的那些键。 */
export function matches(actual: unknown, expected: object, hint = "结构不匹配"): void {
  if (!deepMatches(actual, expected)) {fail(hint, expected, actual);}
}

export function length(actual: { length: number } | undefined, expected: number, hint = "长度不对"): void {
  if (actual === undefined) {fail(hint, `长度 ${String(expected)}`, undefined);}
  if (actual.length !== expected) {fail(hint, `长度 ${String(expected)}`, `长度 ${String(actual.length)}`);}
}

export function contains(actual: readonly unknown[], item: unknown, hint = "没找到这一项"): void {
  if (!actual.some((candidate) => deepEquals(candidate, item))) {fail(hint, `包含 ${show(item)}`, actual);}
}

export function notContains(actual: readonly unknown[], item: unknown, hint = "不该包含这一项"): void {
  if (actual.some((candidate) => deepEquals(candidate, item))) {fail(hint, `不包含 ${show(item)}`, actual);}
}

export function defined<T>(actual: T | undefined | null, hint = "不该为空"): asserts actual is T {
  if (actual === undefined || actual === null) {fail(hint, "有值", actual);}
}

export function isUndefined(actual: unknown, hint = "该是 undefined"): void {
  if (actual !== undefined) {fail(hint, undefined, actual);}
}

export function atMost(actual: number, limit: number, hint = "超过上限"): void {
  if (!(actual <= limit)) {fail(hint, `≤ ${String(limit)}`, actual);}
}

export function greaterThan(actual: number, floor: number, hint = "没有大于下限"): void {
  if (!(actual > floor)) {fail(hint, `> ${String(floor)}`, actual);}
}

/** 一个值是不是 thenable——用来拦住「把 async 函数传给同步断言」这种误用。 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (typeof value !== "object" || value === null || !("then" in value)) {return false;}
  return typeof value.then === "function";
}

/**
 * 断言 `fn` **同步**抛错；给了 `pattern` 还要匹配错误消息。
 *
 * 传进来的若是 async 函数，这里当场判失败——否则它「没同步抛」会被判成不抛，
 * 同时留下一个未处理的 rejection，报错指向的地方跟真正的问题完全无关。异步的用 `rejects`。
 */
export function throws(fn: () => unknown, pattern?: RegExp, hint = "该抛错却没抛"): void {
  let thrown: unknown;
  let did = false;
  let returned: unknown;
  try {
    returned = fn();
  } catch (error) {
    did = true;
    thrown = error;
  }
  if (isThenable(returned)) {
    // 别让这个 promise 变成未处理的 rejection，那会盖住真正的报错。
    void Promise.resolve(returned).catch(() => undefined);
    fail("`throws` 只接同步函数，异步的请用 `rejects`", "一个同步函数", "一个返回 Promise 的函数");
  }
  if (!did) {fail(hint, "抛出一个错误", "没有抛出");}
  if (pattern !== undefined) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    if (!pattern.test(message)) {fail("错误消息不匹配", String(pattern), message);}
  }
}

/**
 * 断言 `fn` 返回的 promise 被 reject；给了 `pattern` 还要匹配错误消息。
 *
 * 契约里大量「不抛错，返回一个结果」的承诺需要能被直接钉住——`rejects` 是它的反面，
 * 用来验「这个 API 在某某情况下必须拒绝」。
 */
export async function rejects(
  fn: () => PromiseLike<unknown>,
  pattern?: RegExp,
  hint = "该被拒绝却成功了",
): Promise<void> {
  let thrown: unknown;
  let did = false;
  try {
    await fn();
  } catch (error) {
    did = true;
    thrown = error;
  }
  if (!did) {fail(hint, "一个被拒绝的 Promise", "成功返回了");}
  if (pattern !== undefined) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    if (!pattern.test(message)) {fail("错误消息不匹配", String(pattern), message);}
  }
}

/** 断言 `fn` 返回的 promise 不被 reject。 */
export async function resolves(fn: () => PromiseLike<unknown>, hint = "不该被拒绝"): Promise<void> {
  try {
    await fn();
  } catch (error) {
    fail(hint, "正常返回", error instanceof Error ? error.message : String(error));
  }
}

export function doesNotThrow(fn: () => unknown, hint = "不该抛错"): void {
  try {
    fn();
  } catch (error) {
    fail(hint, "不抛错", error instanceof Error ? error.message : String(error));
  }
}
