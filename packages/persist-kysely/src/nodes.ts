/**
 * **[节点登记表](../../../docs/terms.md)的 Kysely 实现**——[指定交接](../../../docs/terms.md)
 * 挑接手节点用。语义见 `@runko/agent` 的 `NodeRegistry` 接口注释，这里只是落地。
 *
 * ⚠️ **`candidates()` 的排序逻辑与 `@runko/persist-mongo/src/nodes.ts` 有一份刻意的复制，
 * 改一处必须同步另一处。** 理由同 `arbitration.ts` 文件头：为几十行排序代码开一个公共包
 * 不划算，让 Mongo 依赖 Kysely 又会拖垮它「不是薄壳」的定位。
 */
import type { NodeCandidate, NodeRecord, NodeRegistry, NodeSelf } from "@runko/agent";
import type { Kysely } from "kysely";

import type { Flavor, FlavorTraits } from "./flavor.js";
import { toNumber, traitsOf } from "./flavor.js";
import { insertOrIgnore } from "./idempotent-insert.js";
import type { NodesTable, RunkoDatabase } from "./schema.js";
import { LEASES_TABLE, NODES_TABLE } from "./schema.js";

export interface NodeRegistryOptions {
  /** 与 `leaseArbitration`/`kyselyPersistence` 同款：给方言名，或已经手上有一份 `FlavorTraits`。 */
  flavor: Flavor | FlavorTraits;
  /** 让测试能控制时间；缺省 `Date.now`。 */
  now?: () => number;
}

/**
 * 建一个节点登记表。
 *
 * ```ts
 * const registry = nodeRegistry(db, { flavor: "postgres" });
 * await registry.register({ node: process.env.RUNKO_NODE_URL, releaseSeq: Number(process.env.RUNKO_RELEASE_SEQ) });
 * ```
 */
export function nodeRegistry(db: Kysely<RunkoDatabase>, opts: NodeRegistryOptions): NodeRegistry {
  const traits = typeof opts.flavor === "string" ? traitsOf(opts.flavor) : opts.flavor;
  const now = opts.now ?? Date.now;

  const toRecord = (row: NodesTable): NodeRecord => ({
    node: row.node,
    releaseSeq: toNumber(row.release_seq),
    state: row.state === "leaving" ? "leaving" : "ready",
    heartbeatAt: toNumber(row.heartbeat_at),
    startedAt: toNumber(row.started_at),
  });

  return {
    async register(self: NodeSelf): Promise<void> {
      const at = now();
      // 幂等插入只覆盖「第一次见到这个节点」那一支；已经登记过的行需要显式 UPDATE
      // 才能把状态改回 `ready`（重新上线）、把心跳与启动时刻刷成现在。
      await insertOrIgnore(
        traits,
        db.insertInto(NODES_TABLE).values({
          node: self.node,
          release_seq: self.releaseSeq,
          state: "ready",
          heartbeat_at: at,
          started_at: at,
        }),
        ["node"],
      ).execute();
      await db
        .updateTable(NODES_TABLE)
        .set({ release_seq: self.releaseSeq, state: "ready", heartbeat_at: at, started_at: at })
        .where("node", "=", self.node)
        .execute();
    },

    async heartbeat(node: string): Promise<void> {
      // 只动心跳，不动状态——下线中的节点照样要续，好让别人知道它还活着。
      await db.updateTable(NODES_TABLE).set({ heartbeat_at: now() }).where("node", "=", node).execute();
    },

    async markLeaving(node: string): Promise<void> {
      await db.updateTable(NODES_TABLE).set({ state: "leaving" }).where("node", "=", node).execute();
    },

    async remove(node: string): Promise<void> {
      await db.deleteFrom(NODES_TABLE).where("node", "=", node).execute();
    },

    async candidates(self: NodeSelf, candOpts: { freshMs: number }): Promise<NodeCandidate[]> {
      const at = now();
      const rows = await db
        .selectFrom(NODES_TABLE)
        .selectAll()
        .where("node", "<>", self.node)
        .where("state", "=", "ready")
        .where("heartbeat_at", ">=", at - candOpts.freshMs)
        // 更小的发布序号不要：那是还没被替换的旧版本，交给它等于再迁一次。
        .where("release_seq", ">=", self.releaseSeq)
        .execute();

      // `load` = 这个节点此刻在 `agent_leases` 里持有几份对话（令牌非空的行）。
      const loadRows = await db.selectFrom(LEASES_TABLE).select(["holder"]).where("holder", "is not", null).execute();
      const loadByHolder = new Map<string, number>();
      for (const row of loadRows) {
        if (row.holder === null) {continue;}
        loadByHolder.set(row.holder, (loadByHolder.get(row.holder) ?? 0) + 1);
      }

      const candidates: NodeCandidate[] = rows.map((row) => ({
        ...toRecord(row),
        load: loadByHolder.get(row.node) ?? 0,
      }));

      // 两档：发布序号严格大于 self 的在前，等于的在后（更小的已经被 WHERE 排除）；
      // 同档按 load 升序，load 相同再按 node 升序——保证结果确定，不依赖查询返回的顺序。
      candidates.sort((a, b) => {
        const aTier = a.releaseSeq > self.releaseSeq ? 0 : 1;
        const bTier = b.releaseSeq > self.releaseSeq ? 0 : 1;
        if (aTier !== bTier) {return aTier - bTier;}
        if (a.load !== b.load) {return a.load - b.load;}
        return a.node < b.node ? -1 : a.node > b.node ? 1 : 0;
      });
      return candidates;
    },

    async list(): Promise<NodeRecord[]> {
      const rows = await db.selectFrom(NODES_TABLE).selectAll().execute();
      return rows.map(toRecord);
    },
  };
}
