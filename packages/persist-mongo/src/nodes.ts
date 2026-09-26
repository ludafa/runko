/**
 * **[节点登记表](../../../docs/terms.md)的 MongoDB 实现**——语义与 Kysely 那一档一致，
 * 见 `@runko/persist-kysely/src/nodes.ts`（那份文件头说明了为什么排序逻辑是刻意复制的）。
 */
import type { NodeCandidate, NodeRecord, NodeRegistry, NodeSelf } from "@runko/agent";
import type { Collection, Db } from "mongodb";

import type { LeaseDoc, NodeDoc } from "./collections.js";
import { LEASES_COLLECTION, NODES_COLLECTION } from "./collections.js";

export interface MongoNodeRegistryOptions {
  /** 让测试能控制时间；缺省 `Date.now`。 */
  now?: () => number;
}

/**
 * 建一个节点登记表，交给 runtime 用。
 *
 * ```ts
 * createAgentRuntime({
 *   // ...
 *   handover: {
 *     node: process.env.RUNKO_NODE_URL,
 *     releaseSeq: Number(process.env.RUNKO_RELEASE_SEQ), // 发布序号：每次发布递增，回滚也递增
 *     nodes: mongoNodeRegistry(db),
 *   },
 * });
 * ```
 *
 * 登记和心跳由 runtime 自己做，不用手动调 `register`。
 */
export function mongoNodeRegistry(db: Db, opts: MongoNodeRegistryOptions = {}): NodeRegistry {
  const now = opts.now ?? Date.now;
  const col: Collection<NodeDoc> = db.collection<NodeDoc>(NODES_COLLECTION);
  const leases: Collection<LeaseDoc> = db.collection<LeaseDoc>(LEASES_COLLECTION);

  const toRecord = (doc: NodeDoc): NodeRecord => ({
    node: doc._id,
    releaseSeq: doc.releaseSeq,
    state: doc.state === "leaving" ? "leaving" : "ready",
    heartbeatAt: doc.heartbeatAt,
    startedAt: doc.startedAt,
  });

  return {
    async register(self: NodeSelf): Promise<void> {
      const at = now();
      await col.updateOne(
        { _id: self.node },
        { $set: { releaseSeq: self.releaseSeq, state: "ready", heartbeatAt: at, startedAt: at } },
        { upsert: true },
      );
    },

    async heartbeat(node: string): Promise<void> {
      // 只动心跳，不动状态。处于节点下线（`leaving`）的节点照样要续，好让别人知道它还活着。
      await col.updateOne({ _id: node }, { $set: { heartbeatAt: now() } });
    },

    async markLeaving(node: string): Promise<void> {
      await col.updateOne({ _id: node }, { $set: { state: "leaving" } });
    },

    async remove(node: string): Promise<void> {
      await col.deleteOne({ _id: node });
    },

    async candidates(self: NodeSelf, candOpts: { freshMs: number }): Promise<NodeCandidate[]> {
      const at = now();
      const docs = await col
        .find({
          _id: { $ne: self.node },
          state: "ready",
          heartbeatAt: { $gte: at - candOpts.freshMs },
          // 更小的发布序号不要：那是还没被替换的旧版本，交给它等于再迁一次。
          releaseSeq: { $gte: self.releaseSeq },
        })
        .toArray();

      // `load` = 这个节点此刻在 `agent_leases` 里持有几份对话（`holder` 非空的文档）。
      const loadDocs = await leases.find({ holder: { $ne: null } }, { projection: { holder: 1 } }).toArray();
      const loadByHolder = new Map<string, number>();
      for (const doc of loadDocs) {
        if (doc.holder === null) {continue;}
        loadByHolder.set(doc.holder, (loadByHolder.get(doc.holder) ?? 0) + 1);
      }

      const candidates: NodeCandidate[] = docs.map((doc) => ({
        ...toRecord(doc),
        load: loadByHolder.get(doc._id) ?? 0,
      }));

      // 两档：发布序号严格大于 self 的在前，等于的在后（更小的已经被查询排除）；
      // 同档按 load 升序，load 相同再按 node 升序——保证结果确定，不依赖返回顺序。
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
      const docs = await col.find({}).toArray();
      return docs.map(toRecord);
    },
  };
}
