/**
 * 薄壳的冒烟测：**它只做一件事——把驱动包成 Kysely 转交给核心**，所以这里只验
 * 「转交对了没」，不重复跑一致性套件（那是 `@nimbo/persist-kysely` 的活，同一份
 * 实现跑两遍没有信息量）。
 *
 * SQLite 这一档零外部依赖，所以顺便把整套一致性用例也跑一遍——白捡的覆盖。
 */
import { runPersistenceConformance } from "@nimbo/agent/conformance";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { sqlitePersistence, migrate } from "../src/index.js";

runPersistenceConformance("persist-sqlite", async () => {
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
