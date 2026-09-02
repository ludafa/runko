/**
 * 一致性套件跑在**三个方言**上——同一套用例，`@nimbo/conformance` 导出。
 *
 * | 方言 | 跑在哪 | 要不要外部服务 |
 * |---|---|---|
 * | SQLite | `better-sqlite3` 的 `:memory:` | 不要 |
 * | Postgres | **pglite**（WASM，进程内） | 不要 |
 * | Postgres | 真 Postgres | 要，`NIMBO_TEST_POSTGRES_URL` |
 * | MySQL | 真 MySQL | 要，`NIMBO_TEST_MYSQL_URL` |
 *
 * **前两档永远跑**：CI 不用配 service container、贡献者不用装 Docker。
 * **后两档给了连接串才跑**，没给就 `describe.skip` 掉并在输出里说明——不是静默跳过。
 *
 * MySQL 没有 WASM 替身，所以它**只有**真库这一档。这是个已知的覆盖缺口：CI 上
 * MySQL 目前不跑，得靠本地或带 service container 的流水线。
 */
import { PGlite } from "@electric-sql/pglite";
import type { ConformanceCase } from "@nimbo/conformance";
import { persistenceCases } from "@nimbo/conformance";
import Database from "better-sqlite3";
import { Kysely, MysqlDialect, PostgresDialect, SqliteDialect } from "kysely";
import { describe, expect, it } from "vitest";

import { kyselyPersistence, migrate } from "../src/index.js";
import type { NimboDatabase } from "../src/index.js";
import { pgliteDialect } from "./helpers/pglite-dialect.js";

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

// ---------------------------------------------------------------------------
// 永远跑的两档
// ---------------------------------------------------------------------------

runCases("persist-kysely · sqlite", persistenceCases, async () => {
  const sqlite = new Database(":memory:");
  const db = new Kysely<NimboDatabase>({ dialect: new SqliteDialect({ database: sqlite }) });
  await migrate(db, { flavor: "sqlite" });
  return {
    persistence: kyselyPersistence(db, { flavor: "sqlite" }),
    cleanup: async () => {
      await db.destroy();
    },
  };
});

runCases("persist-kysely · postgres (pglite)", persistenceCases, async () => {
  const pglite = new PGlite();
  const db = new Kysely<NimboDatabase>({ dialect: pgliteDialect(pglite) });
  await migrate(db, { flavor: "postgres" });
  return {
    persistence: kyselyPersistence(db, { flavor: "postgres" }),
    cleanup: async () => {
      await db.destroy();
    },
  };
});

// ---------------------------------------------------------------------------
// 给了连接串才跑的两档
// ---------------------------------------------------------------------------

const POSTGRES_URL = process.env["NIMBO_TEST_POSTGRES_URL"];
const MYSQL_URL = process.env["NIMBO_TEST_MYSQL_URL"];

/** 每次用独立的 schema/前缀跑，避免两次运行互相污染。这里用「跑前清表」最省事。 */
async function truncate(db: Kysely<NimboDatabase>): Promise<void> {
  await db.deleteFrom("nimbo_ledger").execute();
  await db.deleteFrom("nimbo_decisions").execute();
  await db.deleteFrom("nimbo_queue").execute();
}

if (POSTGRES_URL !== undefined) {
  runCases("persist-kysely · postgres (真库)", persistenceCases, async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: POSTGRES_URL });
    const db = new Kysely<NimboDatabase>({ dialect: new PostgresDialect({ pool }) });
    await migrate(db, { flavor: "postgres" });
    await truncate(db);
    return {
      persistence: kyselyPersistence(db, { flavor: "postgres" }),
      cleanup: async () => {
        await db.destroy();
      },
    };
  });
} else {
  describe.skip("persist-kysely · postgres (真库)", () => {
    it("没给 NIMBO_TEST_POSTGRES_URL，跳过", () => undefined);
  });
}

if (MYSQL_URL !== undefined) {
  runCases("persist-kysely · mysql (真库)", persistenceCases, async () => {
    const { createPool } = await import("mysql2");
    const pool = createPool(MYSQL_URL);
    const db = new Kysely<NimboDatabase>({ dialect: new MysqlDialect({ pool }) });
    await migrate(db, { flavor: "mysql" });
    await truncate(db);
    return {
      persistence: kyselyPersistence(db, { flavor: "mysql" }),
      cleanup: async () => {
        await db.destroy();
      },
    };
  });
} else {
  describe.skip("persist-kysely · mysql (真库)", () => {
    it("没给 NIMBO_TEST_MYSQL_URL，跳过 —— MySQL 没有 WASM 替身，只能对真库跑", () => undefined);
  });
}

// ---------------------------------------------------------------------------
// 套件覆盖不到的：建表本身
// ---------------------------------------------------------------------------

describe("migrate", () => {
  it("幂等——跑两次不炸，结果一样", async () => {
    const sqlite = new Database(":memory:");
    const db = new Kysely<NimboDatabase>({ dialect: new SqliteDialect({ database: sqlite }) });
    await migrate(db, { flavor: "sqlite" });
    await migrate(db, { flavor: "sqlite" });

    const persistence = kyselyPersistence(db, { flavor: "sqlite" });
    await persistence.ledger.append({
      conversationId: "c1",
      seq: 1,
      message: { id: "m1", role: "assistant", parts: [] },
      ts: 1,
    });
    expect(await persistence.ledger.maxSeq("c1")).toBe(1);
    await db.destroy();
  });

  it("数据跨连接存活——这是「持久化」这三个字的全部意义", async () => {
    const file = `${String(process.env["TMPDIR"] ?? "/tmp")}/nimbo-kysely-${crypto.randomUUID()}.db`;

    const first = new Kysely<NimboDatabase>({
      dialect: new SqliteDialect({ database: new Database(file) }),
    });
    await migrate(first, { flavor: "sqlite" });
    await kyselyPersistence(first, { flavor: "sqlite" }).ledger.append({
      conversationId: "c1",
      seq: 1,
      message: { id: "m1", role: "assistant", parts: [{ type: "text", text: "重启前" }] },
      ts: 1,
    });
    await first.destroy();

    // 换一个连接（模拟进程重启）再读。
    const second = new Kysely<NimboDatabase>({
      dialect: new SqliteDialect({ database: new Database(file) }),
    });
    const entries = await kyselyPersistence(second, { flavor: "sqlite" }).ledger.read("c1");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.message.parts).toEqual([{ type: "text", text: "重启前" }]);
    await second.destroy();
  });
});
