/**
 * 一个进程里模拟「几个节点共用同一张租约表」：`forNode(name)` 给出那个节点眼里的仲裁机制。
 *
 * 语义照租约版（`@runko/persist-kysely` 的 `leaseArbitration`）抄最小的一份：持有 · 交接预留 · 待接手标记。
 * 没有心跳、没有超时接管——交权用例用不上，那些由一致性套件在真库上钉住。
 */
import type { AcquireContext, AcquireResult, Arbitration, Grant, OwnershipInfo, SeqResult, StaleOwnership } from "../../src/index.js";

interface Row {
  holder: string | undefined;
  token: number | undefined;
  watermark: number;
  reservedFor: string | undefined;
  reservedUntil: number;
  awaiting: boolean;
}

/** 水位还没从账本问过（行是被待接手标记先建出来的）。 */
const UNSEEDED = -1;

export interface SharedArbitration {
  forNode(node: string): Arbitration;
  /** 这份对话此刻的行（断言用）。 */
  row(conversationId: string): Readonly<Row> | undefined;
}

export function sharedArbitration(opts: { now?: () => number } = {}): SharedArbitration {
  const now = opts.now ?? Date.now;
  const rows = new Map<string, Row>();
  let nextToken = 1;

  const reservedForOther = (row: Row, node: string): boolean =>
    row.reservedFor !== undefined && row.reservedFor !== node && row.reservedUntil > now();

  function forNode(node: string): Arbitration {
    function createGrant(conversationId: string, row: Row, token: number): Grant {
      let released = false;
      const controller = new AbortController();
      const stillMine = (): boolean => !released && row.token === token;
      return {
        conversationId,
        holder: node,
        signal: controller.signal,
        get valid() {
          return stillMine();
        },
        nextSeq(): Promise<SeqResult> {
          if (!stillMine()) {return Promise.resolve({ ok: false, reason: "lost_ownership" });}
          row.watermark += 1;
          return Promise.resolve({ ok: true, seq: row.watermark });
        },
        release(): Promise<void> {
          if (stillMine()) {
            row.holder = undefined;
            row.token = undefined;
          }
          released = true;
          return Promise.resolve();
        },
        releaseTo(target: string, { ttlMs }: { ttlMs: number }): Promise<void> {
          if (stillMine()) {
            row.reservedFor = target;
            row.reservedUntil = now() + ttlMs;
            row.holder = undefined;
            row.token = undefined;
          }
          released = true;
          return Promise.resolve();
        },
      };
    }

    return {
      async acquire(conversationId: string, ctx: AcquireContext): Promise<AcquireResult> {
        const existing = rows.get(conversationId);
        if (existing?.token !== undefined) {return { ok: false, reason: "busy", holder: existing.holder };}
        if (existing !== undefined && reservedForOther(existing, node)) {return { ok: false, reason: "busy", holder: existing.reservedFor };}
        const row: Row = existing ?? { holder: undefined, token: undefined, watermark: UNSEEDED, reservedFor: undefined, reservedUntil: 0, awaiting: false };
        rows.set(conversationId, row);
        if (row.watermark === UNSEEDED) {row.watermark = await ctx.seedSeq();}
        // `await` 之后再查一遍：别的节点可能在这期间抢到了。
        if (row.token !== undefined) {return { ok: false, reason: "busy", holder: row.holder };}
        const token = nextToken++;
        row.holder = node;
        row.token = token;
        row.reservedFor = undefined;
        return { ok: true, grant: createGrant(conversationId, row, token) };
      },
      inspect(conversationId: string): Promise<OwnershipInfo> {
        const row = rows.get(conversationId);
        if (row?.token !== undefined) {return Promise.resolve({ held: true, ...(row.holder !== undefined ? { holder: row.holder } : {}) });}
        if (row?.reservedFor !== undefined && row.reservedUntil > now()) {return Promise.resolve({ held: true, holder: row.reservedFor, reserved: true });}
        return Promise.resolve({ held: false });
      },
      listStale(): Promise<StaleOwnership[]> {
        return Promise.resolve([]);
      },
      clearStale(): Promise<void> {
        return Promise.resolve();
      },
      markAwaitingTakeover(conversationId: string): Promise<void> {
        const row = rows.get(conversationId);
        if (row === undefined) {
          rows.set(conversationId, { holder: undefined, token: undefined, watermark: UNSEEDED, reservedFor: undefined, reservedUntil: 0, awaiting: true });
        } else {
          row.awaiting = true;
        }
        return Promise.resolve();
      },
      clearAwaitingTakeover(conversationId: string): Promise<void> {
        const row = rows.get(conversationId);
        if (row !== undefined) {row.awaiting = false;}
        return Promise.resolve();
      },
      listSweepCandidates({ limit }: { limit: number }): Promise<string[]> {
        const ids = [...rows.entries()]
          .filter(([, row]) => row.awaiting && row.token === undefined && !(row.reservedFor !== undefined && row.reservedUntil > now()))
          .map(([conversationId]) => conversationId);
        return Promise.resolve(ids.slice(0, limit));
      },
    };
  }

  return {
    forNode,
    row: (conversationId) => rows.get(conversationId),
  };
}
