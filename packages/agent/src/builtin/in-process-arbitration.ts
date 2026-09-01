/**
 * 内置的**平凡[归属仲裁机制](../../../docs/terms.md)**：进程内一个 Map。
 *
 * 「[独占](../../../docs/terms.md)」在单进程下同样成立，只是内存里一个 Map 就满足了，
 * 看不出来——这一步把**要求**（永远成立）和**实现**（部署形态的函数）分开了。
 *
 * 三样东西这一档全都没有：没有[租期标识](../../../docs/terms.md)、不用 CAS、`holder`
 * 与心跳不落库。`signal` 因此永不 abort，`nextSeq` 永远 `ok`——但轮编排照样要写那两支，
 * 否则换成租约版就是静默数据损坏。
 *
 * `listStale()` 恒空**不是偷懒**：标记跟进程同生共死，进程一没标记也没了，所以它
 * 结构上就看不到自己上次崩溃的残留。要做[崩溃恢复](../../../docs/terms.md)就得有一个
 * 跨进程的落地实现（宿主提供，见 `apps/node-server` 的 drizzle 版）。
 */
import type {
  AcquireContext,
  AcquireResult,
  Arbitration,
  Grant,
  OwnershipInfo,
  SeqResult,
  StaleOwnership,
} from "../arbitration.js";

interface Entry {
  holder: string;
  /** 这个会话账本的 seq 水位（首次抢占时用 `seedSeq` 回库里问一次，之后常驻内存）。 */
  watermark: number;
  /** 当前那次租期的句柄；`undefined` = 没人持有（水位仍然留着）。 */
  grant: Grant | undefined;
}

export interface InProcessArbitrationOptions {
  /**
   * 这个进程的不透明标识——框架原样透传给 `getActivity`，[接入层](../../../docs/terms.md)
   * 拿它做转发。单进程用不上，给个默认值即可。
   */
  holder?: string;
}

export function inProcessArbitration(opts: InProcessArbitrationOptions = {}): Arbitration {
  const holder = opts.holder ?? "in-process";
  const entries = new Map<string, Entry>();

  return {
    async acquire(conversationId: string, ctx: AcquireContext): Promise<AcquireResult> {
      const existing = entries.get(conversationId);
      if (existing?.grant !== undefined) {
        return { ok: false, reason: "busy", holder: existing.holder };
      }
      // 水位只在这个会话第一次被抢占时回库里问一次（`seedSeq` 是惰性的，抢不到时
      // 上面已经 return 了，不会白查）。之后常驻内存——进程内它就是权威。
      const watermark = existing?.watermark ?? (await ctx.seedSeq());

      const controller = new AbortController();
      let released = false;
      const entry: Entry = { holder, watermark, grant: undefined };

      const grant: Grant = {
        conversationId,
        holder,
        signal: controller.signal,
        get valid(): boolean {
          return !released;
        },
        nextSeq(): Promise<SeqResult> {
          if (released) {return Promise.resolve({ ok: false, reason: "lost_ownership" });}
          entry.watermark += 1;
          return Promise.resolve({ ok: true, seq: entry.watermark });
        },
        release(): Promise<void> {
          if (released) {return Promise.resolve();}
          released = true;
          // 只清 grant，水位留着——同一个会话的下一轮要从这儿接着数。
          if (entries.get(conversationId) === entry) {entry.grant = undefined;}
          return Promise.resolve();
        },
      };

      entry.grant = grant;
      entries.set(conversationId, entry);
      return { ok: true, grant };
    },
    inspect(conversationId: string): Promise<OwnershipInfo> {
      const existing = entries.get(conversationId);
      if (existing?.grant === undefined) {return Promise.resolve({ held: false });}
      return Promise.resolve({ held: true, holder: existing.holder });
    },
    listStale(): Promise<StaleOwnership[]> {
      return Promise.resolve([]); // 见文件头
    },
    clearStale(): Promise<void> {
      return Promise.resolve();
    },
  };
}
