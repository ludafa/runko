/**
 * 把一致性用例接进 vitest，**每条用例一个新的 Durable Object**（`idFromName` 用唯一名），
 * 用例在对象里面跑，拿到的是真的 `ctx.storage.sql`。
 */
import type { ConformanceCase } from "@runko/conformance";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, it } from "vitest";

/** 一个全新的空对象（没有运行时，只有存储）。 */
export function freshObject(label: string): DurableObjectStub<import("../worker.js").BareObject> {
  return env.BARE.get(env.BARE.idFromName(`${label}/${crypto.randomUUID()}`));
}

export function runCasesInObject<S extends { cleanup?: () => Promise<void> | void }>(
  title: string,
  cases: readonly ConformanceCase<S>[],
  makeSetup: (state: DurableObjectState) => Promise<S>,
): void {
  describe(title, () => {
    for (const testCase of cases) {
      it(testCase.name, async () => {
        await runInDurableObject(freshObject(title), async (_instance, state) => {
          const setup = await makeSetup(state);
          try {
            await testCase.run(setup);
          } finally {
            await setup.cleanup?.();
          }
        });
      });
    }
  });
}
