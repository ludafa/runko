/**
 * 宿主能力之一：**[归属仲裁机制](../../../docs/terms.md)**
 * （[技术方案](../../../docs/logic/arbitration/tech/arbitration-impl.md)）。
 *
 * **它是装饰器，不是基础设施**——把记录的写入包起来，让[轮编排](../../../docs/terms.md)
 * 可以假装自己是单线程的。由此推出两条很强的约束：
 *
 * - **轮编排不该知道「[租期标识](../../../docs/terms.md)」这个词。** 它只该知道「我有
 *   独占权」（拿到 `Grant`）和「我失去了独占权」（`grant.signal` abort / `nextSeq`
 *   报 `lost_ownership`）。所以本文件里一个 token 字段都没有。
 * - **持久化接口完全不认识「租约」。** 正因如此 Durable Object 的 KV 存储也接得进来
 *   ——它根本没有租约表。
 *
 * 三种实现（本包只带第一种，另两种在 `@runko/persist-*` / `@runko/durable-object`）：
 *
 * |            | 单进程 | 多进程共享 DB | Cloudflare DO |
 * |---|---|---|---|
 * | 怎么实现   | 内存里一个 Map | 租约 + 心跳 + 令牌 | 什么都不做 |
 * | 独占的级别 | **真保证** | **尽力 + 可检测** | **真保证** |
 */

/** 起轮时框架告诉仲裁机制的那点上下文。 */
export interface AcquireContext {
  /**
   * 这个会话[账本](../../../docs/terms.md)当前的水位——**内存版据此初始化自己的 seq
   * 计数器**（进程重启后内存表是空的，第一次抢占必须回库里问一次）。租约版直接读
   * 租约行上的水位，不会调它。**惰性**：抢不到归属时不该白查一次库。
   */
  seedSeq: () => Promise<number>;
}

/**
 * 这次抢占**顶掉了一个过期的持有者**——它的[租约](../../../docs/terms.md)还挂着、只是太久没续。
 *
 * 那说明上一轮没有正常收尾：持有者要么崩了，要么被冻住、此后一写就会被拒。两种情况下它那一轮
 * 在[账本](../../../docs/terms.md)里都不会再有收尾，所以[轮编排](../../../docs/terms.md)据此补一条
 * 「已停止」标记。**只报「顶掉了谁」，不报令牌**——本文件的约束一不变。
 *
 * 为什么不能只靠启动扫描（`recover()`）补：多副本下常常是**别的副本先接手**，接手时租约行被覆盖，
 * 此后谁重启都扫不到它了。
 */
export interface Takeover {
  /** 被顶掉的那个持有者（不透明字符串，与 `Grant.holder` 同源）。 */
  holder?: string;
}

/** 抢归属的结果。`busy` 时带上 `holder`，[接入层](../../../docs/terms.md)据它决定转发给谁。 */
export type AcquireResult =
  | {
      ok: true;
      grant: Grant;
      /**
       * 顶掉了过期持有者时才有。内存版与 Durable Object 永远不带（进程内与平台保证单实例下
       * 不存在「过期的持有者」）。可选字段：不报它的实现照常能用，只是崩溃那一轮少一条收尾。
       */
      takeover?: Takeover;
    }
  | { ok: false; reason: "busy"; holder: string | undefined };

/** 取号的结果。**不抛错**——理由见 `../persistence.ts` 的 `WriteResult`。 */
export type SeqResult =
  | { ok: true; seq: number }
  | { ok: false; reason: "lost_ownership" };

/**
 * 一次**独占权**的句柄。粒度是「一次租期」而不是「一个进程」——同一个进程两次抢占
 * 拿到的是两个不同的 `Grant`，旧的那个此后一律被拒。
 */
export interface Grant {
  readonly conversationId: string;
  /** 这次持有的不透明标识（框架只用来做日志与 `inspect` 对照，不解释）。 */
  readonly holder: string;
  /**
   * **失去独占权时 abort**。轮编排把它并进这一轮的中止信号——于是「一轮跑到一半被
   * 告知你已经不是主人了」这条路径，走的是既有的中断收尾，不需要任何新形状。
   */
  readonly signal: AbortSignal;
  /** 我还持有吗。`release()` 之后恒 `false`。 */
  readonly valid: boolean;
  /** 取一个账本 seq 号。**seq 由归属仲裁分配，不由 DB 生成**（方言特性通用适配器表达不了）。 */
  nextSeq(): Promise<SeqResult>;
  /** 释放归属（同时抹掉[起轮标记](../../../docs/terms.md)）。幂等。 */
  release(): Promise<void>;
  /**
   * 放手，并把这份对话[交接预留](../../../docs/terms.md)给 `node`：`ttlMs` 之内**只有 `node` 的
   * `acquire` 抢得到**，别的节点（包括[定时回捞](../../../docs/terms.md)）一律报 `busy`、`holder` 报
   * `node`（接入层据此把请求转给它）；过期之后退化成没人持有。
   *
   * `node` 与 `holder` 同一个值空间（节点地址）。只在还持有时生效；之后这个 grant 与 `release()`
   * 之后一样作废。
   *
   * **可选**：没实现它的仲裁机制，[交权](../../../docs/terms.md)时退化成普通 `release()`——谁先来谁接手，
   * 只是少了「指定交接优先」这条保证。单进程实现用不上它。
   */
  releaseTo?(node: string, opts: { ttlMs: number }): Promise<void>;
}

/** `inspect` 的答案：这个会话此刻归属在谁手上。 */
export interface OwnershipInfo {
  held: boolean;
  holder?: string;
  /**
   * `true` = 此刻没人真持有，这是一份有效的[交接预留](../../../docs/terms.md)（`holder` 报被预留的节点）。
   * 被预留的节点靠它分辨「这份对话正要交给我」与「我自己刚放掉的租约」。可选：不做预留的实现不报它。
   */
  reserved?: boolean;
}

/** 库里还留着[起轮标记](../../../docs/terms.md)、但已经没人在跑的那些会话——启动扫描的输入。 */
export interface StaleOwnership {
  conversationId: string;
  holder?: string;
}

export interface Arbitration {
  acquire(conversationId: string, ctx: AcquireContext): Promise<AcquireResult>;
  inspect(conversationId: string): Promise<OwnershipInfo>;
  /**
   * 扫出**没人管了**的[起轮标记](../../../docs/terms.md)——[孤儿轮](../../../docs/terms.md)
   * 的**直接判据**。
   *
   * 内存版恒返回空数组：标记跟进程同生共死，进程一没标记也没了，所以它**看不到**
   * 自己上次崩溃的残留——那需要一个跨进程的落地实现（比如 `@runko/persist-kysely` 的
   * `leaseArbitration`）。
   */
  listStale(): Promise<StaleOwnership[]>;
  /** 清掉一条陈旧标记（补完收尾之后）。 */
  clearStale(conversationId: string): Promise<void>;
  /**
   * 给对话打上[待接手](../../../docs/terms.md)标记：它有活没干完、而此刻可能没人会去推。
   * 打标记的时机：每次交权；工具收尾写回结果；节点下线期间来了消息或有人答了卡片；
   * 崩溃恢复后队列里还有消息；接着跑的那一轮装配失败。
   * [定时回捞](../../../docs/terms.md)与新进程的启动扫描据此推一把。幂等。
   *
   * 下面三个方法**可选，要么都实现、要么都不实现**。没实现时没有定时回捞；
   * 节点下线又挑不到接手节点时，在干活的轮照旧[中止](../../../docs/terms.md)（交权 · 技术方案 §10.4）。
   */
  markAwaitingTakeover?(conversationId: string): Promise<void>;
  /** 撤掉待接手标记（推过了）。幂等。 */
  clearAwaitingTakeover?(conversationId: string): Promise<void>;
  /**
   * [定时回捞](../../../docs/terms.md)的输入：**没人持有、也没有有效的交接预留**，而且打了待接手标记的对话。
   * 不看[待发队列](../../../docs/terms.md)是否为空（交权 · 技术方案 §10.3）。
   *
   * 它只碰「预留已过期或根本没有预留」的对话，所以不会跟指定交接抢。
   */
  listSweepCandidates?(opts: { limit: number }): Promise<string[]>;
}
