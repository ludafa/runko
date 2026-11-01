/**
 * [节点登记表](../../../docs/terms.md)——[指定交接](../../../docs/terms.md)挑接手节点用的。
 *
 * 每个节点启动时登记、定时刷新一行：地址、[发布序号](../../../docs/terms.md)、状态、心跳时刻。
 * **它只用来挑候选**：登记表一定有时差（同一批下线的节点收到 SIGTERM 的时刻也不一致），接不接
 * 由被挑中的节点看自己内存里的状态决定（交权 · 技术方案 docs/logic/orchestration/tech/handover.md §7）。
 *
 * 它是一样可选的宿主能力。不给它就挑不到接手节点：仲裁机制支持[待接手](../../../docs/terms.md)标记时，
 * 对话打上标记等人接；不支持时，在干活的轮照旧[中止](../../../docs/terms.md)（交权 · 技术方案 §10.4）。
 */

/** 登记表里的一行。 */
export interface NodeRecord {
  /** 节点地址，同租约里的 `holder`（`Grant.holder`）。 */
  node: string;
  /** [发布序号](../../../docs/terms.md)：每次发布递增，回滚也递增。框架只比大小。 */
  releaseSeq: number;
  /** `leaving` = 这个节点在[节点下线](../../../docs/terms.md)。 */
  state: "ready" | "leaving";
  heartbeatAt: number;
  startedAt: number;
}

/** 一个候选接手节点。`load` = 它此刻持有几份对话（同一档里挑最轻的）。 */
export interface NodeCandidate extends NodeRecord {
  load: number;
}

export interface NodeSelf {
  node: string;
  releaseSeq: number;
}

export interface NodeRegistry {
  /** 登记自己：状态 `ready`、心跳与启动时刻都记成现在。重复调用会把状态改回 `ready`（重新上线）。 */
  register(self: NodeSelf): Promise<void>;
  /** 刷新心跳。只动心跳，不动状态——`leaving` 的节点照样要续，好让别人知道它还活着。 */
  heartbeat(node: string): Promise<void>;
  /** 标成 `leaving`。收到 SIGTERM 之后的**第一件事**。 */
  markLeaving(node: string): Promise<void>;
  /** 删掉自己那一行（进程退出前）。 */
  remove(node: string): Promise<void>;
  /**
   * 按交权 · 技术方案 §7.2 的顺序排好的候选，**不含自己**，只要 `ready` 且心跳在 `freshMs` 之内的：
   *
   * 1. 发布序号比 `self` 大的——同一批下线的节点序号相同，所以这一档不可能挑中同批节点；
   * 2. 发布序号与 `self` 相同的；
   *
   * 更小的不要（那是还没被替换的旧版本，交给它等于再迁一次）。同一档里按 `load` 升序。
   */
  candidates(self: NodeSelf, opts: { freshMs: number }): Promise<NodeCandidate[]>;
  /** 全部行（观测用，比如集群控制台）。 */
  list(): Promise<NodeRecord[]>;
}
