/**
 * 薄壳的冒烟测：**它只做一件事——把驱动包成 Kysely 转交给核心**，所以这里只验
 * 「转交对了没」，不重复跑一致性套件（那是 `@runko/persist-kysely` 的活，同一份
 * 实现跑两遍没有信息量）。
 *
 * 它要连真库，所以**给了 `RUNKO_TEST_MYSQL_URL` 才跑**（没给就跳过并说明原因）——
 * MySQL 没有进程内的替身。
 */
import type { ConformanceCase } from "@runko/conformance";
import { persistenceCases } from "@runko/conformance";
import { createPool } from "mysql2";
import { describe, expect, it } from "vitest";

import { mysqlArbitration, mysqlPersistence, migrate } from "../src/index.js";

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

const URL = process.env["RUNKO_TEST_MYSQL_URL"];

if (URL === undefined) {
  describe.skip("persist-mysql", () => {
    it("没给 RUNKO_TEST_MYSQL_URL，跳过 —— MySQL 没有进程内替身，只能对真库跑", () => undefined);
  });
} else {
  describe("persist-mysql", () => {
    it("migrate 幂等，装出来的 Persistence 能用", async () => {
      const pool = createPool(URL);
      await migrate(pool);
      await migrate(pool);

      const persistence = mysqlPersistence(pool);
      const conversationId = `smoke-${crypto.randomUUID()}`;
      expect(await persistence.ledger.maxSeq(conversationId)).toBe(0);
      await persistence.ledger.append({
        conversationId,
        seq: 1,
        message: { id: "m1", role: "assistant", parts: [{ type: "text", text: "喂" }] },
        ts: 1,
      });
      const entries = await persistence.ledger.read(conversationId);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.message.parts).toEqual([{ type: "text", text: "喂" }]);

      pool.end();
    });

    it("装出来的租约版仲裁与账本落在同一个库——取号从账本水位接着数", async () => {
      const pool = createPool(URL);
      await migrate(pool);
      const persistence = mysqlPersistence(pool);
      const conversationId = `lease-${crypto.randomUUID()}`;
      await persistence.ledger.append({
        conversationId,
        seq: 1,
        message: { id: "m1", role: "user", parts: [{ type: "text", text: "喂" }] },
        ts: 1,
      });

      const arbitration = mysqlArbitration(pool, { holder: "node-a" });
      const acquired = await arbitration.acquire(conversationId, {
        seedSeq: () => persistence.ledger.maxSeq(conversationId),
      });
      expect(acquired.ok).toBe(true);
      if (acquired.ok) {
        // 接错库的话这里会是 1——那正是「账本写这边、租约写那边」的症状。
        expect(await acquired.grant.nextSeq()).toEqual({ ok: true, seq: 2 });
        // 第二个「节点」抢不到，且拿得到第一个的 holder（接入层据它转发）。
        const other = mysqlArbitration(pool, { holder: "node-b" });
        expect(await other.acquire(conversationId, { seedSeq: () => Promise.resolve(0) })).toEqual({
          ok: false,
          reason: "busy",
          holder: "node-a",
        });
        await acquired.grant.release();
      }

      pool.end();
    });
  });
}
