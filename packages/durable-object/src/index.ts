/**
 * `@runko/durable-object`——让 `@runko/agent` 的运行时跑在 Cloudflare Durable Object 里。
 *
 * 一个会话一个对象：账本、待发队列、裁决表都存在对象自带的 SQLite（`ctx.storage.sql`）里，
 * 轮也在对象里跑。四样东西：
 *
 * - `createDurableObjectRuntime(ctx, options)`：在 DO 构造函数里调的那一行装配；
 * - `durableObjectKysely(sql)`：`ctx.storage.sql` 上的 Kysely 实例（方言 `DurableObjectSqliteDialect`）；
 * - `durableObjectArbitration(db)`：起轮标记落 SQLite 的归属仲裁，对象重启后 `recover()` 才扫得到残留；
 * - `framesToStream` / `readFrames`：跨 RPC 传直播帧。
 *
 * 本包不 import 任何 Cloudflare 运行时模块，`ctx` 只按结构使用。
 */
export const RUNKO_DURABLE_OBJECT_VERSION = "0.0.0" as const;

export type { DurableObjectSqliteDialectConfig, SqlStorageCursorLike, SqlStorageLike } from "./dialect.js";
export { DurableObjectSqliteDialect, durableObjectKysely } from "./dialect.js";
export type { DurableObjectArbitrationOptions } from "./arbitration.js";
export { DEFAULT_DURABLE_OBJECT_HOLDER, durableObjectArbitration } from "./arbitration.js";
export type { OwnershipTable, OwnershipTables } from "./migrate.js";
export { migrateDurableObject, OWNERSHIP_TABLE } from "./migrate.js";
export type { DurableObjectRuntime, DurableObjectRuntimeOptions, DurableObjectStateLike } from "./runtime.js";
export { createDurableObjectRuntime } from "./runtime.js";
export type { FramesToStreamOptions } from "./frames.js";
export { framesToStream, readFrames } from "./frames.js";

export type { RunkoDatabase } from "@runko/persist-kysely";
