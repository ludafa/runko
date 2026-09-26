/**
 * 内置的**平凡[节点登记表](../../../../docs/terms.md)**：进程内一个 Map。
 *
 * 单进程部署用不上它（没有别的节点可交）。它的用处是**在一个进程里模拟多个节点**——几个
 * runtime 共用同一个实例，就像共用同一张登记表——以及当测试替身。真多节点要换成落库的实现
 * （`@runko/persist-kysely` 的 `nodeRegistry`）。
 *
 * `load` 由调用方给：进程内没有租约表可数，传一个「这个节点此刻持有几份对话」的函数进来。
 */
import type { NodeCandidate, NodeRecord, NodeRegistry, NodeSelf } from "../nodes.js";

export interface MemoryNodeRegistryOptions {
  /** 让测试能控制时间；缺省 `Date.now`。 */
  now?: () => number;
  /** 某个节点此刻持有几份对话。缺省恒为 0。 */
  loadOf?: (node: string) => number;
}

export function memoryNodeRegistry(opts: MemoryNodeRegistryOptions = {}): NodeRegistry {
  const now = opts.now ?? Date.now;
  const loadOf = opts.loadOf ?? (() => 0);
  const rows = new Map<string, NodeRecord>();

  return {
    register(self: NodeSelf): Promise<void> {
      const at = now();
      rows.set(self.node, { node: self.node, releaseSeq: self.releaseSeq, state: "ready", heartbeatAt: at, startedAt: at });
      return Promise.resolve();
    },
    heartbeat(node: string): Promise<void> {
      const row = rows.get(node);
      if (row !== undefined) {rows.set(node, { ...row, heartbeatAt: now() });}
      return Promise.resolve();
    },
    markLeaving(node: string): Promise<void> {
      const row = rows.get(node);
      if (row !== undefined) {rows.set(node, { ...row, state: "leaving" });}
      return Promise.resolve();
    },
    remove(node: string): Promise<void> {
      rows.delete(node);
      return Promise.resolve();
    },
    candidates(self: NodeSelf, { freshMs }: { freshMs: number }): Promise<NodeCandidate[]> {
      const at = now();
      const eligible = [...rows.values()]
        .filter((row) => row.node !== self.node && row.state === "ready" && at - row.heartbeatAt <= freshMs && row.releaseSeq >= self.releaseSeq)
        .map((row) => ({ ...row, load: loadOf(row.node) }));
      const tier = (row: NodeCandidate): number => (row.releaseSeq > self.releaseSeq ? 0 : 1);
      eligible.sort((a, b) => tier(a) - tier(b) || a.load - b.load || (a.node < b.node ? -1 : a.node > b.node ? 1 : 0));
      return Promise.resolve(eligible);
    },
    list(): Promise<NodeRecord[]> {
      return Promise.resolve([...rows.values()].map((row) => ({ ...row })));
    },
  };
}
