/**
 * `createAgentRuntime` —— 本包的门面。
 *
 * `@nimbo/core` 的 `Session` 管「跑一轮」，这里管「**一轮接一轮**」：起、[停止](../../docs/terms.md)、
 * 收尾、[排队](../../docs/terms.md)与[插话](../../docs/terms.md)、人在回路、[交权](../../docs/terms.md)、
 * [崩溃恢复](../../docs/terms.md)。四样宿主能力全部可替换，**都带内置的平凡实现**，所以
 * 零配置就能跑。
 *
 * 框架**不碰 HTTP**：`subscribe` 给的是中立的 `AsyncIterable`，序列化成 SSE / WebSocket
 * 是[接入层](../../docs/terms.md)的事。
 */
import type { AgentDefinition, NimboUIMessage } from "@nimbo/core";

import type { Arbitration } from "./arbitration.js";
import { inProcessArbitration } from "./builtin/in-process-arbitration.js";
import { inProcessStream } from "./builtin/in-process-stream.js";
import { memoryPersistence } from "./builtin/memory-persistence.js";
import type { Logger } from "./logger.js";
import { describeError, noopLogger } from "./logger.js";
import type { Persistence } from "./persistence.js";
import type { TurnPreparer } from "./prepare.js";
import type { RuntimeContext, RuntimeHooks, SteerPolicy } from "./runtime/context.js";
import { HumanBridge } from "./runtime/human.js";
import type { SubmittedDecision } from "./runtime/human.js";
import { enqueue as enqueueInput, publishQueue, startNextQueued, startTurn } from "./runtime/queue.js";
import type { EnqueueOptions } from "./runtime/queue.js";
import { TurnRegistry } from "./runtime/registry.js";
import type { ActiveTurn } from "./runtime/registry.js";
import { ABORT_DENY_MESSAGE, ABORT_REASON_SHUTDOWN, ABORT_REASON_USER } from "./runtime/reasons.js";
import { defaultSessionFactory } from "./runtime/session-factory.js";
import type { SessionFactory } from "./runtime/session-factory.js";
import type { StreamFanout } from "./stream.js";
import type {
  ConversationActivity,
  EnqueueResult,
  Frame,
  QueuedInput,
  TurnInput,
} from "./types.js";

const LOG_SCOPE = "agent:runtime";

/** 默认值：人多久不理算放弃。纯产品决策，宿主可改。 */
const DEFAULT_APPROVAL_TIMEOUT_MS = 240_000;
const DEFAULT_ASK_USER_TIMEOUT_MS = 240_000;
/** [交权](../../docs/terms.md)宽限期：正在干活的轮，等多久还没收尾就不等了。 */
const DEFAULT_SHUTDOWN_GRACE_MS = 15_000;
const DEFAULT_QUEUE_MAX = 10;

export interface AgentRuntimeOptions {
  /** agent 的纯声明值（模型、指令、工具、skills）。每一项都能被 `prepareTurn` 逐轮覆盖。 */
  agent: AgentDefinition;
  /**
   * 每一轮开始时调它一次，交出这一轮要用的东西。**最少只要给出执行面**：
   * `prepareTurn: () => ({ fs, exec })`。
   */
  prepareTurn: TurnPreparer;
  /** 缺省 = 内存实现（进程一重启历史就没了，够跑通够写测试）。 */
  persistence?: Persistence;
  /** 缺省 = 进程内 fan-out。跨实例时换 `@nimbo/stream-redis`。 */
  stream?: StreamFanout;
  /** 缺省 = 进程内一个 Map。多进程共享 DB 时换租约版。 */
  arbitration?: Arbitration;
  /** 缺省 = core 的 `createSession` + 文件工具八件套默认装配。测试可注入假 session。 */
  sessionFactory?: SessionFactory;
  /** 缺省彻底静音——库不该替宿主决定日志往哪去。 */
  logger?: Logger;
  /** 观测/通知挂钩，全部可选、全部只报告。 */
  hooks?: RuntimeHooks;
  /** [排队](../../docs/terms.md)与[插话](../../docs/terms.md)的产品策略。 */
  queue?: {
    enabled?: boolean;
    max?: number;
    onFull?: "reject" | "dropOldest";
    /** 见 `SteerPolicy`：三个枚举档，或一个按 `TurnInput` 自己判断的回调。 */
    steer?: SteerPolicy;
  };
  human?: {
    approvalTimeoutMs?: number;
    askUserTimeoutMs?: number;
    /** 注册内置 `ask-user` 工具（缺省开）。 */
    askUser?: boolean;
  };
  shutdown?: { graceMs?: number };
}

export interface SubscribeOptions {
  /** 断线续传游标：只回放 seq 大于它的成品消息。 */
  after?: number;
  /** `'turn'`（默认）= 这一轮结束就收线（没有轮在跑时回放完即收）；`'forever'` = 一直挂着，靠 `signal` 收。 */
  follow?: "turn" | "forever";
  signal?: AbortSignal;
}

export interface ShutdownResult {
  /** 这次关闭中止了几个轮（含还在[起轮装配](../../docs/terms.md)里的）。 */
  aborted: number;
  /** 是否全部收尾完毕。`false` = 撞了宽限期上限，还有轮没等到。 */
  settled: boolean;
  /** 撞超时时还剩几个没收尾。 */
  pending: number;
}

export interface RecoveryResult {
  /** 扫到几个还留着[起轮标记](../../docs/terms.md)的会话。 */
  scanned: number;
  /** 给几个补了「已停止」收尾。 */
  recovered: number;
}

export interface AgentRuntime {
  /** 用户发消息。忙不忙、排队还是插话、要不要起轮，**框架自己判**。 */
  enqueue(conversationId: string, input: TurnInput, opts?: EnqueueOptions): Promise<EnqueueResult>;
  /** 实时流：先回放，再直播。中立的 `AsyncIterable`，序列化归接入层。 */
  subscribe(conversationId: string, opts?: SubscribeOptions): AsyncGenerator<Frame, void>;
  /** 人做出裁决。`false` = 没有这条挂起项（已结、已超时、从未存在）→ 接入层转 404。 */
  submitDecision(conversationId: string, callId: string, decision: SubmittedDecision): Promise<boolean>;
  /** 人回答了 `ask-user`。语义同上。 */
  submitAnswer(conversationId: string, callId: string, answer: string): Promise<boolean>;
  /** [停止](../../docs/terms.md)进行中的那一轮 + 清空[待发队列](../../docs/terms.md)。`false` = 没有轮可停。 */
  abort(conversationId: string, reason?: string): Promise<boolean>;
  /** 这个会话此刻在不在跑、谁在跑（多节点时接入层据 `holder` 转发）。 */
  getActivity(conversationId: string): Promise<ConversationActivity>;
  listQueue(conversationId: string): Promise<QueuedInput[]>;
  removeQueued(conversationId: string, id: string): Promise<{ removed: boolean; queue: QueuedInput[] }>;
  clearQueue(conversationId: string): Promise<QueuedInput[]>;
  /** 读[账本](../../docs/terms.md)（回放历史用；`subscribe` 已经包含回放，这个给「只要历史」的端点）。 */
  readLedger(conversationId: string, opts?: { afterSeq?: number }): Promise<{ seq: number; message: NimboUIMessage }[]>;
  /** 启动扫描：给[孤儿轮](../../docs/terms.md)补「已停止」收尾。只在进程启动、开始服务之前跑一次。 */
  recover(): Promise<RecoveryResult>;
  /** [交权](../../docs/terms.md)：停掉在跑的轮并等它们收尾。**不退进程**——那是宿主的事。 */
  shutdown(opts?: { graceMs?: number }): Promise<ShutdownResult>;
  /** 进程是否正在[优雅关闭](../../docs/terms.md)（接入层据此转 503）。 */
  isShuttingDown(): boolean;
}

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  const logger = options.logger ?? noopLogger;
  const persistence = options.persistence ?? memoryPersistence();
  const stream = options.stream ?? inProcessStream();
  const arbitration = options.arbitration ?? inProcessArbitration();
  const registry = new TurnRegistry();
  const hooks = options.hooks ?? {};
  let shuttingDown = false;

  const human = new HumanBridge({
    registry,
    decisions: persistence.decisions,
    approvalTimeoutMs: options.human?.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
    askUserTimeoutMs: options.human?.askUserTimeoutMs ?? DEFAULT_ASK_USER_TIMEOUT_MS,
    logger,
    ...(hooks.onApprovalPending !== undefined ? { onApprovalPending: hooks.onApprovalPending } : {}),
    ...(hooks.onQuestionPending !== undefined ? { onQuestionPending: hooks.onQuestionPending } : {}),
  });

  const ctx: RuntimeContext = {
    agent: options.agent,
    prepareTurn: options.prepareTurn,
    persistence,
    stream,
    arbitration,
    registry,
    human,
    sessionFactory: options.sessionFactory ?? defaultSessionFactory,
    logger,
    hooks,
    queue: {
      enabled: options.queue?.enabled ?? true,
      max: options.queue?.max ?? DEFAULT_QUEUE_MAX,
      onFull: options.queue?.onFull ?? "reject",
      steer: options.queue?.steer ?? "onRequest",
    },
    askUser: options.human?.askUser ?? true,
    isShuttingDown: () => shuttingDown,
  };

  /**
   * 停止一轮的**四步，顺序都是硬要求**：
   *
   * 1. 幂等——已请求过就直接返回，连点停止键不会重复走收尾。
   * 2. **先置 `aborted` 标志**，它同时是「别再挂新的人审」的闸门。
   * 3. **结掉已经挂起的人审/提问**——core 正 `await` 那些 promise 时 abort 信号对它毫无
   *    作用，这是整个功能里唯一一处「光有 abort 信号不够」的地方。
   * 4. **最后 abort**：信号一放出去这一轮随时可能收尾，此后再碰它的状态就没有意义了。
   */
  async function abortTurn(turn: ActiveTurn, reason: string): Promise<void> {
    if (turn.aborted) {return;}
    turn.aborted = true;
    turn.abortReason = reason;
    logger.info(LOG_SCOPE, "turn abort requested", {
      conversationId: turn.conversationId,
      phase: turn.phase,
      pendingReviews: turn.pendingReviews.size,
      pendingQuestions: turn.pendingQuestions.size,
    });
    await human.settleAllPending(turn, ABORT_DENY_MESSAGE);
    turn.abortController.abort(new Error(reason));
  }

  async function* subscribe(conversationId: string, opts: SubscribeOptions = {}): AsyncGenerator<Frame, void> {
    const follow = opts.follow ?? "turn";
    const buffer: Frame[] = [];
    let ended = false;
    let wake: () => void = () => undefined;
    let waiter = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const scheduleWake = (): void => {
      const resolve = wake;
      waiter = new Promise<void>((next) => {
        wake = next;
      });
      resolve();
    };

    // ① **先挂订阅**（同步，`StreamFanout.subscribe` 的硬要求），再去回放——反过来的话
    //    两步之间产生的内容既不在回放里、也没被订阅到，那才是真丢。
    const unsubscribe = stream.subscribe(conversationId, (frame) => {
      buffer.push(frame);
      scheduleWake();
    });
    const onAbort = (): void => {
      ended = true;
      scheduleWake();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    // 已经 abort 的 signal 不会再触发事件——不先判一次的话 `ended` 永远为 false，
    // `follow:'forever'` 会卡在 `await waiter` 上再也不收线，`stream.subscribe` 的
    // 监听器也一直留在 Set 里。SSE 处理器把 `req.signal` 透进来、客户端在开始迭代
    // 之前就断开，走的正是这条路：每断一次漏一个。
    if (opts.signal?.aborted === true) {ended = true;}

    try {
      // ② 回放账本里 `after` 之后的成品消息。
      let maxSeq = opts.after ?? 0;
      const entries = await persistence.ledger.read(conversationId, opts.after !== undefined ? { afterSeq: opts.after } : {});
      for (const entry of entries) {
        yield { kind: "message", seq: entry.seq, message: entry.message };
        maxSeq = Math.max(maxSeq, entry.seq);
      }

      // ③ **同步临界区**：取[进行中草稿](../../docs/terms.md)快照，并把回放期间攒下的
      //    缓冲丢掉——那些帧要么已经在快照里（重复发无害，重放是幂等的），要么是纯增量
      //    （`text-delta` 之类，脱离顺序重放反而会写坏）。中间**不能有 `await`**：Node
      //    单线程，同步段内没有别的东西能插进来，所以这样写就是零空隙。
      const turn = registry.get(conversationId);
      const active = turn !== undefined;
      const holder = turn?.grant.holder;
      const draft = turn === undefined ? [] : [...turn.draft];
      // **只丢 chunk 与快照帧，`message` 帧必须留下。**
      // - `chunk`：要么已经在草稿快照里（重复发无害），要么是纯增量（`text-delta`
      //   之类，脱离顺序重放反而会写坏）。
      // - `queue` / `activity`：紧接着第 ④ 步就发权威快照，留着会让过期的那份排在
      //   新的后面。
      // - `message`：**两样都不是**。`finalize` 是在上面那次 `ledger.read` 取过快照
      //   **之后**才落盘并广播的，所以它既不在回放里、也不在草稿里；丢掉它这条成品
      //   消息对本次订阅就永久消失了——而收尾窗口里重连恰恰是最该管用的那一刻。
      //   留下来走第 ⑤ 步既有的 `seq <= maxSeq` 去重，重复也不会多发。
      const carried = buffer.filter((frame): frame is Extract<Frame, { kind: "message" }> => frame.kind === "message");
      buffer.length = 0;

      for (const chunk of draft) {yield { kind: "chunk", chunk };}

      // 回放期间落盘并广播的成品消息，就地补发——**必须在下面那两帧快照和
      // `follow:'turn'` 的提前 return 之前**：`finalize` 广播 `message` 的同时也广播了
      // `activity:false`，等走到第 ⑤ 步的直播循环时这个生成器早就 return 了。
      for (const frame of carried) {
        if (frame.seq <= maxSeq) {continue;}
        maxSeq = frame.seq;
        yield frame;
      }

      // ④ 两帧权威快照：队列、以及[轮状态](../../docs/terms.md)。**每条连接必发**——任何
      //    时候连上/重连拿到的都是当下的真实状态，而不是靠客户端猜。
      yield { kind: "queue", queue: await persistence.queue.list(conversationId) };
      yield { kind: "activity", active, ...(holder !== undefined ? { holder } : {}) };

      if (!active && follow === "turn") {return;}

      // ⑤ 直播。「先看有没有货，没货才等」——`scheduleWake` 换新 promise 的写法下，一个在
      //    本循环 yield 期间到达的帧唤醒的是已经没人等的旧 promise，那次唤醒会丢；先看
      //    缓冲就让丢唤醒不再有后果。
      while (!ended) {
        if (buffer.length === 0) {
          await waiter;
          continue;
        }
        const pending = buffer.splice(0, buffer.length);
        for (const frame of pending) {
          if (frame.kind === "message") {
            if (frame.seq <= maxSeq) {continue;} // 回放已经覆盖过——去重
            maxSeq = frame.seq;
          }
          yield frame;
          if (follow === "turn" && frame.kind === "activity" && !frame.active) {
            ended = true;
            break;
          }
        }
      }
    } finally {
      unsubscribe();
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  return {
    enqueue(conversationId, input, opts) {
      return enqueueInput(ctx, conversationId, input, opts);
    },

    subscribe,

    submitDecision(conversationId, callId, decision) {
      return human.settleReview(conversationId, callId, decision);
    },

    submitAnswer(conversationId, callId, answer) {
      return human.settleQuestion(conversationId, callId, { outcome: "answered", answer });
    },

    async abort(conversationId, reason = ABORT_REASON_USER) {
      const turn = registry.get(conversationId);
      // 判定「有没有轮在跑」必须在清队列**之前**：没有轮在跑时清队列会把一次误点变成
      // 一次丢消息（队列本来要等下一次轮收尾才发）。
      if (turn === undefined) {return false;}

      // 清队列必须在 abort **之前**：这一轮收尾时会自动[出队](../../docs/terms.md)起下一轮，
      // 先 abort 再清存在真实竞态——abort 解开挂起的审批后这一轮可能立刻收尾，队首那条
      // 就被发出去了，而用户刚按的是「停止」。先清后 abort 则结构上不可能。
      const queue = await persistence.queue.clear(conversationId);
      publishQueue(ctx, conversationId, queue);

      // 清队列这一趟对真库要走网络往返，期间那一轮可能已经收尾、位子被下一轮顶替。
      // 不重新确认就 `abortTurn(旧 turn)`：什么都没停，却返回 `true`——用户看到
      // 「已停止」，实际有一轮在跑。取当下的那一个才是用户按下停止时的意图。
      const current = registry.get(conversationId);
      if (current === undefined) {return false;}

      await abortTurn(current, reason);
      return true;
    },

    async getActivity(conversationId) {
      const local = registry.get(conversationId);
      if (local !== undefined) {
        return { active: true, phase: local.phase, holder: local.grant.holder, local: true };
      }
      const info = await arbitration.inspect(conversationId);
      return {
        active: info.held,
        ...(info.holder !== undefined ? { holder: info.holder } : {}),
        local: false,
      };
    },

    listQueue(conversationId) {
      return persistence.queue.list(conversationId);
    },

    async removeQueued(conversationId, id) {
      const result = await persistence.queue.remove(conversationId, id);
      if (result.removed) {publishQueue(ctx, conversationId, result.queue);}
      return result;
    },

    async clearQueue(conversationId) {
      const queue = await persistence.queue.clear(conversationId);
      publishQueue(ctx, conversationId, queue);
      return queue;
    },

    async readLedger(conversationId, opts) {
      const entries = await persistence.ledger.read(conversationId, opts);
      return entries.map((entry) => ({ seq: entry.seq, message: entry.message }));
    },

    /**
     * [崩溃恢复](../../docs/terms.md)：库里还留着[起轮标记](../../docs/terms.md)= 那一轮
     * 没人管了（进程被强杀、OOM、断电），补一条「已停止」。
     *
     * **判据是直接的**——不再依赖「chunk 行会被 GC 掉」这个副作用，GC 漏跑不会再把活着
     * 的轮误判成孤儿。幂等：补完就把标记清了，再跑一次扫不到它。
     *
     * 顺序是**先清标记再抢归属**：标记还在的话 `acquire` 会被自己要恢复的那条挡成
     * `busy`。只在进程启动、开始服务之前跑，那时不可能有活跃轮，所以没有竞态。
     */
    async recover() {
      const stale = await arbitration.listStale();
      let recovered = 0;
      for (const entry of stale) {
        const { conversationId } = entry;
        try {
          await arbitration.clearStale(conversationId);
          const acquired = await arbitration.acquire(conversationId, {
            seedSeq: () => persistence.ledger.maxSeq(conversationId),
          });
          if (!acquired.ok) {continue;}
          try {
          const allocated = await acquired.grant.nextSeq();
          if (allocated.ok) {
            // 一条**空 parts 的 assistant 消息**承载收尾 metadata——形状与 core 自己在
            // 「首步之前就失败」时造的占位消息同源，界面据 `status` 显示「已停止」。
            const message: NimboUIMessage = {
              id: `turn-interrupted-${String(allocated.seq)}`,
              role: "assistant",
              parts: [],
              metadata: {
                usage: {},
                status: "interrupted",
                error: { code: "aborted", message: ABORT_REASON_SHUTDOWN },
              },
            };
            await persistence.ledger.append({ conversationId, seq: allocated.seq, message, ts: Date.now() });
            recovered += 1;
            logger.info(LOG_SCOPE, "recovered orphaned turn", { conversationId, seq: allocated.seq });
          }
          } finally {
            // 放在 finally 里：`nextSeq`/`append` 抛错时也要还回去，否则这个会话的
            // 归属被一个已经没人管的 grant 永久占着，此后再也起不了轮。
            await acquired.grant.release();
          }
        } catch (error) {
          // 一个会话恢复失败不该让整轮扫描停下——记一行，继续下一个。
          logger.error(LOG_SCOPE, "failed to recover orphaned turn", { conversationId, error: describeError(error) });
        }
      }
      if (recovered > 0) {logger.warn(LOG_SCOPE, "startup sweep finished", { scanned: stale.length, recovered });}
      else {logger.debug(LOG_SCOPE, "startup sweep finished, nothing to recover", { scanned: stale.length });}
      return { scanned: stale.length, recovered };
    },

    /**
     * [交权](../../docs/terms.md)。四步的顺序都是硬要求：
     *
     * 1. **先置关闭闸门**，否则收尾期间[自动出队](../../docs/terms.md)会源源不断起新轮，
     *    这个函数永远等不完。
     * 2. 快照当前全部活跃轮 + 各自的「收尾了」promise。
     * 3. 逐个中止，理由是 `ABORT_REASON_SHUTDOWN`——经 core 透传进收尾 metadata，界面据此
     *    显示「服务重启，这一轮已中断」而不是「已停止」。**不清队列**：服务重启不该吞掉
     *    用户排的消息，重启后自然重试。
     * 4. 等齐或撞宽限期。撞了不抛错也不强制清理登记：那些轮成了[孤儿轮](../../docs/terms.md)，
     *    交给下次启动的 `recover()`——两道防线在这里接上。
     */
    async shutdown(opts) {
      const graceMs = opts?.graceMs ?? options.shutdown?.graceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
      shuttingDown = true;

      const snapshot = registry.snapshot();
      if (snapshot.length === 0) {
        logger.debug(LOG_SCOPE, "shutdown: no active turns", {});
        return { aborted: 0, settled: true, pending: 0 };
      }
      logger.info(LOG_SCOPE, "shutdown: aborting active turns", { count: snapshot.length, graceMs });

      const settledPromises = snapshot.map((turn) => turn.settled);
      for (const turn of snapshot) {await abortTurn(turn, ABORT_REASON_SHUTDOWN);}

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        Promise.all(settledPromises).then(() => false),
        new Promise<true>((resolve) => {
          timer = setTimeout(() => {
            resolve(true);
          }, graceMs);
        }),
      ]);
      if (timer !== undefined) {clearTimeout(timer);}

      const pending = registry.size;
      if (timedOut) {
        logger.error(LOG_SCOPE, "shutdown: timed out waiting for turns to settle", {
          aborted: snapshot.length,
          pending,
        });
        return { aborted: snapshot.length, settled: false, pending };
      }
      logger.info(LOG_SCOPE, "shutdown: all turns settled", { aborted: snapshot.length });
      return { aborted: snapshot.length, settled: true, pending: 0 };
    },

    isShuttingDown() {
      return shuttingDown;
    },
  };
}

export type { EnqueueOptions, RuntimeHooks, SubmittedDecision };
