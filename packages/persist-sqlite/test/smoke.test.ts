/**
 * 薄壳的冒烟测：**它只做一件事——把驱动包成 Kysely 转交给核心**，所以这里只验
 * 「转交对了没」，不重复跑一致性套件（那是 `@nimbo/persist-kysely` 的活，同一份
 * 实现跑两遍没有信息量）。
 *
 * SQLite 这一档零外部依赖，所以顺便把整套一致性用例也跑一遍——白捡的覆盖。
 */
import type { ConformanceCase } from "@nimbo/conformance";
import { persistenceCases } from "@nimbo/conformance";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { sqlitePersistence, migrate } from "../src/index.js";

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

runCases("persist-sqlite", persistenceCases, async () => {
  const db = new Database(":memory:");
  await migrate(db);
  return {
    persistence: sqlitePersistence(db),
    cleanup: () => {
      db.close();
    },
  };
});

describe("persist-sqlite", () => {
  it("migrate 幂等", async () => {
    const db = new Database(":memory:");
    await migrate(db);
    await migrate(db);
    expect(await sqlitePersistence(db).ledger.maxSeq("c1")).toBe(0);
    db.close();
  });
});
