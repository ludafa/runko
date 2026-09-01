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
 * 三种实现（本包只带第一种，另两种在 `@nimbo/persist-*` / `@nimbo/durable-object`）：
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

/** 抢归属的结果。`busy` 时带上 `holder`，[接入层](../../../docs/terms.md)据它决定转发给谁。 */
export type AcquireResult =
  | { ok: true; grant: Grant }
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
}

/** `inspect` 的答案：这个会话此刻归属在谁手上。 */
export interface OwnershipInfo {
  held: boolean;
  holder?: string;
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
   * 的**直接判据**（取代旧的「事件行以 chunk 收尾」那条间接判据）。
   *
   * 内存版恒返回空数组：标记跟进程同生共死，进程一没标记也没了，所以它**看不到**
   * 自己上次崩溃的残留——那需要一个跨进程的落地实现（宿主提供，见
   * `apps/node-server` 的 drizzle 版）。
   */
  listStale(): Promise<StaleOwnership[]>;
  /** 清掉一条陈旧标记（补完收尾之后）。 */
  clearStale(conversationId: string): Promise<void>;
}
