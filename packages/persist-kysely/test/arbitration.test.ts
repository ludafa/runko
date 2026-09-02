/**
 * 租约版[归属仲裁机制](../../../docs/terms.md)跑[一致性套件](../../conformance/src/arbitration.ts)
 * 的**全部三组**——包括内存版跑不了的「多节点」与「超时接管」。
 *
 * **两个 `Arbitration` 实例 = 两个逻辑节点。** 它们共享同一个库、`holder` 不同，走的是
 * 与真·两个进程完全相同的那条路（令牌 CAS 落在数据库里）。真开两个 OS 进程是另一档
 * 验证（[施工计划](../../../docs/logic/arbitration/plans/arbitration-impl.md) 的 L9），
 * 本文件不替代它——但「被误判的老持有者写入被拒」这条核心断言，在这里已经是真库上的
 * 真行为，不是模拟。
 *
 * `expire` **把持有者那一侧的时钟停在过去**——比等 60 秒真实超时靠谱得多，也让用例不依赖
 * 挂钟。注意不能只改 `heartbeat_at`：持有者还活着，它的下一拍心跳会把时刻刷回来，接管
 * 于是随机失败（库越快撞上的概率越大）。冻住它的时钟之后，它爱跳多少拍都写不出一个
 * 「新鲜」的心跳时刻。
 */
import { PGlite } from "@electric-sql/pglite";
import type {
  ArbitrationConformanceSetup,
  ConformanceCase,
  MultiNodeConformanceSetup,
  TakeoverConformanceSetup,
} from "@runko/conformance";
import {
  arbitrationCases,
  arbitrationMultiNodeCases,
  arbitrationTakeoverCases,
} from "@runko/conformance";
import Database from "better-sqlite3";
import { Kysely, MysqlDialect, PostgresDialect, SqliteDialect } from "kysely";
import { afterAll, describe, expect, it } from "vitest";

import { traitsOf } from "../src/flavor.js";
import type { Flavor, RunkoDatabase } from "../src/index.js";
import { leaseArbitration, migrate } from "../src/index.js";
import type { FaultyDialect } from "./helpers/faulty-dialect.js";
import { faultySqlite } from "./helpers/faulty-dialect.js";
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

/** 一档的完整装配：两个「节点」+ 一个让持有者看起来死掉的钩子。 */
function setupFor(db: Kysely<RunkoDatabase>, flavor: Flavor): TakeoverConformanceSetup {
  const traits = traitsOf(flavor);
  // **心跳调到 40ms / 判死 200ms**（仍满足「阈值 ≥ 3× 心跳」那条硬规矩）：默认的
  // 5s/60s 让「心跳自己发现被接管」那条用例要等一分钟。语义不变，只是把时间轴压扁。
  const timings = { heartbeatMs: 40, takeoverMs: 200 };

  // 持有者那一侧的时钟。`expire` 把它拨到很久以前并**留在那儿**——于是持有者后面每一拍
  // 心跳写进 `heartbeat_at` 的都是过期的时刻，另一个节点稳定地看到它已死。
  let holderSkew = 0;
  const holderNow = (): number => Date.now() - holderSkew;

  return {
    arbitration: leaseArbitration(db, { flavor: traits, holder: "node-a", now: holderNow, ...timings }),
    other: leaseArbitration(db, { flavor: traits, holder: "node-b", ...timings }),
    expire: async (conversationId: string): Promise<void> => {
      holderSkew = timings.takeoverMs * 10;
      await db
        .updateTable("agent_leases")
        .set({ heartbeat_at: holderNow() })
        .where("conversation_id", "=", conversationId)
        .execute();
    },
  };
}

/** 一条用例一个库的那几档：跑完把库关掉。共用库的那档不用它。 */
function closing(db: Kysely<RunkoDatabase>): { cleanup: () => Promise<void> } {
  return {
    cleanup: async (): Promise<void> => {
      await db.destroy();
    },
  };
}

/**
 * 一档全跑：三组都接上。
 *
 * **三组是分开接的，不是一个数组配可选字段**——租约版声称自己支持多节点与接管，就把这
 * 三组都写出来，跑了什么一眼可查，而不是漏了 `expire` 就静默跳过还显示绿。（三个数组
 * 之间没有类型绑定，少接一组编译照过；这条靠评审守，不靠编译器。）
 */
function runAllGroups(title: string, make: () => Promise<TakeoverConformanceSetup>): void {
  runCases<ArbitrationConformanceSetup>(`${title} · 通用`, arbitrationCases, make);
  runCases<MultiNodeConformanceSetup>(`${title} · 多节点`, arbitrationMultiNodeCases, make);
  runCases<TakeoverConformanceSetup>(`${title} · 超时接管`, arbitrationTakeoverCases, make);
}

// ---------------------------------------------------------------------------
// 永远跑的两档
// ---------------------------------------------------------------------------

runAllGroups("lease · sqlite", async () => {
  const sqlite = new Database(":memory:");
  const db = new Kysely<RunkoDatabase>({ dialect: new SqliteDialect({ database: sqlite }) });
  await migrate(db, { flavor: "sqlite" });
  return { ...setupFor(db, "sqlite"), ...closing(db) };
});

/**
 * **pglite 这一档共用一个实例，用例之间清租约表**——不是一条用例一个库。
 *
 * `new PGlite()` 是「现编译 WASM + 起一个 initdb 出来的库」，一次 0.6~3 秒，而这一档
 * 二十条用例的耗时几乎全花在建库上。CI 上被别的包挤一挤，单条就摸到默认 5s 超时——
 * 真挂过（见 vitest.config.ts 里那段）。
 *
 * **共用是安全的，靠的正是这个包保证的那条性质**：心跳的 UPDATE 和 `stillHeld` 都带
 * `lease_token`。上一条用例没释放的心跳还在跳，但 `clearLeases` 之后它那行已经没了、
 * 新用例的行又是新令牌——它打中的行数是 0，下一拍就自己 `lose()` 停表，**碰不到新
 * 用例的租约**。两个「真库」档本来就是所有用例共用同一个库，形状完全一样。
 */
let pglite: Promise<Kysely<RunkoDatabase>> | undefined;

function sharedPglite(): Promise<Kysely<RunkoDatabase>> {
  pglite ??= (async () => {
    const db = new Kysely<RunkoDatabase>({ dialect: pgliteDialect(new PGlite()) });
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

runAllGroups("lease · postgres (pglite)", async () => {
  const db = await sharedPglite();
  await clearLeases(db);
  return setupFor(db, "postgres");
});

// ---------------------------------------------------------------------------
// 给了连接串才跑的两档
// ---------------------------------------------------------------------------

const POSTGRES_URL = process.env["RUNKO_TEST_POSTGRES_URL"];
const MYSQL_URL = process.env["RUNKO_TEST_MYSQL_URL"];

async function clearLeases(db: Kysely<RunkoDatabase>): Promise<void> {
  await db.deleteFrom("agent_leases").execute();
}

if (POSTGRES_URL !== undefined) {
  runAllGroups("lease · postgres (真库)", async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: POSTGRES_URL });
    const db = new Kysely<RunkoDatabase>({ dialect: new PostgresDialect({ pool }) });
    await migrate(db, { flavor: "postgres" });
    await clearLeases(db);
    return { ...setupFor(db, "postgres"), ...closing(db) };
  });
} else {
  describe.skip("lease · postgres (真库)", () => {
    it("没给 RUNKO_TEST_POSTGRES_URL，跳过", () => undefined);
  });
}

if (MYSQL_URL !== undefined) {
  runAllGroups("lease · mysql (真库)", async () => {
    const { createPool } = await import("mysql2");
    const pool = createPool(MYSQL_URL);
    const db = new Kysely<RunkoDatabase>({ dialect: new MysqlDialect({ pool }) });
    await migrate(db, { flavor: "mysql" });
    await clearLeases(db);
    return { ...setupFor(db, "mysql"), ...closing(db) };
  });
} else {
  describe.skip("lease · mysql (真库)", () => {
    it("没给 RUNKO_TEST_MYSQL_URL，跳过", () => undefined);
  });
}

// ---------------------------------------------------------------------------
// 配置校验——这条本身就是功能的一部分
// ---------------------------------------------------------------------------

describe("leaseArbitration 的配置校验", () => {
  const db = new Kysely<RunkoDatabase>({ dialect: new SqliteDialect({ database: new Database(":memory:") }) });

  it("阈值不足心跳的 3 倍 → **构造时就抛**，不等线上误接管", () => {
    expect(() =>
      leaseArbitration(db, { flavor: traitsOf("sqlite"), holder: "n", heartbeatMs: 10_000, takeoverMs: 20_000 }),
    ).toThrow(/at least 3× heartbeat/);
  });

  it("刚好 3 倍是允许的", () => {
    expect(() =>
      leaseArbitration(db, { flavor: traitsOf("sqlite"), holder: "n", heartbeatMs: 10_000, takeoverMs: 30_000 }),
    ).not.toThrow();
  });

  it("默认值就是定案的 5s / 60s（12 拍）", () => {
    expect(() => leaseArbitration(db, { flavor: traitsOf("sqlite"), holder: "n" })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 自我围栏：这几条是实现特有的，进不了一致性套件（要能让库坏掉）
// ---------------------------------------------------------------------------

/** 起一个「库可以故意坏掉」的租约仲裁。 */
async function faultyLease(timings: { heartbeatMs: number; takeoverMs: number }): Promise<{
  arbitration: ReturnType<typeof leaseArbitration>;
  faulty: FaultyDialect;
  db: Kysely<RunkoDatabase>;
}> {
  const faulty = faultySqlite(new Database(":memory:"));
  const db = new Kysely<RunkoDatabase>({ dialect: faulty.dialect });
  await migrate(db, { flavor: "sqlite" });
  return {
    db,
    faulty,
    arbitration: leaseArbitration(db, { flavor: traitsOf("sqlite"), holder: "node-a", ...timings }),
  };
}

/** 等 `signal` abort，最多等 `budget` 毫秒。 */
async function waitForAbort(signal: AbortSignal, budget: number): Promise<void> {
  const deadline = Date.now() + budget;
  while (!signal.aborted && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("心跳打不通时的自我围栏", () => {
  it("**连接抛错、连续失败到逼近阈值 → 老持有者自己停手**，不等别人来告诉它", async () => {
    const { arbitration, faulty, db } = await faultyLease({ heartbeatMs: 30, takeoverMs: 150 });
    const got = await arbitration.acquire("c1", { seedSeq: () => Promise.resolve(0) });
    expect(got.ok).toBe(true);
    if (!got.ok) {
      return;
    }

    // **库连不上了**——此后每一拍心跳都抛。
    // 修复之前：`beat()` 的 catch 只 return，于是 `signal` 永不 abort，这一轮会继续
    // 调模型、继续动沙盒，而别人在 `takeoverMs` 之后已经合法接管——两个执行同时
    // 改同一个工作区。
    faulty.fail(Number.MAX_SAFE_INTEGER);

    await waitForAbort(got.grant.signal, 2_000);
    expect(got.grant.signal.aborted).toBe(true);
    expect(got.grant.valid).toBe(false);
    await db.destroy();
  });

  it("**连接挂住不返回（不是抛错）也要停手**——这一档比抛错更常见", async () => {
    const { arbitration, faulty, db } = await faultyLease({ heartbeatMs: 30, takeoverMs: 150 });
    const got = await arbitration.acquire("c1", { seedSeq: () => Promise.resolve(0) });
    expect(got.ok).toBe(true);
    if (!got.ok) {
      return;
    }

    // TCP 黑洞 / 连接池耗尽 / 网络分区下的 TCP 停滞：查询**永不返回**，也永不抛。
    // 修复之前：第一拍卡在 await 上，`beating` 永远停在 true，后面每一拍都在防重入
    // 那里就 return 了；围栏判断只写在 catch 里，于是一次也跑不到——等 10 倍阈值
    // 仍然 `aborted === false`。
    faulty.hang();

    await waitForAbort(got.grant.signal, 2_000);
    expect(got.grant.signal.aborted).toBe(true);
    expect(got.grant.valid).toBe(false);
    await db.destroy();
  });

  it("偶发几次失败不算失去归属——库恢复后照常继续", async () => {
    // 阈值很远：几拍失败远不到自我围栏的线。
    const { arbitration, faulty, db } = await faultyLease({ heartbeatMs: 20, takeoverMs: 5_000 });
    const got = await arbitration.acquire("c1", { seedSeq: () => Promise.resolve(0) });
    expect(got.ok).toBe(true);
    if (!got.ok) {
      return;
    }

    // **真的注入两次失败**——不注入的话这条验的其实是「心跳正常时不会误 abort」，
    // catch 里「失败但没到阈值 → 什么都不做」那一支根本没被跑到。
    faulty.fail(2);

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(got.grant.signal.aborted).toBe(false);
    // 库恢复之后照常取号，说明归属没丢。
    expect(await got.grant.nextSeq()).toMatchObject({ ok: true });

    await got.grant.release();
    await db.destroy();
  });

  it("**库坏掉时 `nextSeq` 也不抛**——契约写死了它返回结果，收尾路径没有 try 接着", async () => {
    const { arbitration, faulty, db } = await faultyLease({ heartbeatMs: 5_000, takeoverMs: 60_000 });
    const got = await arbitration.acquire("c1", { seedSeq: () => Promise.resolve(0) });
    expect(got.ok).toBe(true);
    if (!got.ok) {
      return;
    }

    faulty.fail(Number.MAX_SAFE_INTEGER);
    // 修复之前：`db.updateTable(...).execute()` 的异常原样冒出去，从
    // `appendSettleMessage` 里逃出来——那正是最不该出事的一段。
    await expect(got.grant.nextSeq()).resolves.toEqual({ ok: false, reason: "lost_ownership" });
    await db.destroy();
  });
});
