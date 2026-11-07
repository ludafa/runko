/**
 * Durable Object 这一档的[归属仲裁机制](../../../docs/terms.md)。
 *
 * ## 独占在内存里判，起轮标记落 SQLite
 *
 * 平台保证一个 Durable Object 同一时刻只有一个实例，所以[独占](../../../docs/terms.md)是**真保证**，
 * 跟进程内那一档一样用内存里一个 Map 就够；seq 水位也一样：首次抢占问一次 `seedSeq()`，之后常驻内存。
 *
 * 不同的只有[起轮标记](../../../docs/terms.md)：进程内那一档的标记跟进程同生共死，`listStale()` 恒空；
 * 对象被平台重启后 `runtime.recover()` 就什么都扫不到，没收尾的轮永远停在「在跑」。
 * 所以这里把标记写进 SQLite，记上本实例的 id。重启后的新实例 id 不同，
 * 标记上的 id 不是自己的，就一定是上一辈子留下的——这就是 `listStale()` 的判据。
 *
 * [待接手](../../../docs/terms.md)标记也落 SQLite：`recover()` 发现崩掉那一轮身后还排着消息时打上它，
 * `start()` 的回捞据此把消息推起来。
 */
import type {
  AcquireContext,
  AcquireResult,
  Arbitration,
  Grant,
  OwnershipInfo,
  SeqResult,
  StaleOwnership,
  Takeover,
} from "@runko/agent";
import type { RunkoDatabase } from "@runko/persist-kysely";
import type { Kysely } from "kysely";

import type { OwnershipTables } from "./migrate.js";
import { OWNERSHIP_TABLE } from "./migrate.js";

export const DEFAULT_DURABLE_OBJECT_HOLDER = "durable-object";

export interface DurableObjectArbitrationOptions {
  /** 报给框架的持有者标识（`getActivity().holder` 里看到的就是它）。缺省 `"durable-object"`。 */
  holder?: string;
  /** 本实例的标识，写进起轮标记。缺省 `crypto.randomUUID()`：对象每被构造一次就是一个新实例。 */
  instanceId?: string;
}

interface Entry {
  /** 这个会话账本的 seq 水位。 */
  watermark: number;
  /** 当前那次持有的句柄；`undefined` = 没人持有（水位仍然留着）。 */
  grant: Grant | undefined;
}

export function durableObjectArbitration(db: Kysely<RunkoDatabase>, opts: DurableObjectArbitrationOptions = {}): Arbitration {
  const holder = opts.holder ?? DEFAULT_DURABLE_OBJECT_HOLDER;
  const instanceId = opts.instanceId ?? crypto.randomUUID();
  const tables = db.withTables<OwnershipTables>();
  const entries = new Map<string, Entry>();
  /** 抢占进行到一半（在等 `seedSeq` 或写标记）的会话：这期间再来抢的一律 `busy`。 */
  const claiming = new Set<string>();
  /** 每个会话那一行的写入队列，见 `serial`。 */
  const writes = new Map<string, Promise<unknown>>();

  /**
   * 同一个会话那一行的写入按调用顺序排队落库。
   *
   * 否则上一轮放手时的「清标记」可能落在下一轮起轮的「写标记」之后，把新标记擦掉——
   * 放手时内存里已经先放了，同一时刻进来的请求可以马上抢到。
   */
  function serial<T>(conversationId: string, write: () => Promise<T>): Promise<T> {
    const previous = writes.get(conversationId) ?? Promise.resolve();
    const next = previous.then(write, write);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    writes.set(conversationId, settled);
    void settled.then(() => {
      if (writes.get(conversationId) === settled) {
        writes.delete(conversationId);
      }
    });
    return next;
  }

  function isHeld(conversationId: string): boolean {
    return entries.get(conversationId)?.grant !== undefined || claiming.has(conversationId);
  }

  /** 写起轮标记。标记上原来挂着别的实例 = 上一辈子没收尾的那一轮被这次顶掉了，报 `takeover`。 */
  function writeStartMark(conversationId: string): Promise<Takeover | undefined> {
    return serial(conversationId, async () => {
      const previous = await tables
        .selectFrom(OWNERSHIP_TABLE)
        .select(["instance_id", "holder"])
        .where("conversation_id", "=", conversationId)
        .executeTakeFirst();
      const now = Date.now();
      await tables
        .insertInto(OWNERSHIP_TABLE)
        .values({
          conversation_id: conversationId,
          instance_id: instanceId,
          holder,
          acquired_at: now,
          awaiting_takeover: 0,
          updated_at: now,
        })
        .onConflict((oc) =>
          oc.column("conversation_id").doUpdateSet({ instance_id: instanceId, holder, acquired_at: now, updated_at: now }),
        )
        .execute();
      const displaced = previous?.instance_id;
      if (displaced === null || displaced === undefined || displaced === instanceId) {
        return undefined;
      }
      return previous?.holder !== null && previous?.holder !== undefined ? { holder: previous.holder } : {};
    });
  }

  /** 抹掉本实例写的起轮标记。只认自己的 id：别的实例留下的那条归 `clearStale` 管。 */
  function clearStartMark(conversationId: string): Promise<void> {
    return serial(conversationId, async () => {
      await tables
        .updateTable(OWNERSHIP_TABLE)
        .set({ instance_id: null, holder: null, acquired_at: null, updated_at: Date.now() })
        .where("conversation_id", "=", conversationId)
        .where("instance_id", "=", instanceId)
        .execute();
    });
  }

  function createGrant(conversationId: string, entry: Entry): Grant {
    // 平台保证单实例，没人能从外面夺走归属，所以它永不 abort——轮编排照样要接上它（见 `Grant.signal`）。
    const controller = new AbortController();
    let released = false;
    const grant: Grant = {
      conversationId,
      holder,
      signal: controller.signal,
      get valid(): boolean {
        return !released;
      },
      nextSeq(): Promise<SeqResult> {
        if (released) {
          return Promise.resolve({ ok: false, reason: "lost_ownership" });
        }
        entry.watermark += 1;
        return Promise.resolve({ ok: true, seq: entry.watermark });
      },
      async release(): Promise<void> {
        if (released) {
          return;
        }
        released = true;
        // 只清 grant，水位留着——同一个会话的下一轮要从这儿接着数。
        if (entry.grant === grant) {
          entry.grant = undefined;
        }
        await clearStartMark(conversationId);
      },
    };
    return grant;
  }

  return {
    async acquire(conversationId: string, ctx: AcquireContext): Promise<AcquireResult> {
      if (isHeld(conversationId)) {
        return { ok: false, reason: "busy", holder };
      }
      // 先同步占住，再去打库：两次抢占不能都从「没人持有」出发。
      claiming.add(conversationId);
      try {
        const known = entries.get(conversationId);
        const entry: Entry = known ?? { watermark: await ctx.seedSeq(), grant: undefined };
        const takeover = await writeStartMark(conversationId);
        const grant = createGrant(conversationId, entry);
        entry.grant = grant;
        entries.set(conversationId, entry);
        return { ok: true, grant, ...(takeover !== undefined ? { takeover } : {}) };
      } finally {
        claiming.delete(conversationId);
      }
    },

    inspect(conversationId: string): Promise<OwnershipInfo> {
      const grant = entries.get(conversationId)?.grant;
      return Promise.resolve(grant === undefined ? { held: false } : { held: true, holder: grant.holder });
    },

    async listStale(): Promise<StaleOwnership[]> {
      const rows = await tables
        .selectFrom(OWNERSHIP_TABLE)
        .select(["conversation_id", "holder"])
        .where("instance_id", "is not", null)
        .where("instance_id", "!=", instanceId)
        .orderBy("conversation_id")
        .execute();
      return rows.map((row) => ({
        conversationId: row.conversation_id,
        ...(row.holder !== null ? { holder: row.holder } : {}),
      }));
    },

    clearStale(conversationId: string): Promise<void> {
      return serial(conversationId, async () => {
        await tables
          .updateTable(OWNERSHIP_TABLE)
          .set({ instance_id: null, holder: null, acquired_at: null, updated_at: Date.now() })
          .where("conversation_id", "=", conversationId)
          .where("instance_id", "is not", null)
          .where("instance_id", "!=", instanceId)
          .execute();
      });
    },

    markAwaitingTakeover(conversationId: string): Promise<void> {
      return serial(conversationId, async () => {
        const now = Date.now();
        await tables
          .insertInto(OWNERSHIP_TABLE)
          .values({
            conversation_id: conversationId,
            instance_id: null,
            holder: null,
            acquired_at: null,
            awaiting_takeover: 1,
            updated_at: now,
          })
          .onConflict((oc) => oc.column("conversation_id").doUpdateSet({ awaiting_takeover: 1, updated_at: now }))
          .execute();
      });
    },

    clearAwaitingTakeover(conversationId: string): Promise<void> {
      return serial(conversationId, async () => {
        await tables
          .updateTable(OWNERSHIP_TABLE)
          .set({ awaiting_takeover: 0, updated_at: Date.now() })
          .where("conversation_id", "=", conversationId)
          .where("awaiting_takeover", "=", 1)
          .execute();
      });
    },

    /** 打了待接手标记、此刻内存里没人持有的会话。这一档没有交接预留，不用看它。 */
    async listSweepCandidates(opts: { limit: number }): Promise<string[]> {
      const rows = await tables
        .selectFrom(OWNERSHIP_TABLE)
        .select("conversation_id")
        .where("awaiting_takeover", "=", 1)
        .orderBy("updated_at")
        .orderBy("conversation_id")
        .execute();
      return rows
        .map((row) => row.conversation_id)
        .filter((conversationId) => !isHeld(conversationId))
        .slice(0, opts.limit);
    },
  };
}
