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

import { mysqlPersistence, migrate } from "../src/index.js";

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
  });
}
