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
 * ③ **所有条件写都是「条件 UPDATE + 读回确认」两步**，不看 affectedRows。原因是 MySQL：
 *    它把「匹配到了但值没变」也报成 0 行，跟「没匹配到」分不开（本仓在幂等插入那里已经
 *    踩过一次）。读回来比对令牌是三个方言都一样的判据。
 */
import { randomUUID } from "node:crypto";
import type { Arbitration, AcquireContext, AcquireResult, Grant, OwnershipInfo, SeqResult, StaleOwnership } from "@nimbo/agent";
import type { Kysely } from "kysely";

import type { FlavorTraits } from "./flavor.js";
import { toNumber } from "./flavor.js";
import { insertOrIgnore } from "./idempotent-insert.js";
import type { NimboDatabase } from "./schema.js";
import { LEASES_TABLE } from "./schema.js";

/** 心跳间隔的默认值（毫秒）。定案见技术方案 §8.3。 */
export const DEFAULT_HEARTBEAT_MS = 5_000;
/** 超时接管阈值的默认值（毫秒）——12 个心跳。定案见技术方案 §8.3。 */
export const DEFAULT_TAKEOVER_MS = 60_000;
/** 阈值至少要是心跳的几倍。配成 2× 会让一次正常的调度延迟就触发误判。 */
const MIN_BEATS_BEFORE_TAKEOVER = 3;

export interface LeaseArbitrationOptions {
  flavor: FlavorTraits;
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
 * const arbitration = leaseArbitration(db, { flavor: traitsOf("postgres"), holder: process.env.POD_NAME });
 * createAgentRuntime({ ..., persistence, arbitration });
 * ```
 */
export function leaseArbitration(db: Kysely<NimboDatabase>, opts: LeaseArbitrationOptions): Arbitration {
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

  /** 一行是不是「有人持有且还活着」。 */
  const isLive = (row: { lease_token: string | null; heartbeat_at: number }, at: number): boolean =>
    row.lease_token !== null && at - toNumber(row.heartbeat_at) <= takeoverMs;

  async function acquire(conversationId: string, ctx: AcquireContext): Promise<AcquireResult> {
    const at = now();
    const existing = await readRow(conversationId);

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
        opts.flavor,
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
    await db
      .updateTable(LEASES_TABLE)
      .set({ holder: opts.holder, lease_token: token, heartbeat_at: at, acquired_at: at })
      .where("conversation_id", "=", conversationId)
      .where((eb) =>
        eb.or([eb("lease_token", "is", null), eb("heartbeat_at", "<", at - takeoverMs)]),
      )
      .execute();

    const after = await readRow(conversationId);
    if (after === undefined || after.lease_token !== token) {
      // 没抢到——并发下另一个节点比我们快。报 busy 并带上**当前**持有者。
      return { ok: false, reason: "busy", holder: after?.holder ?? undefined };
    }

    return { ok: true, grant: createGrant(conversationId, token, at) };
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
    };
  }

  return {
    acquire,

    async inspect(conversationId: string): Promise<OwnershipInfo> {
      const row = await readRow(conversationId);
      if (row === undefined || !isLive(row, now())) {return { held: false };}
      return { held: true, ...(row.holder !== null ? { holder: row.holder } : {}) };
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
        .where("heartbeat_at", "<", now() - takeoverMs)
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
        .where("heartbeat_at", "<", now() - takeoverMs)
        .execute();
    },
  };
}
