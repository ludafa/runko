/**
 * **租约版[归属仲裁机制](../../../docs/terms.md)**——多进程 / 多节点共享一个数据库时用它。
 *
 * 语义与取舍见[技术方案](../../../docs/logic/arbitration/tech/arbitration-impl.md)，
 * 这里只讲实现上必须知道的三件事：
 *
 * ① **它保证不了独占，只能安全地失败。** 你没法知道远处那个节点是死了还是只是联系不上，
 *    所以只能二选一：不做超时接管（崩溃即永久卡死），或做超时接管（一定存在误判窗口）。
 *    本实现选后者。于是**每一次取号都可能被拒，而且这是正常路径**——`nextSeq` 报
 *    `lost_ownership` 时轮编排走既有的中断收尾。
 *
 * ② **两个机制分工，互相替代不了。** [租期标识](../../../docs/terms.md)管「不写坏」
 *    （它只会拒绝，不会放行）；心跳管「卡住的能被接管」。只有令牌没有心跳 = 崩溃的会话
 *    永久卡死；只有心跳没有令牌 = 误判时两个持有者都能写，静默损坏。
 *
 * ③ **决定归属的条件写（`acquire` 的 CAS、心跳、取号）都是「条件 UPDATE + 读回确认」两步**，
 *    不看 affectedRows。原因是 MySQL：它把「匹配到了但值没变」也报成 0 行，跟「没匹配到」
 *    分不开。读回来比对令牌是三个方言都一样的判据。`releaseTo` 例外：它命中时值一定会变，
 *    所以可以直接看 `numUpdatedRows`（理由见那里的注释）。
 *
 * ⚠️ **心跳与自我围栏那一段在 `@runko/persist-mongo/src/arbitration.ts` 有一份刻意的复制，
 * 改一处必须同步另一处。** 不抽公共包的三条理由见[技术方案 §4.3](../../../docs/host/node/tech/multi-replica.md)。
 * 漂移靠两层挡：对外语义由仲裁一致性套件钉住（两份实现跑同一套）；**库坏掉时的那几支
 * （抛错 / 挂住 / 偶发失败）套件造不出来，两个包各自有故障注入用例**——本包是
 * `test/helpers/faulty-dialect.ts`，Mongo 那边是 `test/helpers/faulty-db.ts`。
 */
import { randomUUID } from "node:crypto";
import type { Arbitration, AcquireContext, AcquireResult, Grant, OwnershipInfo, SeqResult, StaleOwnership } from "@runko/agent";
import type { ExpressionBuilder, Kysely } from "kysely";

import type { Flavor, FlavorTraits } from "./flavor.js";
import { toNumber, traitsOf } from "./flavor.js";
import { insertOrIgnore } from "./idempotent-insert.js";
import type { HandoverTable, RunkoDatabase } from "./schema.js";
import { HANDOVER_TABLE, LEASES_TABLE } from "./schema.js";

/** 心跳间隔的默认值（毫秒）。定案见技术方案 §8.3。 */
export const DEFAULT_HEARTBEAT_MS = 5_000;
/** 超时接管阈值的默认值（毫秒）——12 个心跳。定案见技术方案 §8.3。 */
export const DEFAULT_TAKEOVER_MS = 60_000;
/** 阈值至少要是心跳的几倍。配成 2× 会让一次正常的调度延迟就触发误判。 */
const MIN_BEATS_BEFORE_TAKEOVER = 3;

export interface LeaseArbitrationOptions {
  /**
   * 你这个 Kysely 实例接的是哪一家。**给方言名就行**（与 `kyselyPersistence` 同款）；
   * 已经手上有一份 `FlavorTraits` 的也照收。
   */
  flavor: Flavor | FlavorTraits;
  /**
   * 这个节点的身份——**不透明字符串**（k8s pod 地址 / Fly machine id / 随便什么）。
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
 * const arbitration = leaseArbitration(db, { flavor: "postgres", holder: process.env.POD_NAME });
 * createAgentRuntime({ ..., persistence, arbitration });
 * ```
 */
export function leaseArbitration(db: Kysely<RunkoDatabase>, opts: LeaseArbitrationOptions): Arbitration {
  const traits = typeof opts.flavor === "string" ? traitsOf(opts.flavor) : opts.flavor;
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const takeoverMs = opts.takeoverMs ?? DEFAULT_TAKEOVER_MS;
  const now = opts.now ?? Date.now;

  // **配错当场抛，不等线上误接管。** 这条校验本身就是这个功能的一部分：阈值太短会让一次
  // 正常的 GC 停顿或调度延迟变成「两个节点同时持有」，而那是静默的数据损坏。
  if (takeoverMs < heartbeatMs * MIN_BEATS_BEFORE_TAKEOVER) {
    throw new Error(
      `leaseArbitration: takeoverMs (${String(takeoverMs)}ms) must be at least ${String(MIN_BEATS_BEFORE_TAKEOVER)}× ` +
        `heartbeatMs (${String(heartbeatMs)}ms). A shorter threshold turns one ordinary scheduling delay into two ` +
        `simultaneous holders, which corrupts the ledger silently.`,
    );
  }

  /**
   * 本进程起来的时刻。
   *
   * **挂在自己名下、心跳却早于这一刻的租约，一定是上一辈子留下的**——一个刚起来的进程
   * 不可能已经在跑任何一轮。启动扫描据此立刻收拾它，不必干等[接管阈值](../../../docs/terms.md)：
   * 崩溃后马上重启的会话，重启完就能用。
   *
   * **前提是每个进程的 `holder` 唯一。** 两个活着的进程配成同一个名字时，后起来的那个会把
   * 先来的那一轮抢过去；先来的手里那个[租期标识](../../../docs/terms.md)已经作废、写不进账本，
   * 所以坏的是那一轮，不是数据。
   */
  const startedAt = now();

  /** 挂在我名下、心跳早于本进程启动 = 上一辈子的残留。 */
  const isMyOrphan = (row: { holder: string | null; heartbeat_at: number }): boolean =>
    row.holder === opts.holder && toNumber(row.heartbeat_at) < startedAt;

  /**
   * 陈旧判据：心跳超过接管阈值没续，**或者**是我自己上一辈子的残留。
   *
   * `listStale`、`clearStale`、`acquire` 三处共用这一条——判据一旦不一致，`recover()` 的
   * `listStale → clearStale → acquire` 会互相打架（见 `clearStale` 的注释）。
   */
  const isStaleWhere = (eb: ExpressionBuilder<RunkoDatabase, typeof LEASES_TABLE>, at: number) =>
    eb.or([
      eb("heartbeat_at", "<", at - takeoverMs),
      eb.and([eb("holder", "=", opts.holder), eb("heartbeat_at", "<", startedAt)]),
    ]);

  const readRow = async (conversationId: string) =>
    await db
      .selectFrom(LEASES_TABLE)
      .selectAll()
      .where("conversation_id", "=", conversationId)
      .executeTakeFirst();

  /** 我此刻还持有吗——**读回来比对令牌**，不看 affectedRows（见文件头第 ③ 条）。 */
  const stillHeld = async (conversationId: string, token: string): Promise<boolean> => {
    const row = await readRow(conversationId);
    return row !== undefined && row.lease_token === token;
  };

  /** 一行是不是「有人持有且还活着」。我自己上一辈子的残留不算活着。 */
  const isLive = (row: { holder: string | null; lease_token: string | null; heartbeat_at: number }, at: number): boolean =>
    row.lease_token !== null && at - toNumber(row.heartbeat_at) <= takeoverMs && !isMyOrphan(row);

  const readHandover = async (conversationId: string) =>
    await db
      .selectFrom(HANDOVER_TABLE)
      .selectAll()
      .where("conversation_id", "=", conversationId)
      .executeTakeFirst();

  /**
   * [交接预留](../../../docs/terms.md)还有效吗——`reserved_until` 缺席或已过 = 没有预留，
   * 退化成「没人持有」。返回预留给谁，`undefined` = 没有有效预留。
   */
  const activeReservedFor = (
    row: Pick<HandoverTable, "reserved_for" | "reserved_until"> | undefined,
    at: number,
  ): string | undefined => {
    if (row === undefined || row.reserved_for === null || row.reserved_until === null) {return undefined;}
    return toNumber(row.reserved_until) > at ? row.reserved_for : undefined;
  };

  /** 确保 `agent_handover` 有这一行（其余字段留默认值）。多处要用（预留 / 待接手都要先有行）。 */
  const ensureHandoverRow = async (conversationId: string, at: number): Promise<void> => {
    await insertOrIgnore(
      traits,
      db.insertInto(HANDOVER_TABLE).values({
        conversation_id: conversationId,
        reserved_for: null,
        reserved_until: null,
        awaiting_takeover: 0,
        updated_at: at,
      }),
      ["conversation_id"],
    ).execute();
  };

  async function acquire(conversationId: string, ctx: AcquireContext): Promise<AcquireResult> {
    const at = now();
    const existing = await readRow(conversationId);
    const reservedFor = activeReservedFor(await readHandover(conversationId), at);

    // 有效预留只放行被预留者——**不调 `seedSeq`**（契约要求它是惰性的：抢不到归属时
    // 不该白查一次账本）。持有中的会话不会同时有有效预留（`releaseTo` 放手与写预留是
    // 同一步），所以这条判断放在「有人持有」的快路之前不会误伤正常持有者。
    if (reservedFor !== undefined && reservedFor !== opts.holder) {
      return { ok: false, reason: "busy", holder: reservedFor };
    }

    // 快路：有人持有且还活着 → 直接报 busy，**不调 `seedSeq`**（契约要求它是惰性的：
    // 抢不到归属时不该白查一次账本）。这一步只是优化，真正的原子性在下面那条条件 UPDATE。
    if (existing !== undefined && isLive(existing, at)) {
      return { ok: false, reason: "busy", holder: existing.holder ?? undefined };
    }

    const token = randomUUID();

    if (existing === undefined) {
      // 第一次见到这个会话：水位从账本问一次。用幂等插入——并发下另一个节点可能同时在插，
      // 撞了不算错，下面那条条件 UPDATE 会决出胜负。
      const watermark = await ctx.seedSeq();
      await insertOrIgnore(
        traits,
        db.insertInto(LEASES_TABLE).values({
          conversation_id: conversationId,
          holder: null,
          lease_token: null,
          seq_watermark: watermark,
          heartbeat_at: 0,
          acquired_at: at,
        }),
        ["conversation_id"],
      ).execute();
    }

    // **决胜负的就是这一条。** 只有「没人持有」或「持有者已超时」才让抢；`seq_watermark`
    // 刻意不动——抢占一个已有的会话时重播水位会让 seq 倒退，撞上账本里已有的行。
    //
    // 再加一条 `NOT EXISTS`：挡住「别人的有效预留」。没有它的话，`readHandover` 那次早读
    // 与这条 CAS 之间有一段窗口——`releaseTo` 恰好在窗口里把预留写给了另一个节点，我们
    // 这条 CAS 若不重新核对就会抢到本该属于它的对话。`reserved_for = opts.holder`（预留
    // 给我自己）不会被这条子查询挡住，所以被预留者照常抢得到。
    await db
      .updateTable(LEASES_TABLE)
      .set({ holder: opts.holder, lease_token: token, heartbeat_at: at, acquired_at: at })
      .where("conversation_id", "=", conversationId)
      .where((eb) => eb.or([eb("lease_token", "is", null), isStaleWhere(eb, at)]))
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom(HANDOVER_TABLE)
              .select(`${HANDOVER_TABLE}.conversation_id`)
              .whereRef(`${HANDOVER_TABLE}.conversation_id`, "=", `${LEASES_TABLE}.conversation_id`)
              .where(`${HANDOVER_TABLE}.reserved_for`, "is not", null)
              .where(`${HANDOVER_TABLE}.reserved_for`, "<>", opts.holder)
              .where(`${HANDOVER_TABLE}.reserved_until`, ">", at),
          ),
        ),
      )
      .execute();

    const after = await readRow(conversationId);
    if (after === undefined || after.lease_token !== token) {
      // 没抢到——可能是被别的节点抢先，也可能是被预留挡住了（此时的预留可能是这次
      // CAS 期间才写上的）。重新问一次决定报给谁。
      const blockedBy = activeReservedFor(await readHandover(conversationId), now());
      if (blockedBy !== undefined && blockedBy !== opts.holder) {
        return { ok: false, reason: "busy", holder: blockedBy };
      }
      return { ok: false, reason: "busy", holder: after?.holder ?? undefined };
    }

    // 抢到了——**消费掉预留**（不管之前有没有），不然它会继续挡下一个人。
    await db
      .updateTable(HANDOVER_TABLE)
      .set({ reserved_for: null, reserved_until: null, updated_at: now() })
      .where("conversation_id", "=", conversationId)
      .execute();

    const grant = createGrant(conversationId, token, at);
    // **抢到的是一个令牌还挂着的行** = 顶掉了一个过期的持有者（走到这里说明快路判它不活了）。
    // 它那一轮在账本里不会再有收尾，告诉轮编排去补。启动扫描那条路先 `clearStale` 把令牌
    // 置空了，所以不会在这里重复报。
    //
    // 已知不精确：「读到过期令牌」与「条件 UPDATE 赢」之间，老持有者若恰好活过来、正常收尾并
    // 释放，这里会多报一次，结果是账本多一条「已停止」。窗口只有一次往返宽、不写坏账本，
    // 与 `listStale` 分不清「崩了」和「收尾时卡住」是同一种不精确，不另加一层 CAS。
    if (existing !== undefined && existing.lease_token !== null) {
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
     * 最后一次成功心跳**写进 `heartbeat_at` 的那个时刻**——不是往返回来之后重新取的
     * `now()`。别的节点判死看的就是库里那个值，围栏必须拿同一个基准算余量；用 ack
     * 之后的时刻会把整条往返白送出去，往返一旦接近心跳间隔（库劣化时很常见，而库劣化
     * 正是这段代码存在的理由）余量就归零甚至变负——收手比别人接管还晚。
     */
    let lastBeatAt = acquiredAt;
    /** 上一拍还没跑完就别再起一拍（库卡住时 `beat` 可能比间隔还慢）。 */
    let beating = false;

    /**
     * 别人最早能在 `lastBeatAt + takeoverMs` 接管我，所以留一拍的余量提前收手。
     * 这条依赖各节点时钟大致同步；时钟不可信的部署应该把 `takeoverMs` 调大，
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
     *   恰恰是节点停跳最常见的原因，那时我的心跳每拍都失败、永远不 abort，而别人在
     *   `takeoverMs` 之后已经合法接管并开始跑——账本有令牌 CAS 挡着不会写坏，但
     *   **沙盒挡不住**，两个执行同时改同一个工作区就是互相踩文件（[功能手册 §1]
     *   把「沙盒是共享且有状态的」列为独占的两条理由之一）。
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
        await db
          .updateTable(LEASES_TABLE)
          .set({ heartbeat_at: beatAt })
          .where("conversation_id", "=", conversationId)
          .where("lease_token", "=", token)
          .execute();
        if (await stillHeld(conversationId, token)) {
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
    // 别让心跳把进程钉住不退（Node 特有；浏览器/Workers 上没有这个方法）。
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
          // 而调用方（`turn.ts` 三处）只判 `allocated.ok`、没有任何 try——从这里逃出去
          // 的异常会直接冲垮收尾路径，那是最不该出事的一段。
          //
          // 归到 `lost_ownership` 是有意的：这个结果的含义是「你现在不许写」，而不是
          // 「别人拿走了」。真的被接管由心跳的自我围栏去判定，不在这里下结论——所以
          // 失败时**不调 `lose()`**，一次网络抖动不该等同于失去归属。
          try {
            const beatAt = now();
            // 取号与「校验我还持有」是**同一条 UPDATE**：不需要两次往返，也不可能出现
            // 「校验通过但取号用的是别人的水位」。顺带把心跳也刷了。
            await db
              .updateTable(LEASES_TABLE)
              .set((eb) => ({ seq_watermark: eb("seq_watermark", "+", 1), heartbeat_at: beatAt }))
              .where("conversation_id", "=", conversationId)
              .where("lease_token", "=", token)
              .execute();

            const row = await readRow(conversationId);
            if (row === undefined || row.lease_token !== token) {
              lose();
              return { ok: false, reason: "lost_ownership" };
            }
            // 这一条也是一次成功的心跳，围栏的基准跟着往前走。
            lastBeatAt = beatAt;
            return { ok: true, seq: toNumber(row.seq_watermark) };
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
        // 不删行——`seq_watermark` 要跨释放保留，下次抢占才不用回账本重新问水位。
        await db
          .updateTable(LEASES_TABLE)
          .set({ holder: null, lease_token: null })
          .where("conversation_id", "=", conversationId)
          .where("lease_token", "=", token)
          .execute();
      },
      async releaseTo(node: string, handoverOpts: { ttlMs: number }): Promise<void> {
        if (released) {return;}
        released = true;
        clearInterval(timer);
        const at = now();
        // 放手与写预留必须在**同一个事务**里：`agent_handover` 是独立于 `agent_leases`
        // 的另一张表（见 `schema.ts` 的理由），两条 UPDATE 隔着一次往返，不包事务的话
        // 会有一个「已经放手、预留还没写上」的窗口，别的节点可能挤进去抢走它。
        await db.transaction().execute(async (trx) => {
          const result = await trx
            .updateTable(LEASES_TABLE)
            .set({ holder: null, lease_token: null })
            .where("conversation_id", "=", conversationId)
            .where("lease_token", "=", token)
            .executeTakeFirst();
          // 这条 UPDATE 命中时值必然从「我的令牌」变成 `null`——不是「匹配到但没变」，
          // 文件头第 ③ 条那个坑在这里不成立，`numUpdatedRows` 可信。
          if (toNumber(result.numUpdatedRows) === 0) {
            // 已经不再持有了（被接管或已经释放过）——`releaseTo` 跟 `release` 一样，
            // **只在还持有时生效**，不留预留。
            return;
          }
          await insertOrIgnore(
            traits,
            trx.insertInto(HANDOVER_TABLE).values({
              conversation_id: conversationId,
              reserved_for: null,
              reserved_until: null,
              awaiting_takeover: 0,
              updated_at: at,
            }),
            ["conversation_id"],
          ).execute();
          await trx
            .updateTable(HANDOVER_TABLE)
            .set({ reserved_for: node, reserved_until: at + handoverOpts.ttlMs, updated_at: at })
            .where("conversation_id", "=", conversationId)
            .execute();
        });
      },
    };
  }

  return {
    acquire,

    async inspect(conversationId: string): Promise<OwnershipInfo> {
      const at = now();
      const row = await readRow(conversationId);
      if (row !== undefined && isLive(row, at)) {
        return { held: true, ...(row.holder !== null ? { holder: row.holder } : {}) };
      }
      // 没有活着的持有者——看是不是还有一份有效的交接预留，有就报给接入层转发。
      // `reserved: true` 标记「没人真持有」，供被预留的节点分辨这份对话正要交给我，
      // 而不是我自己刚放掉的租约（见 `OwnershipInfo.reserved` 的注释）。
      const reservedFor = activeReservedFor(await readHandover(conversationId), at);
      if (reservedFor !== undefined) {return { held: true, holder: reservedFor, reserved: true };}
      return { held: false };
    },

    /**
     * 「有人持有但心跳已超时」的那些会话。
     *
     * **语义跟内存版不一样，但两个都对**：内存版的归属表跟进程同生共死，看不到自己上次
     * 崩溃的残留（恒返回空数组）；租约版看得到——那正是它存在的理由。
     */
    async listStale(): Promise<StaleOwnership[]> {
      const rows = await db
        .selectFrom(LEASES_TABLE)
        .select(["conversation_id", "holder"])
        .where("lease_token", "is not", null)
        .where((eb) => isStaleWhere(eb, now()))
        .execute();
      return rows.map((row) => ({
        conversationId: row.conversation_id,
        ...(row.holder !== null ? { holder: row.holder } : {}),
      }));
    },

    /**
     * 清一条陈旧标记。**必须带上跟 `listStale` 同一条陈旧判据**，不能只按会话清——
     * 否则会擦掉一个**活着的**持有者的租约。
     *
     * 触发路径就在框架自己身上：`recover()` 的顺序是 `listStale → clearStale → acquire`。
     * 多节点滚动重启时两个节点同时开机、扫到同一条陈旧会话：A 先清完并抢到令牌开始补写，
     * B 随后若无条件清一次就把 A 的令牌抹掉了——要么同一个会话被补两条「已停止」标记，
     * 要么 A 补到一半被判出局。带上判据之后 B 这一下是 no-op，它的 `acquire` 会老实报 busy。
     *
     * （`recover()` 里「启动时不可能有活跃轮，所以没有竞态」那句注释对单进程成立，
     * 对多进程不成立——而多进程正是这个实现存在的理由。）
     */
    async clearStale(conversationId: string): Promise<void> {
      await db
        .updateTable(LEASES_TABLE)
        .set({ holder: null, lease_token: null })
        .where("conversation_id", "=", conversationId)
        .where((eb) => isStaleWhere(eb, now()))
        .execute();
    },

    /** 打[待接手](../../../docs/terms.md)标记。幂等：行不存在就先补一行再打标。 */
    async markAwaitingTakeover(conversationId: string): Promise<void> {
      const at = now();
      await ensureHandoverRow(conversationId, at);
      await db
        .updateTable(HANDOVER_TABLE)
        .set({ awaiting_takeover: 1, updated_at: at })
        .where("conversation_id", "=", conversationId)
        .execute();
    },

    /** 撤掉待接手标记。幂等：行本来就不存在时是 no-op。 */
    async clearAwaitingTakeover(conversationId: string): Promise<void> {
      await db
        .updateTable(HANDOVER_TABLE)
        .set({ awaiting_takeover: 0, updated_at: now() })
        .where("conversation_id", "=", conversationId)
        .execute();
    },

    /**
     * [定时回捞](../../../docs/terms.md)候选：只看打了待接手标记的那些，排除掉「有活着的
     * 持有者」与「有有效预留」——那两种已经有人会推，回捞抢了没意义。
     *
     * **候选不看待发队列是不是空的。** 队列不空不等于卡住——在等人答复、按设计排着后续
     * 消息的对话，队列也不空，但永远推不动，会白白占满每次的 `limit`，挤掉真正卡住（打了
     * 待接手标记）的那些。真正需要回捞推一把的队列，框架会在崩溃恢复、下线交接时主动打上
     * 待接手标记，不需要这里再兜底扫队列。
     *
     * 一共三次查询：先查候选 id，再并行查租约行与预留行。不是一个会话一个会话地查——候选
     * 通常远小于全库规模，`limit` 也约束了返回量，没必要为它专门加索引。
     */
    async listSweepCandidates(sweepOpts: { limit: number }): Promise<string[]> {
      const at = now();
      const awaitingRows = await db.selectFrom(HANDOVER_TABLE).select("conversation_id").where("awaiting_takeover", "=", 1).execute();
      const candidateIds = awaitingRows.map((row) => row.conversation_id);
      if (candidateIds.length === 0) {return [];}

      const [leaseRows, handoverRows] = await Promise.all([
        db.selectFrom(LEASES_TABLE).selectAll().where("conversation_id", "in", candidateIds).execute(),
        db.selectFrom(HANDOVER_TABLE).selectAll().where("conversation_id", "in", candidateIds).execute(),
      ]);
      const leaseById = new Map(leaseRows.map((row) => [row.conversation_id, row]));
      const handoverById = new Map(handoverRows.map((row) => [row.conversation_id, row]));

      const result: string[] = [];
      for (const id of candidateIds) {
        if (result.length >= sweepOpts.limit) {break;}
        const lease = leaseById.get(id);
        if (lease !== undefined && isLive(lease, at)) {continue;}
        if (activeReservedFor(handoverById.get(id), at) !== undefined) {continue;}
        result.push(id);
      }
      return result;
    },
  };
}
