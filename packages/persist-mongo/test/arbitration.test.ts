/**
 * 租约版[归属仲裁机制](../../../docs/terms.md)的 Mongo 版，跑
 * [一致性套件](../../conformance/src/arbitration.ts)的**全部四组**——包括内存版跑不了的
 * 「多节点」与「超时接管」。另外三组
 * （[交接预留 / 待接手 / 定时回捞](../../conformance/src/handover.ts)、
 * [节点登记表](../../conformance/src/node-registry.ts)、
 * [工具收尾](../../conformance/src/tool-tails.ts)）见文件后半段。
 *
 * **两个 `Arbitration` 实例 = 两个逻辑副本。** 它们共享同一个 database、`holder` 不同，
 * 走的是与真·两个进程完全相同的那条路（令牌 CAS 落在 Mongo 里）。
 *
 * **只能对真库跑**（同 `conformance.test.ts`：Mongo 没有进程内替身），门禁是
 * `RUNKO_TEST_MONGO_URL`：
 *
 * ```sh
 * RUNKO_TEST_MONGO_URL=mongodb://127.0.0.1:27018 pnpm --filter @runko/persist-mongo test
 * ```
 *
 * `expire` **把持有者那一侧的时钟停在过去**——比等 60 秒真实超时靠谱得多，也让用例不依赖
 * 挂钟。注意不能只改 `heartbeatAt`：持有者还活着，它的下一拍心跳会把时刻刷回来，接管
 * 于是随机失败（库越快撞上的概率越大）。冻住它的时钟之后，它爱跳多少拍都写不出一个
 * 「新鲜」的心跳时刻。
 */
import type { ToolTailStore } from "@runko/agent";
import type {
  ArbitrationConformanceSetup,
  ConformanceCase,
  HandoverConformanceSetup,
  MultiNodeConformanceSetup,
  NodeRegistryConformanceSetup,
  RestartConformanceSetup,
  TakeoverConformanceSetup,
  ToolTailConformanceSetup,
} from "@runko/conformance";
import {
  arbitrationCases,
  arbitrationMultiNodeCases,
  arbitrationRestartCases,
  arbitrationTakeoverCases,
  arbitrationTakeoverReportCases,
  handoverCases,
  nodeRegistryCases,
  toolTailCases,
} from "@runko/conformance";
import type { Db } from "mongodb";
import { MongoClient } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";

import type { LeaseDoc } from "../src/index.js";
import {
  LEASES_COLLECTION,
  migrate,
  mongoArbitration,
  mongoNodeRegistry,
  mongoPersistence,
  NODES_COLLECTION,
  QUEUE_COLLECTION,
  TAILS_COLLECTION,
} from "../src/index.js";
import type { FaultyDb } from "./helpers/faulty-db.js";
import { faultyDb } from "./helpers/faulty-db.js";

/**
 * 把一致性用例接进 vitest。**套件本身不依赖任何测试框架**（它只导出 `{ name, run }`），
 * 这十几行就是「接上去」的全部成本。
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

/**
 * **心跳调到 40ms / 判死 200ms**（仍满足「阈值 ≥ 3× 心跳」那条硬规矩）：默认的 5s/60s
 * 让「心跳自己发现被接管」那条用例要等一分钟。语义不变，只是把时间轴压扁。
 */
const TIMINGS = { heartbeatMs: 40, takeoverMs: 200 };

/** 一档的完整装配：两个「副本」+ 一个让持有者看起来死掉的钩子。 */
function setupFor(db: Db): TakeoverConformanceSetup & RestartConformanceSetup {
  // 持有者那一侧的时钟。`expire` 把它拨到很久以前并**留在那儿**——于是持有者后面每一拍
  // 心跳写进 `heartbeatAt` 的都是过期的时刻，另一个副本稳定地看到它已死。
  let holderSkew = 0;
  /** 钉死之后，持有者那一侧的时钟停在这一刻——它的心跳再也写不出新的时刻。 */
  let holderFrozenAt: number | undefined;
  const holderNow = (): number => holderFrozenAt ?? Date.now() - holderSkew;

  return {
    arbitration: mongoArbitration(db, { holder: "node-a", now: holderNow, ...TIMINGS }),
    other: mongoArbitration(db, { holder: "node-b", ...TIMINGS }),
    restart: () => mongoArbitration(db, { holder: "node-a", ...TIMINGS }),
    freezeClock: () => {
      holderFrozenAt = holderNow();
    },
    expire: async (conversationId: string): Promise<void> => {
      holderSkew = TIMINGS.takeoverMs * 10;
      await db
        .collection<LeaseDoc>(LEASES_COLLECTION)
        .updateOne({ _id: conversationId }, { $set: { heartbeatAt: holderNow() } });
    },
  };
}

/**
 * 五组全跑。
 *
 * **五组是分开接的，不是一个数组配可选字段**——租约版声称自己支持多节点、接管、报
 * `takeover`、同名重启，就把五组都写出来，跑了什么一眼可查，而不是漏了 `expire` 就静默
 * 跳过还显示绿。（五个数组之间没有类型绑定，少接一组编译照过；这条靠评审守，不靠编译器。）
 */
function runAllGroups(title: string, make: () => Promise<TakeoverConformanceSetup & RestartConformanceSetup>): void {
  runCases<ArbitrationConformanceSetup>(`${title} · 通用`, arbitrationCases, make);
  runCases<MultiNodeConformanceSetup>(`${title} · 多节点`, arbitrationMultiNodeCases, make);
  runCases<TakeoverConformanceSetup>(`${title} · 超时接管`, arbitrationTakeoverCases, make);
  runCases<TakeoverConformanceSetup>(`${title} · 报 takeover`, arbitrationTakeoverReportCases, make);
  runCases<RestartConformanceSetup>(`${title} · 同名重启`, arbitrationRestartCases, make);
}

const MONGO_URL = process.env["RUNKO_TEST_MONGO_URL"];

if (MONGO_URL === undefined) {
  describe.skip("lease · mongo (真库)", () => {
    it("没给 RUNKO_TEST_MONGO_URL，跳过 —— Mongo 没有进程内替身，只能对真库跑", () => undefined);
  });
} else {
  const url = MONGO_URL;

  /**
   * **整档共用一个连接与一个 database，用例之间清租约集合**——不是一条用例一个 db。
   *
   * 共用是安全的，靠的正是这个包保证的那条性质：心跳的 `updateOne` 带 `leaseToken`。
   * 上一条用例没释放的心跳还在跳，但清掉集合之后它那条文档已经没了、新用例的又是新令牌
   * ——它 `matchedCount` 是 0，下一拍就自己 `lose()` 停表，**碰不到新用例的租约**。
   *
   * 还有一条硬理由：一条用例一个 client 意味着几十次 TCP 建连 + 几十次 `migrate()`，
   * 而这一档的耗时几乎全花在那上面。
   */
  let shared: Promise<{ client: MongoClient; db: Db }> | undefined;

  function sharedDb(): Promise<{ client: MongoClient; db: Db }> {
    shared ??= (async () => {
      const client = new MongoClient(url);
      await client.connect();
      const db = client.db(`runko_lease_${crypto.randomUUID().slice(0, 8)}`);
      await migrate(db);
      return { client, db };
    })();
    return shared;
  }

  afterAll(async () => {
    if (shared !== undefined) {
      const { client, db } = await shared;
      await db.dropDatabase();
      await client.close();
    }
  });

  runAllGroups("lease · mongo (真库)", async () => {
    const { db } = await sharedDb();
    await db.collection(LEASES_COLLECTION).deleteMany({});
    return setupFor(db);
  });

  // -------------------------------------------------------------------------
  // H2：交接预留 / 待接手 / 定时回捞
  //
  // **不用担心跟 `conformance.test.ts` 抢队列表**：那份文件每条用例各开一个独立的
  // database（`runko_conformance_*`），跟这里的 `runko_lease_*` 从来不是同一个库，
  // 不像 Kysely 那两档真库是同一个物理实例、得靠「各清各的表」互相避让。
  // -------------------------------------------------------------------------

  runCases<HandoverConformanceSetup>("lease · mongo (真库) · 交接预留 / 待接手 / 定时回捞", handoverCases, async () => {
    const { db } = await sharedDb();
    await db.collection(LEASES_COLLECTION).deleteMany({});
    await db.collection(QUEUE_COLLECTION).deleteMany({});
    const base = setupFor(db);
    return {
      arbitration: base.arbitration,
      other: base.other,
      self: "node-a",
      otherNode: "node-b",
      persistence: mongoPersistence(db),
    };
  });

  // -------------------------------------------------------------------------
  // H2：节点登记表
  // -------------------------------------------------------------------------

  runCases<NodeRegistryConformanceSetup>("lease · mongo (真库) · 节点登记表", nodeRegistryCases, async () => {
    const { db } = await sharedDb();
    await db.collection(NODES_COLLECTION).deleteMany({});
    return {
      registry: mongoNodeRegistry(db),
      acquireLoad: async (node, count) => {
        const arbitration = mongoArbitration(db, { holder: node, ...TIMINGS });
        for (let i = 0; i < count; i += 1) {
          await arbitration.acquire(`load-${node}-${crypto.randomUUID()}`, { seedSeq: () => Promise.resolve(0) });
        }
      },
    };
  });

  // -------------------------------------------------------------------------
  // H2：工具收尾
  // -------------------------------------------------------------------------

  /** `Persistence.tails` 是可选字段，`mongoPersistence` 实际总是带它——没带就是实现坏了。 */
  function tailsOf(db: Db): ToolTailStore {
    const tails = mongoPersistence(db).tails;
    if (tails === undefined) {
      throw new Error("mongoPersistence 应该总是带 tails");
    }
    return tails;
  }

  runCases<ToolTailConformanceSetup>("lease · mongo (真库) · 工具收尾", toolTailCases, async () => {
    const { db } = await sharedDb();
    await db.collection(TAILS_COLLECTION).deleteMany({});
    return { tails: tailsOf(db) };
  });

  // -------------------------------------------------------------------------
  // 套件覆盖不到的：Mongo 特有的那几处
  // -------------------------------------------------------------------------

  describe("lease · mongo 特有的几处", () => {
    it("`migrate` 建出了 `listStale` 要的那个索引，且重复建不炸", async () => {
      const { db } = await sharedDb();
      await migrate(db);
      const names = (await db.collection(LEASES_COLLECTION).indexes()).map((idx) => idx.name);
      expect(names).toContain("agent_leases_heartbeat_token");
    });

    it("**`release` 不删文档**——水位要跨释放保留，下次抢占才不用回账本重新问", async () => {
      const { db } = await sharedDb();
      const arbitration = mongoArbitration(db, { holder: "solo", ...TIMINGS });
      const got = await arbitration.acquire("c-keep", { seedSeq: () => Promise.resolve(5) });
      expect(got.ok).toBe(true);
      if (!got.ok) {
        return;
      }
      expect(await got.grant.nextSeq()).toEqual({ ok: true, seq: 6 });
      await got.grant.release();

      const doc = await db.collection<LeaseDoc>(LEASES_COLLECTION).findOne({ _id: "c-keep" });
      expect(doc).not.toBeNull();
      expect(doc?.leaseToken).toBeNull();
      expect(doc?.holder).toBeNull();
      expect(doc?.seqWatermark).toBe(6);
    });

    it("**心跳写进同一个时刻也算打通**——`matchedCount`，不是 `modifiedCount`", async () => {
      // 本包 README 记着的那个 Mongo 坑：匹配到但新值与旧值相同时，Mongo 报
      // `matched=1, modified=0`。心跳这一条最容易撞上——`acquire` 和 `nextSeq` 也会写
      // `heartbeatAt`，跟一拍心跳落在同一毫秒里，值就没变。
      //
      // 用 `modifiedCount` 判断的话，那一拍会被当成「令牌被换了」→ 立刻 `lose()`，
      // 用户这一轮被自己无缘无故掐断。**把时钟冻住**就是把这个窗口放大到必现。
      const { db } = await sharedDb();
      const frozen = Date.now();
      const arbitration = mongoArbitration(db, {
        holder: "node-frozen",
        heartbeatMs: 20,
        takeoverMs: 200,
        now: () => frozen,
      });
      const got = await arbitration.acquire("c-frozen", { seedSeq: () => Promise.resolve(0) });
      expect(got.ok).toBe(true);
      if (!got.ok) {
        return;
      }

      // 跳够几拍，每一拍写进去的都是同一个 `frozen`。
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(got.grant.signal.aborted).toBe(false);
      expect(got.grant.valid).toBe(true);
      await got.grant.release();
    });

    it("**租约与三个持久化集合互不干扰**——同一个 db，各存各的", async () => {
      const { db } = await sharedDb();
      const persistence = mongoPersistence(db);
      await persistence.ledger.append({
        conversationId: "c-iso",
        seq: 1,
        message: { id: "m1", role: "assistant", parts: [{ type: "text", text: "在账本里" }] },
        ts: 1,
      });

      const arbitration = mongoArbitration(db, { holder: "solo", ...TIMINGS });
      const got = await arbitration.acquire("c-iso", { seedSeq: () => Promise.resolve(1) });
      expect(got.ok).toBe(true);
      if (!got.ok) {
        return;
      }
      await got.grant.nextSeq();

      // 抢占 + 取号动的只有租约那一条文档：账本里那条原样还在，没被多写也没被改。
      const entries = await persistence.ledger.read("c-iso");
      expect(entries).toHaveLength(1);
      expect(entries[0]?.message.parts).toEqual([{ type: "text", text: "在账本里" }]);
      expect(await db.collection<LeaseDoc>(LEASES_COLLECTION).countDocuments({ _id: "c-iso" })).toBe(1);
      await got.grant.release();
    });
  });

  // -------------------------------------------------------------------------
  // 心跳打不通时的自我围栏——**这几条进不了一致性套件**（要能让库坏掉）
  //
  // 对应 `persist-kysely/test/arbitration.test.ts` 的同名四条。那份实现的这两条分支
  // 各出过一次 P1，所以两边都得有人守着——一致性套件是跨实现的，验不到「库坏掉」。
  // -------------------------------------------------------------------------

  describe("lease · mongo 心跳打不通时的自我围栏", () => {
    /** 起一个「库可以故意坏掉」的租约仲裁，跑完自己收拾。 */
    const withFaulty = async (
      timings: { heartbeatMs: number; takeoverMs: number },
      body: (setup: { arbitration: ReturnType<typeof mongoArbitration>; faulty: FaultyDb }) => Promise<void>,
    ): Promise<void> => {
      const client = new MongoClient(url);
      await client.connect();
      const db = client.db(`runko_fence_${crypto.randomUUID().slice(0, 8)}`);
      await migrate(db);
      const faulty = faultyDb(db, LEASES_COLLECTION);
      try {
        await body({
          arbitration: mongoArbitration(faulty.db, { holder: "node-a", ...timings }),
          faulty,
        });
      } finally {
        await db.dropDatabase();
        await client.close();
      }
    };

    /** 等 `signal` abort，最多等 `budget` 毫秒。 */
    const waitForAbort = async (signal: AbortSignal, budget: number): Promise<void> => {
      const deadline = Date.now() + budget;
      while (!signal.aborted && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };

    it("**连接抛错、连续失败到逼近阈值 → 老持有者自己停手**，不等别人来告诉它", async () => {
      await withFaulty({ heartbeatMs: 30, takeoverMs: 150 }, async ({ arbitration, faulty }) => {
        const got = await arbitration.acquire("c1", { seedSeq: () => Promise.resolve(0) });
        expect(got.ok).toBe(true);
        if (!got.ok) {
          return;
        }

        // **库连不上了**——此后每一拍心跳都抛。不停手的话：别人在 `takeoverMs` 之后已经
        // 合法接管并开始跑，账本有令牌 CAS 挡着不会写坏，但**沙盒挡不住**，两个执行同时
        // 改同一个工作区就是互相踩文件。
        faulty.fail(Number.MAX_SAFE_INTEGER);

        await waitForAbort(got.grant.signal, 2_000);
        expect(got.grant.signal.aborted).toBe(true);
        expect(got.grant.valid).toBe(false);
      });
    });

    it("**连接挂住不返回（不是抛错）也要停手**——这一档比抛错更常见", async () => {
      await withFaulty({ heartbeatMs: 30, takeoverMs: 150 }, async ({ arbitration, faulty }) => {
        const got = await arbitration.acquire("c1", { seedSeq: () => Promise.resolve(0) });
        expect(got.ok).toBe(true);
        if (!got.ok) {
          return;
        }

        // TCP 黑洞 / 连接池耗尽 / 网络分区下的 TCP 停滞：查询**永不返回**，也永不抛。
        // 围栏判断若只写在 `catch` 里：第一拍卡在 await 上，`beating` 永远停在 true，
        // 后面每一拍都在防重入那里就 return 了，于是一次也跑不到。
        faulty.hang();

        await waitForAbort(got.grant.signal, 2_000);
        expect(got.grant.signal.aborted).toBe(true);
        expect(got.grant.valid).toBe(false);
      });
    });

    it("偶发几次失败**不算**失去归属——库恢复后照常继续", async () => {
      // 阈值很远：几拍失败远不到自我围栏的线。心跳的 catch 若写成 `lose()`，一次网络抖动
      // 就会把用户这一轮无缘无故掐断——这条守的就是那个。
      await withFaulty({ heartbeatMs: 20, takeoverMs: 5_000 }, async ({ arbitration, faulty }) => {
        const got = await arbitration.acquire("c1", { seedSeq: () => Promise.resolve(0) });
        expect(got.ok).toBe(true);
        if (!got.ok) {
          return;
        }

        // **真的注入两次失败**——不注入的话这条验的其实是「心跳正常时不会误 abort」。
        faulty.fail(2);

        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(got.grant.signal.aborted).toBe(false);
        // 库恢复之后照常取号，说明归属没丢。
        expect(await got.grant.nextSeq()).toMatchObject({ ok: true });
        await got.grant.release();
      });
    });

    it("**库坏掉时 `nextSeq` 也不抛**——契约写死了它返回结果，收尾路径没有 try 接着", async () => {
      // 阈值放很远，免得自我围栏抢在前面把这条验的东西盖掉。
      await withFaulty({ heartbeatMs: 5_000, takeoverMs: 60_000 }, async ({ arbitration, faulty }) => {
        const got = await arbitration.acquire("c1", { seedSeq: () => Promise.resolve(0) });
        expect(got.ok).toBe(true);
        if (!got.ok) {
          return;
        }

        faulty.fail(Number.MAX_SAFE_INTEGER);
        await expect(got.grant.nextSeq()).resolves.toEqual({ ok: false, reason: "lost_ownership" });
      });
    });
  });
}

// ---------------------------------------------------------------------------
// 配置校验——这条本身就是功能的一部分，不用连库
// ---------------------------------------------------------------------------

describe("mongoArbitration 的配置校验", () => {
  // `new MongoClient(url).db(name)` 不会连库（驱动是惰性连接），所以这几条不进门禁。
  const db = new MongoClient("mongodb://127.0.0.1:27017").db("unused");

  it("阈值不足心跳的 3 倍 → **构造时就抛**，不等线上误接管", () => {
    expect(() => mongoArbitration(db, { holder: "n", heartbeatMs: 10_000, takeoverMs: 20_000 })).toThrow(
      /at least 3× heartbeat/,
    );
  });

  it("刚好 3 倍是允许的", () => {
    expect(() =>
      mongoArbitration(db, { holder: "n", heartbeatMs: 10_000, takeoverMs: 30_000 }),
    ).not.toThrow();
  });

  it("默认值就是定案的 5s / 60s（12 拍）", () => {
    expect(() => mongoArbitration(db, { holder: "n" })).not.toThrow();
  });
});
