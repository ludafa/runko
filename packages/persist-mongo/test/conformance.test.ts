/**
 * 跟其余三个持久化包**跑同一套用例**（`@runko/conformance`）——这正是重点：
 * 一个非关系型实现能不能满足同一份契约，是这个包最值得回答的问题。
 *
 * **只能对真库跑。** Mongo 没有 pglite 那样的进程内替身（`mongodb-memory-server`
 * 是下载一个真 mongod 二进制来跑，不是进程内），所以没给 `RUNKO_TEST_MONGO_URL`
 * 时整档跳过并说明原因——不是静默跳过。
 *
 * ```sh
 * RUNKO_TEST_MONGO_URL=mongodb://127.0.0.1:27018 pnpm --filter @runko/persist-mongo test
 * ```
 */
import type { ConformanceCase } from "@runko/conformance";
import { persistenceCases } from "@runko/conformance";
import { MongoClient } from "mongodb";
import { describe, expect, it } from "vitest";

import { migrate, mongoPersistence } from "../src/index.js";

/**
 * 把一致性用例接进 vitest。**套件本身不依赖任何测试框架**（它只导出 `{ name, run }`），
 * 这十几行就是「接上去」的全部成本——换 jest / node:test 也是同样的形状。
 */
function runCases<S extends { cleanup?: () => Promise<void> | void }>(
  title: string,
  cases: readonly ConformanceCase<S>[],
  makeSetup: () => Promise<S> | S,
): void {
  describe(title, () => {
    for (const testCase of cases) {
      it(testCase.name, async () => {
        const setup = await makeSetup();
        try {
          await testCase.run(setup);
        } finally {
          await setup.cleanup?.();
        }
      });
    }
  });
}

const MONGO_URL = process.env["RUNKO_TEST_MONGO_URL"];

if (MONGO_URL === undefined) {
  describe.skip("persist-mongo", () => {
    it("没给 RUNKO_TEST_MONGO_URL，跳过 —— Mongo 没有进程内替身，只能对真库跑", () => undefined);
  });
} else {
  const url = MONGO_URL;

  /**
   * 每个用例一个**独立的 database**。
   *
   * 不是「跑前清集合」——Mongo 里 database 是很轻的（隐式创建、`dropDatabase` 一句就没），
   * 一个用例一个 db 比清集合更干净：索引状态、集合是否存在这些也一并隔离掉了。
   * 顺带证明了「换个 database 就是换一套隔离」这条建议（我们不做集合名前缀，理由见 README）。
   */
  let counter = 0;
  runCases("persist-mongo", persistenceCases, async () => {
    const client = new MongoClient(url);
    await client.connect();
    counter += 1;
    const db = client.db(`runko_conformance_${String(counter)}_${crypto.randomUUID().slice(0, 8)}`);
    await migrate(db);
    return {
      persistence: mongoPersistence(db),
      cleanup: async () => {
        await db.dropDatabase();
        await client.close();
      },
    };
  });

  // -------------------------------------------------------------------------
  // 套件覆盖不到的：Mongo 特有的那几处
  // -------------------------------------------------------------------------

  describe("persist-mongo · Mongo 特有的几处", () => {
    const withDb = async (
      body: (db: import("mongodb").Db) => Promise<void>,
    ): Promise<void> => {
      const client = new MongoClient(url);
      await client.connect();
      const db = client.db(`runko_extra_${crypto.randomUUID().slice(0, 8)}`);
      try {
        await migrate(db);
        await body(db);
      } finally {
        await db.dropDatabase();
        await client.close();
      }
    };

    it("migrate 幂等——建索引跑两次不炸", async () => {
      await withDb(async (db) => {
        await migrate(db);
        await migrate(db);
        expect(await mongoPersistence(db).ledger.maxSeq("c1")).toBe(0);
      });
    });

    it("并发 append 同一个 (conversationId, seq) 只写出一行", async () => {
      // SQL 那几家靠 `INSERT OR IGNORE` / `ON CONFLICT`；这边靠唯一索引 + upsert，
      // 而 upsert 在并发下**仍可能抛重复键**（MongoDB 明确记录的行为）。
      // 这条用例就是验「那一支被正确吞掉了」。
      await withDb(async (db) => {
        const { ledger } = mongoPersistence(db);
        const entry = {
          conversationId: "race",
          seq: 1,
          message: { id: "m1", role: "assistant" as const, parts: [] },
          ts: 1,
        };
        const results = await Promise.all(Array.from({ length: 8 }, () => ledger.append(entry)));
        expect(results.every((r) => r.ok)).toBe(true);
        expect(await ledger.read("race")).toHaveLength(1);
      });
    });

    it("工具入参里带 `.` 和 `$` 的键不会炸（MongoDB 5.0+ 才放行）", async () => {
      // 工具入参是**任意 JSON**，键里什么都可能有。5.0 之前的 MongoDB 不接受这种字段名，
      // 这条用例把「要求 5.0+」这件事钉在代码里。
      await withDb(async (db) => {
        const { decisions } = mongoPersistence(db);
        await decisions.record({
          conversationId: "c1",
          toolCallId: "call-1",
          kind: "approval",
          toolName: "weird",
          payload: { "a.b": 1, $set: 2, nested: { "p.q": 3 } },
          requestedAt: 1,
        });
        const [record] = await decisions.listPending("c1");
        expect(record?.payload).toEqual({ "a.b": 1, $set: 2, nested: { "p.q": 3 } });
      });
    });

    it("`undefined` 按 JSON 语义丢掉，不变成 `null`（与 SQL 那几家一致）", async () => {
      // BSON 默认会把 `undefined` 存成 `null`，而 SQL 那几家走 `JSON.stringify` 是
      // **丢掉这个键**。`toBson` 先做一次 JSON 归一就是为了对齐它们。
      await withDb(async (db) => {
        const { ledger } = mongoPersistence(db);
        await ledger.append({
          conversationId: "c1",
          seq: 1,
          message: {
            id: "m1",
            role: "assistant",
            parts: [{ type: "text", text: "hi" }],
            metadata: { turn: 7, usage: { totalTokens: 42, cachedInputTokens: undefined } },
          },
          ts: 1,
        });
        const [entry] = await ledger.read("c1");
        expect(entry?.message.metadata?.usage).toEqual({ totalTokens: 42 });
        expect(entry?.message.metadata?.usage).not.toHaveProperty("cachedInputTokens");
      });
    });

    it("`settle` 看的是 matchedCount——值没变也算结清成功", async () => {
      // Mongo 在「匹配到但新值 === 旧值」时报 `matched=1, modified=0`。用 modifiedCount
      // 判断就会把一次成功的结清误报成 404。这条用例把那个分支钉死。
      await withDb(async (db) => {
        const { decisions } = mongoPersistence(db);
        await decisions.record({
          conversationId: "c1",
          toolCallId: "call-1",
          kind: "approval",
          // 先把结局写成 allow，但仍是待定（decidedAt 缺席）。
          outcome: "allow",
          requestedAt: 1,
        });
        // 用**完全相同**的 outcome 去结清：Mongo 只会改 decidedAt，
        // 但即便连 decidedAt 都没变，matchedCount 也该让它返回 true。
        expect(
          await decisions.settle("c1", "call-1", { outcome: "allow", decidedAt: 2 }),
        ).toBe(true);
        expect(await decisions.listPending("c1")).toEqual([]);
      });
    });

    it("数据跨连接存活——这是「持久化」这三个字的全部意义", async () => {
      const dbName = `runko_persist_${crypto.randomUUID().slice(0, 8)}`;
      const first = new MongoClient(url);
      await first.connect();
      await migrate(first.db(dbName));
      await mongoPersistence(first.db(dbName)).ledger.append({
        conversationId: "c1",
        seq: 1,
        message: { id: "m1", role: "assistant", parts: [{ type: "text", text: "重启前" }] },
        ts: 1,
      });
      await first.close();

      // 换一个连接（模拟进程重启）再读。
      const second = new MongoClient(url);
      await second.connect();
      const entries = await mongoPersistence(second.db(dbName)).ledger.read("c1");
      expect(entries).toHaveLength(1);
      expect(entries[0]?.message.parts).toEqual([{ type: "text", text: "重启前" }]);
      await second.db(dbName).dropDatabase();
      await second.close();
    });
  });
}
