/**
 * 把 `@runko/agent` 的运行时装进一个 Durable Object。
 *
 * 四样宿主能力在这里定死：持久化 = 对象自带 SQLite 上的 `kyselyPersistence`；归属仲裁 =
 * `durableObjectArbitration`（起轮标记落 SQLite）；流分发 = 框架缺省的进程内版（订阅者都连在这个对象上）；
 * 交权不配（平台重启对象前不发通知，交不了）。
 *
 * ## 对象被平台回收或重启之后
 *
 * 构造函数里的 `ready` 先建表、再 `recover()`：上一辈子没收尾的轮补一条「已中断」，身后排着的消息
 * 打上待接手标记；接着 `start()` 的回捞把它们推起来。
 * 没人发请求时靠 alarm 把对象叫醒：一轮开始时设一个，到点还有轮在跑就再设一个。
 * 对象在两次之间被回收了，下一次 alarm 会重新构造它，`ready` 就把上面那套跑一遍。
 *
 * ## 为什么不开定时回捞的定时器
 *
 * workerd 里挂着的 `setTimeout` / `setInterval` 会让对象一直不被回收（实测：挂一个就回收不掉，
 * 只挂一个永不 resolve 的 promise 则不受影响）。框架的[定时回捞](../../../docs/terms.md)是个常驻
 * `setInterval`，开着它对象就永远留在内存里。所以缺省关掉它，回捞改在 `alarm()` 里做。
 */
import type { AgentRuntime, AgentRuntimeOptions, Duration, RuntimeHooks } from "@runko/agent";
import { createAgentRuntime, describeError, noopLogger } from "@runko/agent";
import type { RunkoDatabase } from "@runko/persist-kysely";
import { kyselyPersistence } from "@runko/persist-kysely";
import type { Kysely } from "kysely";

import { durableObjectArbitration } from "./arbitration.js";
import type { SqlStorageLike } from "./dialect.js";
import { durableObjectKysely } from "./dialect.js";
import { durationToMs } from "./duration.js";
import { migrateDurableObject } from "./migrate.js";

const LOG_SCOPE = "durable-object:runtime";

const DEFAULT_WATCHDOG_INTERVAL: Duration = "1m";
/**
 * 对象没人连着、也没有进行中的 I/O 时会被回收，内存里等人的 promise 随之丢失。
 * 所以[内存窗口](../../../docs/terms.md)要短：一轮停下来等人，很快就[挂起](../../../docs/terms.md)落盘。
 */
const DEFAULT_MEMORY_WINDOW: Duration = "30s";
/** 一次 `alarm()` 最多推几份待接手的对话（与框架定时回捞的缺省一致）。 */
const DEFAULT_SWEEP_BATCH = 50;

/** `DurableObjectState`（构造函数的 `ctx`）的结构化最小子集。 */
export interface DurableObjectStateLike {
  readonly storage: {
    readonly sql: SqlStorageLike;
    setAlarm(scheduledTime: number): Promise<void>;
    getAlarm(): Promise<number | null>;
    deleteAlarm(): Promise<void>;
  };
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

export interface DurableObjectRuntimeOptions
  extends Omit<AgentRuntimeOptions, "persistence" | "arbitration" | "stream" | "handover"> {
  /**
   * 一轮在跑时多久靠定时唤醒（alarm）醒一次；有待接手的对话没推动时，也按这个间隔再推。
   * 缺省 `"1m"`；`0` = 不设 alarm。
   */
  watchdogInterval?: Duration;
}

export interface DurableObjectRuntime {
  readonly runtime: AgentRuntime;
  readonly db: Kysely<RunkoDatabase>;
  /**
   * 建表 → `runtime.recover()` → `runtime.start()`。`createDurableObjectRuntime` 内部已用
   * `ctx.blockConcurrencyWhile` 包住它（先恢复、再处理请求），也暴露出来给调用方 await。
   */
  readonly ready: Promise<void>;
  /** 在 DO 类的 `alarm()` 里调。 */
  alarm(): Promise<void>;
}

/**
 * 两项缺省值：内存窗口 30 秒；定时回捞的定时器关掉（理由见文件头）。调用方配了的照用。
 *
 * 内存窗口只在调用方什么都没配时才补：配了废弃的 `human.*TimeoutMs` 却没配
 * `suspend.memoryWindow` 的，补上它会让那两项被框架忽略。
 */
function withDefaults(options: DurableObjectRuntimeOptions): Pick<AgentRuntimeOptions, "suspend" | "sweep"> {
  const legacyWindow = options.human?.approvalTimeoutMs !== undefined || options.human?.askUserTimeoutMs !== undefined;
  const memoryWindow = options.suspend?.memoryWindow ?? (legacyWindow ? undefined : DEFAULT_MEMORY_WINDOW);
  return {
    suspend: { ...options.suspend, ...(memoryWindow !== undefined ? { memoryWindow } : {}) },
    sweep: { ...options.sweep, interval: options.sweep?.interval ?? 0 },
  };
}

export function createDurableObjectRuntime(ctx: DurableObjectStateLike, options: DurableObjectRuntimeOptions): DurableObjectRuntime {
  const { watchdogInterval, ...agentOptions } = options;
  const watchdogMs = durationToMs(watchdogInterval ?? DEFAULT_WATCHDOG_INTERVAL, "watchdogInterval");
  const sweepBatch = options.sweep?.batch ?? DEFAULT_SWEEP_BATCH;
  const logger = options.logger ?? noopLogger;
  const db = durableObjectKysely<RunkoDatabase>(ctx.storage.sql);
  const arbitration = durableObjectArbitration(db);
  const userHooks: RuntimeHooks = options.hooks ?? {};
  /** 本实例上起过轮的会话。`alarm()` 逐个问还在不在跑，不在的就移出去。 */
  const watched = new Set<string>();

  /** 设 alarm。已经有一个不晚于目标时刻的就不动它：它到点时 `alarm()` 会接着设。 */
  async function armWatchdog(): Promise<void> {
    if (watchdogMs === 0) {
      return;
    }
    const target = Date.now() + watchdogMs;
    const pending = await ctx.storage.getAlarm();
    if (pending !== null && pending <= target) {
      return;
    }
    await ctx.storage.setAlarm(target);
  }

  async function hasSweepCandidates(): Promise<boolean> {
    return ((await arbitration.listSweepCandidates?.({ limit: 1 })) ?? []).length > 0;
  }

  const runtime = createAgentRuntime({
    ...agentOptions,
    ...withDefaults(options),
    persistence: kyselyPersistence(db, { flavor: "sqlite" }),
    arbitration,
    hooks: {
      ...userHooks,
      onTurnStart: (event) => {
        watched.add(event.conversationId);
        void armWatchdog().catch((error: unknown) => {
          logger.warn(LOG_SCOPE, "could not set the watchdog alarm", {
            conversationId: event.conversationId,
            error: describeError(error),
          });
        });
        userHooks.onTurnStart?.(event);
      },
    },
  });

  const ready = ctx.blockConcurrencyWhile(async () => {
    await migrateDurableObject(db);
    await runtime.recover();
    await runtime.start();
    // `start()` 那一次回捞没推动的（比如推的时候抛了），交给下一次 alarm 再推。
    if (await hasSweepCandidates()) {
      await armWatchdog();
    }
  });
  // 调用方不 await 它也不该冒出未处理的 rejection；await 它的照样拿到原来的错误。
  void ready.catch((error: unknown) => {
    logger.error(LOG_SCOPE, "durable object runtime failed to start", { error: describeError(error) });
  });

  return {
    runtime,
    db,
    ready,
    async alarm(): Promise<void> {
      await ready;
      // 定时回捞的那一份活：推一把打了待接手标记、此刻没人在跑的对话。
      const candidates = (await arbitration.listSweepCandidates?.({ limit: sweepBatch })) ?? [];
      if (candidates.length > 0) {
        await runtime.takeOver(candidates);
      }
      let busy = false;
      for (const conversationId of [...watched]) {
        const activity = await runtime.getActivity(conversationId);
        if (activity.active && activity.local) {
          busy = true;
        } else {
          watched.delete(conversationId);
        }
      }
      if (watchdogMs > 0 && (busy || (await hasSweepCandidates()))) {
        await ctx.storage.setAlarm(Date.now() + watchdogMs);
      }
    },
  };
}
