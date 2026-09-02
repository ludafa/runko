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
import type { ConformanceCase, PersistenceConformanceSetup } from "@nimbo/conformance";
import { persistenceCases } from "@nimbo/conformance";
import Database from "better-sqlite3";
import { Kysely, MysqlDialect, PostgresDialect, SqliteDialect } from "kysely";
import { afterAll, describe, expect, it } from "vitest";

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

/**
 * 跑前清表——**复用同一个库的那几档都靠它**：pglite 共用实例、真库跨两次运行，
 * 都得保证每条用例从空表开始。
 *
 * **只清持久化用的三张，不动 `nimbo_leases`。** 租约那张归 arbitration.test.ts 清
 * （它的 `clearLeases`）；两个文件在 CI 上连的是同一个真库、还是并发跑的，各清各的
 * 才不会把对方的用例洗掉。
 */
async function truncate(db: Kysely<NimboDatabase>): Promise<void> {
  await db.deleteFrom("nimbo_ledger").execute();
  await db.deleteFrom("nimbo_decisions").execute();
  await db.deleteFrom("nimbo_queue").execute();
}

/**
 * **pglite 这一档共用一个实例，用例之间清表**——不是一条用例一个库。
 *
 * `new PGlite()` 是「现编译 WASM + 起一个 initdb 出来的库」，一次要 0.6~3 秒。这一档
 * 三十多条用例，一条一个的话光它就是一分多钟，更要命的是**单条用例的耗时里绝大部分
 * 是建库**——CI 上被别的包挤一挤就顶穿超时，真挂过（见 vitest.config.ts 里那段）。
 *
 * 共用之后每条用例只多三条 `DELETE`，**隔离性没打折**：四张表里持久化用例只碰账本、
 * 裁决、待发队列这三张，`truncate` 全清；表里也没有自增列，删干净就等于新库。
 *
 * **只有这一档能这么共用。** 租约那边（arbitration.test.ts）的心跳是后台定时器，
 * 用例结束后还会继续跳，共用一个库要靠令牌 CAS 兜底才不串台——那是另一回事，
 * 那个文件保持一条用例一个实例。
 */
let pglite: Promise<Kysely<NimboDatabase>> | undefined;

function sharedPglite(): Promise<Kysely<NimboDatabase>> {
  pglite ??= (async () => {
    const db = new Kysely<NimboDatabase>({ dialect: pgliteDialect(new PGlite()) });
    await migrate(db, { flavor: "postgres" });
    return db;
  })();
  return pglite;
}

afterAll(async () => {
  if (pglite !== undefined) {
    await (await pglite).destroy();
  }
});

runCases<PersistenceConformanceSetup>("persist-kysely · postgres (pglite)", persistenceCases, async () => {
  const db = await sharedPglite();
  await truncate(db);
  return { persistence: kyselyPersistence(db, { flavor: "postgres" }) };
});

// ---------------------------------------------------------------------------
// 给了连接串才跑的两档
// ---------------------------------------------------------------------------

const POSTGRES_URL = process.env["NIMBO_TEST_POSTGRES_URL"];
const MYSQL_URL = process.env["NIMBO_TEST_MYSQL_URL"];

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
