/**
 * 一个能**故意坏掉**的 `Db`——只给测试用。
 *
 * 心跳的自我围栏有两种失败形状要覆盖，两种都必须能在测试里造出来：
 *
 * - **抛错**：库连不上。`fail(n)` 让接下来 n 次写直接 reject。
 * - **挂住不返回**：TCP 黑洞、连接池耗尽、网络分区下的 TCP 停滞。`hang()` 让此后每次写
 *   都返回一个**永不 settle** 的 promise。这一档比抛错更常见，也更难写对——它进不了
 *   `catch`，只是让上一拍永远不结束。
 *
 * **为什么不用「把连接关掉」代替**：实测 `client.close()` 之后 `updateOne` 是**立刻抛**
 * （`MongoNotConnectedError`，0 毫秒），造不出「挂住」那一档，也造不出「偶发失败之后
 * 库又好了」那一档——而那两条恰恰是这段代码最容易写错的地方（`persist-kysely` 那边
 * 两条都出过 P1）。
 *
 * 实现上只换掉**写**那两个方法（`updateOne` / `findOneAndUpdate`），读照走真库：这样测出来
 * 的行为才有代表性。用 `Proxy` 而不是手写一个假 `Collection`——那个接口有上百个方法。
 *
 * ⚠️ 转发时**用 `target` 当 receiver 并把方法 bind 到 `target`**，不能让 `this` 落在代理上：
 * 驱动的 `Collection` 用了 `#private` 字段，穿过代理访问会抛 `TypeError`。
 */
import type { Collection, Db, Document } from "mongodb";

export interface FaultyDb {
  db: Db;
  /** 接下来 `count` 次写直接抛错（模拟连不上）。 */
  fail: (count: number) => void;
  /** 此后每次写都挂住不返回（模拟 TCP 黑洞 / 连接池耗尽）。 */
  hang: () => void;
}

/** 把一个对象的方法原样转发到 `target`（绕开 `#private` 字段的坑）。 */
function forward<T extends object>(target: T, prop: string | symbol): unknown {
  const value = Reflect.get(target, prop, target);
  return typeof value === "function" ? value.bind(target) : value;
}

/** 本包的写路径只有这两个方法，坏掉它们就够了。 */
const WRITE_METHODS = new Set(["updateOne", "findOneAndUpdate", "insertOne"]);

export function faultyDb(real: Db, collectionName: string): FaultyDb {
  let failures = 0;
  let hanging = false;

  const wrapCollection = <T extends Document>(col: Collection<T>): Collection<T> =>
    new Proxy(col, {
      get(target, prop) {
        if (typeof prop === "string" && WRITE_METHODS.has(prop)) {
          return async (...args: unknown[]): Promise<unknown> => {
            if (hanging) {
              // 永不 settle——这正是「挂住」那一档，`catch` 永远等不到。
              return await new Promise<unknown>(() => undefined);
            }
            if (failures > 0) {
              failures -= 1;
              throw new Error("simulated mongo failure");
            }
            const method = forward(target, prop);
            if (typeof method !== "function") {
              throw new TypeError(`${prop} is not a method`);
            }
            return await (method as (...a: unknown[]) => Promise<unknown>)(...args);
          };
        }
        return forward(target, prop);
      },
    });

  return {
    fail: (count: number): void => {
      failures = count;
    },
    hang: (): void => {
      hanging = true;
    },
    db: new Proxy(real, {
      get(target, prop) {
        if (prop === "collection") {
          return <T extends Document>(name: string): Collection<T> => {
            const col = target.collection<T>(name);
            return name === collectionName ? wrapCollection(col) : col;
          };
        }
        return forward(target, prop);
      },
    }),
  };
}
