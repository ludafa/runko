/**
 * 薄壳的冒烟测：**它只做一件事——把驱动包成 Kysely 转交给核心**，所以这里只验
 * 「转交对了没」，不重复跑一致性套件（那是 `@nimbo/persist-kysely` 的活，同一份
 * 实现跑两遍没有信息量）。
 *
 * 它要连真库，所以**给了 `NIMBO_TEST_MYSQL_URL` 才跑**（没给就跳过并说明原因）——
 * MySQL 没有进程内的替身。
 */
import { runPersistenceConformance } from "@nimbo/agent/conformance";
import { createPool } from "mysql2";
import { describe, expect, it } from "vitest";

import { mysqlPersistence, migrate } from "../src/index.js";

const URL = process.env["NIMBO_TEST_MYSQL_URL"];

if (URL === undefined) {
  describe.skip("persist-mysql", () => {
    it("没给 NIMBO_TEST_MYSQL_URL，跳过 —— MySQL 没有进程内替身，只能对真库跑", () => undefined);
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
