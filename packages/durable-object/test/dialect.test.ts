/**
 * 方言在真的 `ctx.storage.sql` 上的行为。重点是**影响行数要准**：persist-kysely 靠「条件写 + 看影响行数」
 * 保证正确性，而游标的 `rowsWritten` 把索引写入也算进去，不能拿来当影响行数。
 */
import { runInDurableObject } from "cloudflare:test";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";

import { durableObjectKysely } from "../src/index.js";
import { freshObject } from "./helpers/cases.js";

interface Db {
  items: { owner: string; seq: number; label: string | null };
}

/** 一张带复合主键、外加一个二级索引的表——rowsWritten 与真实影响行数在这种表上对不上。 */
async function itemsTable(state: DurableObjectState) {
  const db = durableObjectKysely<Db>(state.storage.sql);
  await db.schema
    .createTable("items")
    .addColumn("owner", "varchar(255)", (c) => c.notNull())
    .addColumn("seq", "integer", (c) => c.notNull())
    .addColumn("label", "text")
    .addPrimaryKeyConstraint("items_pk", ["owner", "seq"])
    .execute();
  await db.schema.createIndex("items_label").on("items").column("label").execute();
  return db;
}

describe("影响行数", () => {
  it("带主键和索引的表上 UPDATE 一行 → numUpdatedRows 是 1（同一条语句的 rowsWritten 不是）", async () => {
    await runInDurableObject(freshObject("dialect"), async (_instance, state) => {
      const db = await itemsTable(state);
      await db.insertInto("items").values([
        { owner: "a", seq: 1, label: "x" },
        { owner: "a", seq: 2, label: "y" },
      ]).execute();

      const updated = await db.updateTable("items").set({ label: "z" }).where("owner", "=", "a").where("seq", "=", 1).executeTakeFirst();
      expect(updated.numUpdatedRows).toBe(1n);

      // 同一种语句直接走 `sql.exec` 看游标：它报的 rowsWritten 把索引那一次也算上了。
      const raw = state.storage.sql.exec("UPDATE items SET label = ? WHERE owner = ? AND seq = ?", "w", "a", 1);
      raw.toArray();
      expect(raw.rowsWritten).toBeGreaterThan(1);
    });
  });

  it("UPDATE 多行 / 没匹配到 / 值没变，各自报对", async () => {
    await runInDurableObject(freshObject("dialect"), async (_instance, state) => {
      const db = await itemsTable(state);
      await db.insertInto("items").values([
        { owner: "a", seq: 1, label: "x" },
        { owner: "a", seq: 2, label: "y" },
      ]).execute();

      expect((await db.updateTable("items").set({ label: "q" }).where("owner", "=", "a").executeTakeFirst()).numUpdatedRows).toBe(2n);
      expect((await db.updateTable("items").set({ label: "q" }).where("owner", "=", "nobody").executeTakeFirst()).numUpdatedRows).toBe(0n);
      // SQLite 把「写了同样的值」也算一次改动——与 better-sqlite3 那一档一致。
      expect((await db.updateTable("items").set({ label: "q" }).where("seq", "=", 1).executeTakeFirst()).numUpdatedRows).toBe(1n);
    });
  });

  it("INSERT 报插入行数与 insertId；ON CONFLICT DO NOTHING 撞键时报 0", async () => {
    await runInDurableObject(freshObject("dialect"), async (_instance, state) => {
      const db = await itemsTable(state);
      const inserted = await db.insertInto("items").values({ owner: "a", seq: 1, label: "x" }).executeTakeFirst();
      expect(inserted.numInsertedOrUpdatedRows).toBe(1n);
      expect(inserted.insertId).toBe(1n);

      const ignored = await db
        .insertInto("items")
        .values({ owner: "a", seq: 1, label: "other" })
        .onConflict((oc) => oc.columns(["owner", "seq"]).doNothing())
        .executeTakeFirst();
      expect(ignored.numInsertedOrUpdatedRows).toBe(0n);
    });
  });

  it("DELETE 报删除行数", async () => {
    await runInDurableObject(freshObject("dialect"), async (_instance, state) => {
      const db = await itemsTable(state);
      await db.insertInto("items").values([
        { owner: "a", seq: 1, label: "x" },
        { owner: "a", seq: 2, label: "y" },
        { owner: "b", seq: 1, label: "y" },
      ]).execute();
      expect((await db.deleteFrom("items").where("owner", "=", "a").executeTakeFirst()).numDeletedRows).toBe(2n);
      expect((await db.deleteFrom("items").where("owner", "=", "a").executeTakeFirst()).numDeletedRows).toBe(0n);
    });
  });

  it("手写的写语句也报；建表这类语句不报（`changes()` 对它们是上一条写语句的旧值）", async () => {
    await runInDurableObject(freshObject("dialect"), async (_instance, state) => {
      const db = await itemsTable(state);
      await db.insertInto("items").values({ owner: "a", seq: 1, label: "x" }).execute();
      const raw = await sql`UPDATE items SET label = ${"y"} WHERE owner = ${"a"}`.execute(db);
      expect(raw.numAffectedRows).toBe(1n);

      const ddl = await sql`CREATE TABLE IF NOT EXISTS other (x integer)`.execute(db);
      expect(ddl.numAffectedRows).toBeUndefined();
    });
  });
});

describe("参数", () => {
  it("boolean 存成 1/0（DO SQL 原样绑会变成字符串 \"true\"）", async () => {
    await runInDurableObject(freshObject("dialect"), async (_instance, state) => {
      const db = durableObjectKysely(state.storage.sql);
      const result = await sql<{ yes: unknown; no: unknown }>`SELECT ${true} AS yes, ${false} AS no`.execute(db);
      expect(result.rows).toEqual([{ yes: 1, no: 0 }]);
    });
  });

  it("安全范围内的 bigint 换成 number；超出范围当场抛，不静默丢精度", async () => {
    await runInDurableObject(freshObject("dialect"), async (_instance, state) => {
      const db = durableObjectKysely(state.storage.sql);
      const result = await sql<{ v: unknown }>`SELECT ${42n} AS v`.execute(db);
      expect(result.rows).toEqual([{ v: 42 }]);
      await expect(sql`SELECT ${2n ** 60n} AS v`.execute(db)).rejects.toThrow(RangeError);
    });
  });

  it("字节原样存成 blob；Date 当场抛（DO SQL 会把它绑成 toString() 的那串英文）", async () => {
    await runInDurableObject(freshObject("dialect"), async (_instance, state) => {
      const db = durableObjectKysely(state.storage.sql);
      const blob = await sql<{ t: unknown }>`SELECT typeof(${new Uint8Array([1, 2, 3])}) AS t`.execute(db);
      expect(blob.rows).toEqual([{ t: "blob" }]);
      await expect(sql`SELECT ${new Date(0)} AS v`.execute(db)).rejects.toThrow(/Date/);
    });
  });
});

describe("不支持的能力说清楚", () => {
  it("事务直接报错，并指向 ctx.storage.transactionSync", async () => {
    await runInDurableObject(freshObject("dialect"), async (_instance, state) => {
      const db = await itemsTable(state);
      await expect(
        db.transaction().execute(async (trx) => {
          await trx.insertInto("items").values({ owner: "a", seq: 1, label: null }).execute();
        }),
      ).rejects.toThrow(/transactionSync/);
      // 没开成事务，也就什么都没写。
      expect(await db.selectFrom("items").selectAll().execute()).toEqual([]);
    });
  });

  it("流式查询直接报错", async () => {
    await runInDurableObject(freshObject("dialect"), async (_instance, state) => {
      const db = await itemsTable(state);
      const iterate = async (): Promise<void> => {
        for await (const row of db.selectFrom("items").selectAll().stream()) {
          void row;
        }
      };
      await expect(iterate()).rejects.toThrow(/streaming/);
    });
  });
});
