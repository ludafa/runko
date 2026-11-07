/**
 * 本包仲裁自己的那几条：起轮标记落在 SQLite 上，**换一个实例 id**（对象被平台重启）之后看得见上一辈子的残留。
 *
 * 「重启」就是在同一个存储上用新的 `instanceId` 再造一个仲裁——对象被重新构造时正是这样。
 */
import { runInDurableObject } from "cloudflare:test";
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";

import type { RunkoDatabase } from "../src/index.js";
import { durableObjectArbitration, durableObjectKysely, migrateDurableObject } from "../src/index.js";
import { freshObject } from "./helpers/cases.js";

const seed = (value = 0) => ({ seedSeq: () => Promise.resolve(value) });

async function inObject(run: (db: Kysely<RunkoDatabase>) => Promise<void>): Promise<void> {
  await runInDurableObject(freshObject("arbitration"), async (_instance, state) => {
    const db = durableObjectKysely<RunkoDatabase>(state.storage.sql);
    await migrateDurableObject(db);
    await run(db);
  });
}

describe("重启之后", () => {
  it("上一辈子没放手的起轮标记，新实例的 listStale 扫得到；本实例自己的扫不到", async () => {
    await inObject(async (db) => {
      const before = durableObjectArbitration(db, { instanceId: "life-1" });
      expect((await before.acquire("c1", seed())).ok).toBe(true);
      expect(await before.listStale()).toEqual([]);

      const after = durableObjectArbitration(db, { instanceId: "life-2" });
      expect(await after.listStale()).toEqual([{ conversationId: "c1", holder: "durable-object" }]);
    });
  });

  it("放过手的不算残留", async () => {
    await inObject(async (db) => {
      const before = durableObjectArbitration(db, { instanceId: "life-1" });
      const got = await before.acquire("c1", seed());
      if (!got.ok) {
        throw new Error("should acquire");
      }
      await got.grant.release();

      const after = durableObjectArbitration(db, { instanceId: "life-2" });
      expect(await after.listStale()).toEqual([]);
    });
  });

  it("listStale → clearStale → acquire 走得通：清过就扫不到，抢得到，不报 takeover", async () => {
    await inObject(async (db) => {
      await durableObjectArbitration(db, { instanceId: "life-1" }).acquire("c1", seed());
      const after = durableObjectArbitration(db, { instanceId: "life-2" });

      await after.clearStale("c1");
      expect(await after.listStale()).toEqual([]);
      const again = await after.acquire("c1", seed());
      expect(again.ok).toBe(true);
      expect(again.ok && again.takeover).toBeUndefined();
    });
  });

  it("不清直接抢：抢得到，并报 takeover——轮编排据此给上一辈子那一轮补「已停止」", async () => {
    await inObject(async (db) => {
      await durableObjectArbitration(db, { instanceId: "life-1", holder: "old-life" }).acquire("c1", seed());
      const after = durableObjectArbitration(db, { instanceId: "life-2" });

      const again = await after.acquire("c1", seed());
      expect(again.ok).toBe(true);
      expect(again.ok && again.takeover).toEqual({ holder: "old-life" });
      expect(await after.listStale()).toEqual([]);
    });
  });

  it("clearStale 不碰本实例正持有的标记", async () => {
    await inObject(async (db) => {
      const arbitration = durableObjectArbitration(db, { instanceId: "life-1" });
      await arbitration.acquire("c1", seed());
      await arbitration.clearStale("c1");
      expect(await durableObjectArbitration(db, { instanceId: "life-2" }).listStale()).toHaveLength(1);
    });
  });

  it("水位不跨实例：新实例第一次抢占从 seedSeq（账本）重新播种", async () => {
    await inObject(async (db) => {
      const before = durableObjectArbitration(db, { instanceId: "life-1" });
      const first = await before.acquire("c1", seed(0));
      if (!first.ok) {
        throw new Error("should acquire");
      }
      expect(await first.grant.nextSeq()).toEqual({ ok: true, seq: 1 });

      const after = durableObjectArbitration(db, { instanceId: "life-2" });
      const second = await after.acquire("c1", seed(5));
      expect(second.ok && (await second.grant.nextSeq())).toEqual({ ok: true, seq: 6 });
    });
  });
});

describe("待接手标记", () => {
  it("打上之后进回捞名单；有人持有时不在名单里；撤掉就没了", async () => {
    await inObject(async (db) => {
      const arbitration = durableObjectArbitration(db);
      await arbitration.markAwaitingTakeover?.("c1");
      await arbitration.markAwaitingTakeover?.("c2");
      expect(await arbitration.listSweepCandidates?.({ limit: 10 })).toEqual(["c1", "c2"]);
      expect(await arbitration.listSweepCandidates?.({ limit: 1 })).toEqual(["c1"]);

      const held = await arbitration.acquire("c1", seed());
      expect(await arbitration.listSweepCandidates?.({ limit: 10 })).toEqual(["c2"]);
      if (held.ok) {
        await held.grant.release();
      }
      // 放手不撤标记：撤不撤由轮编排决定（推过了才撤）。名单的先后不是契约，按集合比。
      expect((await arbitration.listSweepCandidates?.({ limit: 10 }))?.sort()).toEqual(["c1", "c2"]);

      await arbitration.clearAwaitingTakeover?.("c1");
      await arbitration.clearAwaitingTakeover?.("c2");
      expect(await arbitration.listSweepCandidates?.({ limit: 10 })).toEqual([]);
    });
  });

  it("标记跨实例还在：重启后的新实例照样回捞得到", async () => {
    await inObject(async (db) => {
      await durableObjectArbitration(db, { instanceId: "life-1" }).markAwaitingTakeover?.("c1");
      const after = durableObjectArbitration(db, { instanceId: "life-2" });
      expect(await after.listSweepCandidates?.({ limit: 10 })).toEqual(["c1"]);
    });
  });
});

describe("同一个实例里的并发", () => {
  it("同时抢同一个会话，只有一个赢", async () => {
    await inObject(async (db) => {
      const arbitration = durableObjectArbitration(db);
      const results = await Promise.all([arbitration.acquire("c1", seed()), arbitration.acquire("c1", seed())]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
    });
  });

  it("放手后马上被重新抢到：上一次的「清标记」不会擦掉这一次刚写的标记", async () => {
    await inObject(async (db) => {
      const arbitration = durableObjectArbitration(db, { instanceId: "life-1" });
      const first = await arbitration.acquire("c1", seed());
      if (!first.ok) {
        throw new Error("should acquire");
      }
      // 不等放手落库就去抢：内存里已经放了，这次抢占会成功。
      const releasing = first.grant.release();
      const second = await arbitration.acquire("c1", seed());
      await releasing;
      expect(second.ok).toBe(true);

      // 第二次那条标记还在——重启后扫得到它。
      expect(await durableObjectArbitration(db, { instanceId: "life-2" }).listStale()).toEqual([
        { conversationId: "c1", holder: "durable-object" },
      ]);
    });
  });
});
