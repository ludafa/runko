/**
 * 一致性套件跑在真的 workerd 里、真的 `ctx.storage.sql` 上：持久化与工具收尾走本包的方言，
 * 归属仲裁走 `durableObjectArbitration`。
 *
 * 仲裁只接通用那一组。多节点、超时接管、同名重启那几组都假设「同一个后端上有第二个活着的节点」，
 * DO 没有第二个节点；本包自己的重启判据在 arbitration.test.ts 里单独验。
 */
import type {
  ArbitrationConformanceSetup,
  PersistenceConformanceSetup,
  ToolTailConformanceSetup,
} from "@runko/conformance";
import { arbitrationCases, persistenceCases, toolTailCases } from "@runko/conformance";
import { kyselyPersistence } from "@runko/persist-kysely";

import type { RunkoDatabase } from "../src/index.js";
import { durableObjectArbitration, durableObjectKysely, migrateDurableObject } from "../src/index.js";
import { runCasesInObject } from "./helpers/cases.js";

async function migratedDb(state: DurableObjectState) {
  const db = durableObjectKysely<RunkoDatabase>(state.storage.sql);
  await migrateDurableObject(db);
  return db;
}

runCasesInObject<PersistenceConformanceSetup>("持久化 · DO SQLite", persistenceCases, async (state) => ({
  persistence: kyselyPersistence(await migratedDb(state), { flavor: "sqlite" }),
}));

runCasesInObject<ToolTailConformanceSetup>("工具收尾 · DO SQLite", toolTailCases, async (state) => {
  const tails = kyselyPersistence(await migratedDb(state), { flavor: "sqlite" }).tails;
  if (tails === undefined) {
    throw new Error("kyselyPersistence should expose tool tails");
  }
  return { tails };
});

runCasesInObject<ArbitrationConformanceSetup>("归属仲裁 · 通用", arbitrationCases, async (state) => ({
  arbitration: durableObjectArbitration(await migratedDb(state)),
}));
