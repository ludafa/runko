/**
 * 薄壳的**租约版[归属仲裁机制](../../../docs/terms.md)**出口：验的是「装配没接错」。
 *
 * 具体是哪一条风险：`sqlitePersistence(db)` 与 `sqliteArbitration(db)` 各建一个 Kysely
 * 实例，接错了就会出现「[账本](../../../docs/terms.md)写在这边、租约写在那边」——两边
 * 各自都能跑绿，合起来就是取号取到别人的水位。一致性套件里「取号从 `seedSeq` 播种」
 * 那几条会当场撞上，所以这里把三组全接上，而不是只做一次冒烟。
 *
 * SQLite 这一档零外部依赖，全跑是白捡的覆盖。语义本身归 `@runko/persist-kysely`。
 */
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
import { describe, expect, it } from "vitest";

import { migrate, sqliteArbitration, sqlitePersistence } from "../src/index.js";

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
 * 两个「节点」共享同一个驱动实例，`holder` 不同。
 *
 * **心跳 40ms / 判死 200ms**（仍满足「阈值 ≥ 3× 心跳」那条硬规矩）：默认的 5s/60s 会让
 * 「心跳自己发现被接管」那条用例等一分钟。语义不变，只是把时间轴压扁。
 *
 * `expire` **把持有者那一侧的时钟停在过去**，不是只把 `heartbeat_at` 拨旧——持有者还
 * 活着，它的下一拍心跳会把时刻刷回来，接管于是随机失败。冻住时钟之后它爱跳多少拍都
 * 写不出一个「新鲜」的时刻。
 */
async function setupFor(): Promise<TakeoverConformanceSetup> {
  const db = new Database(":memory:");
  await migrate(db);
  const timings = { heartbeatMs: 40, takeoverMs: 200 };

  let holderSkew = 0;
  const holderNow = (): number => Date.now() - holderSkew;

  return {
    arbitration: sqliteArbitration(db, { holder: "node-a", now: holderNow, ...timings }),
    other: sqliteArbitration(db, { holder: "node-b", ...timings }),
    expire: (conversationId: string): Promise<void> => {
      holderSkew = timings.takeoverMs * 10;
      db.prepare("UPDATE agent_leases SET heartbeat_at = ? WHERE conversation_id = ?").run(holderNow(), conversationId);
      return Promise.resolve();
    },
    cleanup: () => {
      db.close();
    },
  };
}

runCases<ArbitrationConformanceSetup>("persist-sqlite 仲裁 · 通用", arbitrationCases, setupFor);
runCases<MultiNodeConformanceSetup>("persist-sqlite 仲裁 · 多节点", arbitrationMultiNodeCases, setupFor);
runCases<TakeoverConformanceSetup>("persist-sqlite 仲裁 · 超时接管", arbitrationTakeoverCases, setupFor);

describe("persist-sqlite 仲裁的装配", () => {
  it("租约与账本落在同一个库——取号从账本水位接着数，不从 0 重来", async () => {
    const db = new Database(":memory:");
    await migrate(db);
    const persistence = sqlitePersistence(db);
    // 账本里先有两条：水位是 2。
    for (const seq of [1, 2]) {
      await persistence.ledger.append({
        conversationId: "c1",
        seq,
        message: { id: `m${String(seq)}`, role: "user", parts: [{ type: "text", text: "喂" }] },
        ts: seq,
      });
    }

    const arbitration = sqliteArbitration(db, { holder: "node-a" });
    const acquired = await arbitration.acquire("c1", { seedSeq: () => persistence.ledger.maxSeq("c1") });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) {return;}
    // 接错库的话这里会是 1——那正是「账本写这边、租约写那边」的症状。
    expect(await acquired.grant.nextSeq()).toEqual({ ok: true, seq: 3 });
    await acquired.grant.release();
    db.close();
  });

  it("阈值配得比心跳的三倍还短 → 构造时当场抛，不等线上误接管", async () => {
    const db = new Database(":memory:");
    await migrate(db);
    expect(() => sqliteArbitration(db, { holder: "node-a", heartbeatMs: 100, takeoverMs: 200 })).toThrow(
      /at least 3/,
    );
    db.close();
  });
});
