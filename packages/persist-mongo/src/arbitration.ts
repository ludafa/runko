/**
 * **租约版[归属仲裁机制](../../../docs/terms.md)的 MongoDB 实现**——多副本共享一个 Mongo 时用它。
 *
 * 语义与取舍见[技术方案](../../../docs/logic/arbitration/tech/arbitration-impl.md)，
 * 这里只讲实现上必须知道的三件事：
 *
 * ① **它保证不了独占，只能安全地失败。** 你没法知道远处那个副本是死了还是只是联系不上，
 *    所以只能二选一：不做超时接管（崩溃即永久卡死），或做超时接管（一定存在误判窗口）。
 *    本实现选后者。于是**每一次取号都可能被拒，而且这是正常路径**——`nextSeq` 报
 *    `lost_ownership` 时轮编排走既有的中断收尾。
 *
 * ② **两个机制分工，互相替代不了。** [租期标识](../../../docs/terms.md)管「不写坏」
 *    （它只会拒绝，不会放行）；心跳管「卡住的能被接管」。只有令牌没有心跳 = 崩溃的会话
 *    永久卡死；只有心跳没有令牌 = 误判时两个持有者都能写，静默损坏。
 *
 * ③ **条件写只要一次往返**——这是 Mongo 比 SQL 那一档干净的地方。`findOneAndUpdate` 直接
 *    返回更新后的文档（没匹配到就是 `null`），不必像 `@runko/persist-kysely` 那样「条件
 *    UPDATE + 读回来比对令牌」两步（那两步是为了绕开 MySQL：它把「匹配到了但值没变」也
 *    报成 0 行，跟「没匹配到」分不开）。
 *
 * ⚠️ **心跳与自我围栏那一段是从 `@runko/persist-kysely/src/arbitration.ts` 刻意复制的，
 * 改一处必须同步另一处。** 不抽公共包的三条理由见[技术方案 §4.3](../../../docs/host/node/tech/multi-replica.md)，
 * 一句话是：为 60 行代码开一个包不划算，而让本包依赖 `persist-kysely` 会把 Kysely 拖进
 * Mongo 用户的依赖树、也毁掉「它不是薄壳」这个定位。
 *
 * **漂移靠两层挡，缺一不可**（第二层是代码审查指出来才补的——只有第一层时，
 * 「心跳偶发失败别判失去归属」与「挂住不返回也要停手」这两支改坏了两边都不会红）：
 *
 * | 挡什么 | 靠谁 |
 * |---|---|
 * | 对外语义（被接管、取号被拒、`clearStale` 不擦活人…） | 仲裁一致性套件，两份实现跑同一套 |
 * | 库坏掉时的那几支（抛错 / 挂住 / 偶发失败） | **各包自己的故障注入用例**——套件是跨实现的，造不出「库坏掉」 |
 */
import type {
  Arbitration,
  AcquireContext,
  AcquireResult,
  Grant,
  OwnershipInfo,
  SeqResult,
  StaleOwnership,
} from "@runko/agent";
import type { Collection, Db } from "mongodb";

import type { LeaseDoc } from "./collections.js";
import { LEASES_COLLECTION } from "./collections.js";
import { isDuplicateKeyError } from "./errors.js";

/** 心跳间隔的默认值（毫秒）。与 SQL 那一档同款，定案见技术方案 §8.3。 */
export const DEFAULT_HEARTBEAT_MS = 5_000;
/** 超时接管阈值的默认值（毫秒）——12 个心跳。 */
export const DEFAULT_TAKEOVER_MS = 60_000;
/** 阈值至少要是心跳的几倍。配成 2× 会让一次正常的调度延迟就触发误判。 */
const MIN_BEATS_BEFORE_TAKEOVER = 3;

export interface MongoArbitrationOptions {
  /**
   * 这个副本的身份——**不透明字符串**（k8s pod 地址 / Fly machine id / 随便什么）。
   * 框架存它、传它、**不解释它**：别人抢不到归属时会拿到它，由[接入层](../../../docs/terms.md)
   * 决定把请求转给谁。**转发是宿主写的，不是框架做的。**
   */
  holder: string;
  /** 心跳间隔，默认 5 秒。 */
  heartbeatMs?: number;
  /** 多久没心跳算它死了，默认 60 秒。**必须 ≥ 3 × 心跳间隔**，否则构造时就抛。 */
  takeoverMs?: number;
  /** 让测试能控制时间；缺省 `Date.now`。 */
  now?: () => number;
}

/**
 * 建一个租约版归属仲裁机制。
 *
 * ```ts
 * const arbitration = mongoArbitration(db, { holder: process.env.POD_NAME });
 * createAgentRuntime({ ..., persistence: mongoPersistence(db), arbitration });
 * ```
 *
 * **吃的是同一个 `Db`**——跟 `mongoPersistence(db)` 一样。`migrate(db)` 已经把租约集合要的
 * 索引一起建了，不用再调别的。
 */
export function mongoArbitration(db: Db, opts: MongoArbitrationOptions): Arbitration {
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const takeoverMs = opts.takeoverMs ?? DEFAULT_TAKEOVER_MS;
  const now = opts.now ?? Date.now;

  // **配错当场抛，不等线上误接管。** 这条校验本身就是这个功能的一部分：阈值太短会让一次
  // 正常的 GC 停顿或调度延迟变成「两个副本同时持有」，而那是静默的数据损坏。
  if (takeoverMs < heartbeatMs * MIN_BEATS_BEFORE_TAKEOVER) {
    throw new Error(
      `mongoArbitration: takeoverMs (${String(takeoverMs)}ms) must be at least ${String(MIN_BEATS_BEFORE_TAKEOVER)}× ` +
        `heartbeatMs (${String(heartbeatMs)}ms). A shorter threshold turns one ordinary scheduling delay into two ` +
        `simultaneous holders, which corrupts the ledger silently.`,
    );
  }

  const col: Collection<LeaseDoc> = db.collection<LeaseDoc>(LEASES_COLLECTION);

  /** 一条租约是不是「有人持有且还活着」。 */
  const isLive = (doc: Pick<LeaseDoc, "leaseToken" | "heartbeatAt">, at: number): boolean =>
    doc.leaseToken !== null && at - doc.heartbeatAt <= takeoverMs;

  async function acquire(conversationId: string, ctx: AcquireContext): Promise<AcquireResult> {
    const at = now();
    const existing = await col.findOne({ _id: conversationId });

    // 快路：有人持有且还活着 → 直接报 busy，**不调 `seedSeq`**（契约要求它是惰性的：
    // 抢不到归属时不该白查一次账本）。这一步只是优化，真正的原子性在下面那条 CAS。
    if (existing !== null && isLive(existing, at)) {
      return { ok: false, reason: "busy", holder: existing.holder ?? undefined };
    }

    const token = crypto.randomUUID();

    if (existing === null) {
      // 第一次见到这个会话：水位从账本问一次，先插一条「没人持有」的空租约。
      //
      // **不能把这一步和下面那条 CAS 合成一次 upsert**：Mongo 的 upsert 只从 filter 里的
      // **等值**子句推导要插入的文档，`$or` 那一段推不出来——文档已存在且被别人持有时，
      // 它会试着插一条同 `_id` 的新文档而撞 `E11000`。能 catch 兜住，但那是把正常路径写成
      // 异常路径，`seedSeq()` 的惰性也保不住。
      //
      // 撞 `E11000` 不算错：另一个副本同时在插同一条。胜负由下面那条 CAS 决。
      const watermark = await ctx.seedSeq();
      try {
        await col.insertOne({
          _id: conversationId,
          holder: null,
          leaseToken: null,
          seqWatermark: watermark,
          heartbeatAt: 0,
          acquiredAt: at,
        });
      } catch (error: unknown) {
        if (!isDuplicateKeyError(error)) {
          throw error;
        }
      }
    }

    // **决胜负的就是这一条。** 只有「没人持有」或「持有者已超时」才让抢；`seqWatermark`
    // 刻意不动——抢占一个已有的会话时重播水位会让 seq 倒退，撞上账本里已有的行。
    //
    // 返回非 `null` 就是抢到了：这份文档是**这一次原子更新之后**的样子，令牌一定是我的，
    // 不需要再读回来比对（SQL 那一档那一步是为了绕开 MySQL 的 affectedRows）。
    const won = await col.findOneAndUpdate(
      {
        _id: conversationId,
        $or: [{ leaseToken: null }, { heartbeatAt: { $lt: at - takeoverMs } }],
      },
      { $set: { holder: opts.holder, leaseToken: token, heartbeatAt: at, acquiredAt: at } },
      { returnDocument: "after" },
    );

    if (won === null) {
      // 没抢到——并发下另一个副本比我们快。报 busy 并带上**当前**持有者。
      const current = await col.findOne({ _id: conversationId }, { projection: { holder: 1 } });
      return { ok: false, reason: "busy", holder: current?.holder ?? undefined };
    }

    const grant = createGrant(conversationId, token, at);
    // **抢到的是一条令牌还挂着的租约** = 顶掉了一个过期的持有者（走到这里说明快路判它不活了）。
    // 它那一轮在账本里不会再有收尾，告诉轮编排去补。启动扫描那条路先 `clearStale` 把令牌
    // 置空了，所以不会在这里重复报。
    //
    // 已知不精确：「读到过期令牌」与「CAS 赢」之间，老持有者若恰好活过来、正常收尾并释放，
    // 这里会多报一次，结果是账本多一条「已停止」。窗口只有一次往返宽、不写坏账本，与
    // `listStale` 分不清「崩了」和「收尾时卡住」是同一种不精确，不另加一层 CAS。
    if (existing !== null && existing.leaseToken !== null) {
      return { ok: true, grant, takeover: existing.holder !== null ? { holder: existing.holder } : {} };
    }
    return { ok: true, grant };
  }

  function createGrant(conversationId: string, token: string, acquiredAt: number): Grant {
    const controller = new AbortController();
    let released = false;
    /** 取号串起来跑：同一个 grant 的两次 `nextSeq` 交错会读到同一个水位。 */
    let chain: Promise<unknown> = Promise.resolve();

    /**
     * 最后一次成功心跳**写进 `heartbeatAt` 的那个时刻**——不是往返回来之后重新取的
     * `now()`。别的副本判死看的就是库里那个值，围栏必须拿同一个基准算余量；用 ack
     * 之后的时刻会把整条往返白送出去，往返一旦接近心跳间隔（库劣化时很常见，而库劣化
     * 正是这段代码存在的理由）余量就归零甚至变负——收手比别人接管还晚。
     */
    let lastBeatAt = acquiredAt;
    /** 上一拍还没跑完就别再起一拍（库卡住时 `beat` 可能比间隔还慢）。 */
    let beating = false;

    /**
     * 别人最早能在 `lastBeatAt + takeoverMs` 接管我，所以留一拍的余量提前收手。
     * 这条依赖各副本时钟大致同步；时钟不可信的部署应该把 `takeoverMs` 调大，
     * 而不是把这个余量调小。
     */
    const fenceExpired = (): boolean => now() - lastBeatAt >= takeoverMs - heartbeatMs;

    /**
     * 心跳。**它同时是「我还持有吗」的主要发现路径**——比 `nextSeq` 更早，因为一轮里
     * 可能很久才写一次账本。打不中就说明令牌被换了：立刻 abort，让正在跑的那一轮走
     * 既有的中断收尾。
     *
     * **失败要分两档处理，这是这段最容易写错的地方**：
     *
     * - 偶发一两次失败 → 什么都不做，下一拍再试（网络抖动不该中断用户的一轮）。
     * - **连续失败到逼近接管阈值 → 自己主动停手**（自我围栏）。不这么做的话：库连不上
     *   恰恰是副本停跳最常见的原因，那时我的心跳每拍都失败、永远不 abort，而别人在
     *   `takeoverMs` 之后已经合法接管并开始跑——账本有令牌 CAS 挡着不会写坏，但
     *   **沙盒挡不住**，两个执行同时改同一个工作区就是互相踩文件。
     *
     * **围栏判断必须放在最前面**，在防重入早退之前。心跳失败有两种形状：抛错（连不上）
     * 与**挂住不返回**（TCP 黑洞、连接池耗尽、网络分区下的 TCP 停滞）——后者更常见，
     * 而且**不会进 `catch`**，它只是让上一拍永远不结束。围栏判断若只写在 `catch` 里，
     * `beating` 会永久停在 `true`，此后每一拍都在防重入这里就 return 了，于是老持有者
     * 永远不停手，而别人早已合法接管。
     */
    const beat = async (): Promise<void> => {
      if (released || controller.signal.aborted) {return;}
      if (fenceExpired()) {
        lose();
        return;
      }
      if (beating) {return;}
      beating = true;
      // 先取时刻再发查询：写进库里的就是它，`lastBeatAt` 记的也是它。
      const beatAt = now();
      try {
        const result = await col.updateOne(
          { _id: conversationId, leaseToken: token },
          { $set: { heartbeatAt: beatAt } },
        );
        // ⚠️ **看 `matchedCount`，不是 `modifiedCount`。** Mongo 在「匹配到但新值与旧值
        // 相同」时报 `matched=1, modified=0`——同一毫秒内连打两拍就会撞上，那时用
        // `modifiedCount` 判断会把一次成功的心跳误判成「被接管了」，白白中断用户的一轮。
        if (result.matchedCount > 0) {
          lastBeatAt = beatAt;
          return;
        }
      } catch {
        // 这一拍没打通。**不在这里判围栏**——下一拍开头统一判，那条路径连「挂住」
        // 这种进不了 catch 的失败也一起覆盖了。
        return;
      } finally {
        beating = false;
      }
      // 打通了但令牌不是我的 → 已经被接管，立刻停手。
      lose();
    };

    const timer: ReturnType<typeof setInterval> = setInterval(() => {
      void beat();
    }, heartbeatMs);
    // 别让心跳把进程钉住不退。
    if (typeof timer.unref === "function") {timer.unref();}

    function lose(): void {
      if (controller.signal.aborted) {return;}
      clearInterval(timer);
      controller.abort(new Error("lease lost"));
    }

    return {
      conversationId,
      holder: opts.holder,
      signal: controller.signal,
      get valid() {
        return !released && !controller.signal.aborted;
      },
      async nextSeq(): Promise<SeqResult> {
        const run = chain.then(async (): Promise<SeqResult> => {
          if (released || controller.signal.aborted) {return { ok: false, reason: "lost_ownership" };}
          // **一律不抛**（`SeqResult` 的契约）。库抖一下也走这条：拿不到号就绝不能写，
          // 而调用方只判 `allocated.ok`、没有任何 try——从这里逃出去的异常会直接冲垮
          // 收尾路径，那是最不该出事的一段。
          //
          // 归到 `lost_ownership` 是有意的：这个结果的含义是「你现在不许写」，而不是
          // 「别人拿走了」。真的被接管由心跳的自我围栏去判定，不在这里下结论——所以
          // 失败时**不调 `lose()`**，一次网络抖动不该等同于失去归属。
          try {
            const beatAt = now();
            // 取号与「校验我还持有」是**同一条 CAS**：`$inc` 之后的新值直接回来，
            // 不需要第二次往返，也不可能出现「校验通过但取号用的是别人的水位」。
            // 顺带把心跳也刷了。
            const doc = await col.findOneAndUpdate(
              { _id: conversationId, leaseToken: token },
              { $inc: { seqWatermark: 1 }, $set: { heartbeatAt: beatAt } },
              { returnDocument: "after" },
            );
            if (doc === null) {
              lose();
              return { ok: false, reason: "lost_ownership" };
            }
            // 这一条也是一次成功的心跳，围栏的基准跟着往前走。
            lastBeatAt = beatAt;
            return { ok: true, seq: doc.seqWatermark };
          } catch {
            return { ok: false, reason: "lost_ownership" };
          }
        });
        chain = run.catch(() => undefined);
        return await run;
      },
      async release(): Promise<void> {
        if (released) {return;}
        released = true;
        clearInterval(timer);
        // **只在还持有时才放手**：被接管之后再 release 会把新持有者的租约擦掉。
        // 不删文档——`seqWatermark` 要跨释放保留，下次抢占才不用回账本重新问水位。
        await col.updateOne(
          { _id: conversationId, leaseToken: token },
          { $set: { holder: null, leaseToken: null } },
        );
      },
    };
  }

  return {
    acquire,

    async inspect(conversationId: string): Promise<OwnershipInfo> {
      const doc = await col.findOne({ _id: conversationId });
      if (doc === null || !isLive(doc, now())) {return { held: false };}
      return { held: true, ...(doc.holder !== null ? { holder: doc.holder } : {}) };
    },

    /**
     * 「有人持有但心跳已超时」的那些会话。
     *
     * **语义跟内存版不一样，但两个都对**：内存版的归属表跟进程同生共死，看不到自己上次
     * 崩溃的残留（恒返回空数组）；租约版看得到——那正是它存在的理由。
     */
    async listStale(): Promise<StaleOwnership[]> {
      const docs = await col
        .find(
          { leaseToken: { $ne: null }, heartbeatAt: { $lt: now() - takeoverMs } },
          { projection: { holder: 1 } },
        )
        .toArray();
      return docs.map((doc) => ({
        conversationId: doc._id,
        ...(doc.holder !== null ? { holder: doc.holder } : {}),
      }));
    },

    /**
     * 清一条陈旧标记。**必须带上跟 `listStale` 同一条陈旧判据**，不能只按会话清——
     * 否则会擦掉一个**活着的**持有者的租约。
     *
     * 触发路径就在框架自己身上：`recover()` 的顺序是 `listStale → clearStale → acquire`。
     * 多副本滚动重启时两个副本同时开机、扫到同一条陈旧会话：A 先清完并抢到令牌开始补写，
     * B 随后若无条件清一次就把 A 的令牌抹掉了——要么同一个会话被补两条「已停止」标记，
     * 要么 A 补到一半被判出局。带上判据之后 B 这一下是 no-op，它的 `acquire` 会老实报 busy。
     */
    async clearStale(conversationId: string): Promise<void> {
      await col.updateOne(
        { _id: conversationId, heartbeatAt: { $lt: now() - takeoverMs } },
        { $set: { holder: null, leaseToken: null } },
      );
    },
  };
}
