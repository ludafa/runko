/**
 * `createAgentRuntime` —— 本包的门面。
 *
 * `@runko/core` 的 `Session` 管「跑一轮」，这里管「**一轮接一轮**」：起、[停止](../../../docs/terms.md)、
 * 收尾、[排队](../../../docs/terms.md)与[插话](../../../docs/terms.md)、人在回路、[交权](../../../docs/terms.md)、
 * [崩溃恢复](../../../docs/terms.md)。四样宿主能力全部可替换，**都带内置的平凡实现**，所以
 * 零配置就能跑。
 *
 * 框架**不碰 HTTP**：`subscribe` 给的是中立的 `AsyncIterable`，序列化成 SSE / WebSocket
 * 是[接入层](../../../docs/terms.md)的事。
 */
import type { AgentDefinition, RunkoUIMessage } from "@runko/core";

import type { Arbitration } from "./arbitration.js";
import { inProcessArbitration } from "./builtin/in-process-arbitration.js";
import { inProcessStream } from "./builtin/in-process-stream.js";
import { memoryPersistence } from "./builtin/memory-persistence.js";
import type { Logger } from "./logger.js";
import { describeError, noopLogger } from "./logger.js";
import type { Persistence } from "./persistence.js";
import type { TurnPreparer } from "./prepare.js";
import type { RuntimeContext, RuntimeHooks, SteerPolicy } from "./runtime/context.js";
import { durationToMs } from "./runtime/duration.js";
import type { Duration } from "./runtime/duration.js";
import { HumanBridge } from "./runtime/human.js";
import { appendInterruptedMarker } from "./runtime/interrupted-marker.js";
import { settleOrphanedDecisionsSafely } from "./runtime/orphaned-decisions.js";
import type { SubmittedDecision } from "./runtime/human.js";
import { advance, answerSuspended, enqueue as enqueueInput, publishQueue, startNextQueued, startTurn } from "./runtime/queue.js";
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

/**
 * [内存窗口](../../../docs/terms.md)默认 5 分钟：与审批保活预算对齐，免得沙盒已经休眠了、
 * 框架还在内存里等（挂起与恢复 · 技术方案 §8.2）。
 */
const DEFAULT_MEMORY_WINDOW: Duration = "5m";
/** [交权](../../../docs/terms.md)宽限期：正在干活的轮，等多久还没收尾就不等了。 */
const DEFAULT_SHUTDOWN_GRACE_MS = 15_000;
/** [等待窗口](../../../docs/terms.md)缺省值：不等，立刻分流（等人的挂起、其余中止）。 */
const DEFAULT_SHUTDOWN_FINISH_WINDOW_MS = 0;
/** 等待窗口期间多久检查一次「有没有轮转入等人」，以便把它立刻挂起而不是占到窗口结束。 */
const SHUTDOWN_FINISH_POLL_MS = 500;
const DEFAULT_QUEUE_MAX = 10;
/**
 * 跟着别的副本看直播时，没收到货就最多等这么久，然后回头问一次归属还在不在。
 *
 * 它只是一道**兜底**：正常收尾由持有者广播的那一帧 `activity:false` 负责，慢几秒没代价。
 * 有它才不会在「持有者崩了、又没人接管」时永远挂着——那种情形下没有任何进程会发那一帧。
 */
const REMOTE_FOLLOW_RECHECK_MS = 3_000;

/** 窄化成[轮状态](../../../docs/terms.md)帧。`Frame` 是判别联合，这里只是把判别写成守卫。 */
function isActivityFrame(frame: Frame): frame is Extract<Frame, { kind: "activity" }> {
  return frame.kind === "activity";
}

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
  /** 缺省 = 进程内 fan-out。跨实例时换 `@runko/stream-redis`。 */
  stream?: StreamFanout;
  /** 缺省 = 进程内一个 Map。多进程共享 DB 时换租约版。 */
  arbitration?: Arbitration;
  /** 缺省 = core 的 `createSession` + 文件工具八件套默认装配。测试可注入假 session。 */
  sessionFactory?: SessionFactory;
  /** 缺省彻底静音——库不该替宿主决定日志往哪去。 */
  logger?: Logger;
  /** 观测/通知挂钩，全部可选、全部只报告。 */
  hooks?: RuntimeHooks;
  /** [排队](../../../docs/terms.md)与[插话](../../../docs/terms.md)的产品策略。 */
  queue?: {
    enabled?: boolean;
    max?: number;
    onFull?: "reject" | "dropOldest";
    /** 见 `SteerPolicy`：三个枚举档，或一个按 `TurnInput` 自己判断的回调。 */
    steer?: SteerPolicy;
  };
  human?: {
    /** @deprecated 改用 `suspend.memoryWindow`。配了仍然生效（只管审批这一路），并记一行 warn。 */
    approvalTimeoutMs?: number;
    /** @deprecated 改用 `suspend.memoryWindow`。配了仍然生效（只管 `ask-user` 这一路），并记一行 warn。 */
    askUserTimeoutMs?: number;
    /** 注册内置 `ask-user` 工具（缺省开）。 */
    askUser?: boolean;
  };
  /** [挂起](../../../docs/terms.md)：等人等多久就落盘退出、释放机器，人回来在任意节点接着干。 */
  suspend?: {
    /**
     * [内存窗口](../../../docs/terms.md)：先在内存里等多久，等不到就挂起。缺省 `"5m"`。
     * `0` = 一等人就挂起、不起定时器——不可寻址的宿主（Vercel Functions、Durable Object）用这一档。
     */
    memoryWindow?: Duration;
    /** 收到 `reportPresence` 时：`"extend"`（缺省）把窗口往后推一整个窗口；`"ignore"` 不理。 */
    onPresence?: "extend" | "ignore";
  };
  shutdown?: {
    /** [交权](../../../docs/terms.md)宽限期：中止之后等收尾的上限。缺省 15 秒。 */
    graceMs?: number;
    /**
     * [等待窗口](../../../docs/terms.md)：干活的轮先自然跑完，最多等这么久再中止。缺省 `0` = 不等、立刻
     * 分流（等人的挂起、其余中止）——本地开发用 `node --watch` 热重载也发 SIGTERM，
     * 缺省值必须是「不等」，不然改一行代码就要卡住等几十秒。
     */
    finishWindowMs?: number;
  };
}

export interface SubscribeOptions {
  /** 断线续传游标：只回放 seq 大于它的成品消息。 */
  after?: number;
  /** `'turn'`（默认）= 这一轮结束就收线（没有轮在跑时回放完即收）；`'forever'` = 一直挂着，靠 `signal` 收。 */
  follow?: "turn" | "forever";
  signal?: AbortSignal;
}

export interface ShutdownResult {
  /** 这次关闭中止了几个轮（含还在[起轮装配](../../../docs/terms.md)里的）。 */
  aborted: number;
  /** 这次关闭[挂起](../../../docs/terms.md)了几个轮——关闭那一刻或等待窗口期间它们在等人，挂起是无损的，人回来在任意节点接着干。 */
  suspended: number;
  /** [等待窗口](../../../docs/terms.md)内正常完成（`completed`）的轮数；被用户停止、跑失败的不算。`finishWindowMs` 不传或为 `0` 时恒为 `0`。 */
  finished: number;
  /** 是否全部收尾完毕。`false` = 撞了宽限期上限，还有轮没等到。 */
  settled: boolean;
  /** 撞超时时还剩几个没收尾。 */
  pending: number;
}

export interface RecoveryResult {
  /** 扫到几个还留着[起轮标记](../../../docs/terms.md)的会话。 */
  scanned: number;
  /** 给几个补了「已停止」收尾。 */
  recovered: number;
}

export interface AgentRuntime {
  /** 用户发消息。忙不忙、排队还是插话、要不要起轮，**框架自己判**。 */
  enqueue(conversationId: string, input: TurnInput, opts?: EnqueueOptions): Promise<EnqueueResult>;
  /** 实时流：先回放，再直播。中立的 `AsyncIterable`，序列化归接入层。 */
  subscribe(conversationId: string, opts?: SubscribeOptions): AsyncGenerator<Frame, void>;
  /** 人做出裁决。`false` = 没有这条等人项（已结、已超时、从未存在）→ 接入层转 404。 */
  submitDecision(conversationId: string, callId: string, decision: SubmittedDecision): Promise<boolean>;
  /**
   * 人回答了 `ask-user`。语义同上。
   *
   * `decidedBy` 是答复人。[挂起](../../../docs/terms.md)之后答的，恢复那一轮以他的身份跑（`TurnInput.userId`）
   * ——推送、钩子都靠它找人；不给就没有身份。
   */
  submitAnswer(conversationId: string, callId: string, answer: string, opts?: { decidedBy?: string }): Promise<boolean>;
  /** [停止](../../../docs/terms.md)进行中的那一轮 + 清空[待发队列](../../../docs/terms.md)。`false` = 没有轮可停。 */
  abort(conversationId: string, reason?: string): Promise<boolean>;
  /** 这个会话此刻在不在跑、谁在跑（多节点时接入层据 `holder` 转发）。 */
  getActivity(conversationId: string): Promise<ConversationActivity>;
  listQueue(conversationId: string): Promise<QueuedInput[]>;
  removeQueued(conversationId: string, id: string): Promise<{ removed: boolean; queue: QueuedInput[] }>;
  clearQueue(conversationId: string): Promise<QueuedInput[]>;
  /** 读[账本](../../../docs/terms.md)（回放历史用；`subscribe` 已经包含回放，这个给「只要历史」的端点）。 */
  readLedger(conversationId: string, opts?: { afterSeq?: number }): Promise<{ seq: number; message: RunkoUIMessage }[]>;
  /** 启动扫描：给[孤儿轮](../../../docs/terms.md)补「已停止」收尾。只在进程启动、开始服务之前跑一次。 */
  recover(): Promise<RecoveryResult>;
  /** [交权](../../../docs/terms.md)：停掉在跑的轮并等它们收尾。**不退进程**——那是宿主的事。 */
  shutdown(opts?: { finishWindowMs?: number; graceMs?: number }): Promise<ShutdownResult>;
  /** 进程是否正在[优雅关闭](../../../docs/terms.md)（接入层据此转 503）。 */
  isShuttingDown(): boolean;
  /**
   * [在场](../../../docs/terms.md)上报：此刻有人正盯着这条会话。`suspend.onPresence` 为 `"extend"` 时，
   * 正在等人的那一轮的内存窗口从现在起重新计时。同步、不落库；没轮在等人时什么都不做。
   *
   * **宿主要保证它基于真实交互**（页面可见 + 窗口聚焦 + 路由停在这条会话），不能拿「连接还在」
   * 当在场——半夜挂着页面的浏览器会让会话永远不挂起。
   */
  reportPresence(conversationId: string): void;
}

/**
 * 两路等人的窗口（毫秒）。新参数 `suspend.memoryWindow` 两路共用；旧的两个超时参数按通道各自
 * 映射，这样只配了旧参数的宿主行为完全不变（挂起与恢复 · 技术方案 §8.1）。
 */
function resolveMemoryWindows(options: AgentRuntimeOptions, logger: Logger): { approvalWindowMs: number; questionWindowMs: number } {
  const configured = options.suspend?.memoryWindow;
  const windowMs = durationToMs(configured ?? DEFAULT_MEMORY_WINDOW, "suspend.memoryWindow");
  const legacy = {
    approvalTimeoutMs: options.human?.approvalTimeoutMs,
    askUserTimeoutMs: options.human?.askUserTimeoutMs,
  };
  for (const [name, value] of Object.entries(legacy)) {
    if (value === undefined) {continue;}
    if (configured !== undefined) {
      logger.warn(LOG_SCOPE, `human.${name} is deprecated and ignored because suspend.memoryWindow is set`, { [name]: value });
    } else {
      logger.warn(LOG_SCOPE, `human.${name} is deprecated; use suspend.memoryWindow`, { [name]: value });
    }
  }
  if (configured !== undefined) {return { approvalWindowMs: windowMs, questionWindowMs: windowMs };}
  return {
    approvalWindowMs: legacy.approvalTimeoutMs === undefined ? windowMs : durationToMs(legacy.approvalTimeoutMs, "human.approvalTimeoutMs"),
    questionWindowMs: legacy.askUserTimeoutMs === undefined ? windowMs : durationToMs(legacy.askUserTimeoutMs, "human.askUserTimeoutMs"),
  };
}

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  const logger = options.logger ?? noopLogger;
  const persistence = options.persistence ?? memoryPersistence();
  const stream = options.stream ?? inProcessStream();
  const arbitration = options.arbitration ?? inProcessArbitration();
  const registry = new TurnRegistry();
  const hooks = options.hooks ?? {};
  let shuttingDown = false;

  const extendOnPresence = (options.suspend?.onPresence ?? "extend") === "extend";
  const human = new HumanBridge({
    registry,
    decisions: persistence.decisions,
    ...resolveMemoryWindows(options, logger),
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

      // ③ **同步临界区**：取[进行中草稿](../../../docs/terms.md)快照，并把回放期间攒下的
      //    缓冲丢掉——那些帧要么已经在快照里（重复发无害，重放是幂等的），要么是纯增量
      //    （`text-delta` 之类，脱离顺序重放反而会写坏）。中间**不能有 `await`**：Node
      //    单线程，同步段内没有别的东西能插进来，所以这样写就是零空隙。
      const turn = registry.get(conversationId);
      const localActive = turn !== undefined;
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
      // `activity` 帧本身照旧丢掉（第 ④ 步紧接着发权威快照），但**它带的信息不能跟着丢**。
      //
      // 别的副本收尾是「**先**广播 `activity:false`、**后**释放归属」（`queue.ts` 的
      // `settleTurn`），中间还隔着一次落库。回放恰好落在这段窗口里时，下面的 `inspect()`
      // 仍会报「有人持有」——若据此去跟远端，第 ⑤ 步就会等一帧**刚被自己丢掉、而且永远
      // 不会再来**的收尾帧，这条流就挂死了（客户端的转圈也停不下来：流不关就不重连）。
      //
      // 只看最后一帧：中间那几帧的状态已经被它覆盖了。
      const lastBroadcastActivity = [...buffer].reverse().find(isActivityFrame);
      const remoteEndedDuringReplay = lastBroadcastActivity !== undefined && !lastBroadcastActivity.active;
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

      // ④ 两帧权威快照：队列、以及[轮状态](../../../docs/terms.md)。**每条连接必发**——任何
      //    时候连上/重连拿到的都是当下的真实状态，而不是靠客户端猜。
      yield { kind: "queue", queue: await persistence.queue.list(conversationId) };

      // **轮状态必须是权威答案，不能只看本进程的登记表。** 多副本下这份对话可能正跑在别的
      // 副本上，那时本地登记表是空的——报「没有轮在跑」是错的，[接入层](../../../docs/terms.md)
      // 据此既不知道该转发、也没法告诉用户这一轮在别处。取法与 `getActivity()` 同一套：
      // 本地登记表命中就用它，**单进程下 `inspect()` 一次都不会被调到**；没命中才去问
      // [归属仲裁](../../../docs/terms.md)（租约版下是一次 SELECT）。
      //
      // 判据刻意仍用**第 ③ 步捕获的那个 `turn`**，不重新查登记表：这里到第 ⑤ 步之间要是
      // 换了判据，「这一轮刚好在 ③④ 之间收尾」那条窄路上会把已经躺在缓冲里的收尾
      // `message` 帧丢掉——而收尾窗口里重连恰恰是最该管用的那一刻。于是控制流一行没变，
      // 变的只是这一帧的内容。
      //
      // **归属报的是我们自己上一次的 `holder` 时不算「有轮在跑」**：收尾是先删登记表、
      // 再释放归属（见 `queue.ts` 的 `settleTurn`），中间那一小段两边都查得到「有人持有」
      // 却没有任何东西在跑。不排除它的话，这一帧会说「还在跑」然后流立刻断掉——客户端
      // 的转圈动画就停在那儿了。释放失败时这段窗口会一直拖到租约过期。
      const remote = localActive ? undefined : await arbitration.inspect(conversationId);
      const heldElsewhere =
        remote?.held === true &&
        (registry.lastHolder === undefined || remote.holder !== registry.lastHolder);
      // 回放期间刚收到过远端的收尾广播，就以那一帧为准：它是持有者自己说的，比还没释放的
      // 归属记录新（见上面 `remoteEndedDuringReplay` 的注释）。
      const remoteActive = heldElsewhere && !remoteEndedDuringReplay;
      const holder = localActive ? turn.grant.holder : remoteActive ? remote?.holder : undefined;
      yield {
        kind: "activity",
        active: localActive || remoteActive,
        ...(holder !== undefined ? { holder } : {}),
      };

      // **这一轮跑在别的副本上时，等不等得看流分发能不能跨进程送帧**
      // （`StreamFanout.crossInstance`）。
      //
      // 进程内那一档等也等不到，就地收线是诚实的：宿主要么把请求转给持有者、要么让
      // 客户端重连。换成广播那一档，帧马上就会从别的副本过来——这时收线，用户就看不到
      // 正在跑的这一轮了（连上去只收到几帧快照然后流就关了）。
      //
      // 正常收线还是靠那一帧广播过来的 `activity:false`；**但不能只靠它**——持有者被
      // `kill -9`（没人接管）或这条订阅漏了，那一帧永远不会到。所以下面第 ⑤ 步给这条路
      // 加了一道定期复查归属的出口。
      const followRemote = follow === "turn" && remoteActive && stream.crossInstance === true;
      if (!localActive && !followRemote && follow === "turn") {return;}

      // ⑤ 直播。「先看有没有货，没货才等」——`scheduleWake` 换新 promise 的写法下，一个在
      //    本循环 yield 期间到达的帧唤醒的是已经没人等的旧 promise，那次唤醒会丢；先看
      //    缓冲就让丢唤醒不再有后果。
      while (!ended) {
        if (buffer.length === 0) {
          if (!followRemote) {
            await waiter;
            continue;
          }
          // **跟着别的副本看时，等待必须有界。** 收尾那一帧要靠对端广播过来，对端崩了
          // （没人接管、租约只是静静过期）就永远不会有人发它。所以没货时最多等这么久，
          // 然后回头问一次归属：还有人持有就接着等（包括被别人接管——那一轮还在跑，
          // 新持有者的帧照样广播得到），归属没了就自己补一帧收尾并收线。
          //
          // 复查间隔不跟[接管阈值](../../../docs/terms.md)对齐：这只是一道兜底，正常路径
          // 由广播那一帧负责，慢几秒没有代价。
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            waiter,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, REMOTE_FOLLOW_RECHECK_MS);
            }),
          ]);
          if (timer !== undefined) {clearTimeout(timer);}
          if (buffer.length > 0 || ended) {continue;}
          if ((await arbitration.inspect(conversationId)).held) {continue;}
          yield { kind: "activity", active: false };
          return;
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

    // 两条路（技术方案 §5.7）：等人项还在本进程内存里（内存窗口内）→ 直接交给正在等的那一轮；
    // 不在了（挂起了，或者在别的副本上等着）→ 写进裁决表那一行，推一把，由恢复轮接上。
    async submitDecision(conversationId, callId, decision) {
      if (await human.settleReview(conversationId, callId, decision)) {return true;}
      return await answerSuspended(ctx, conversationId, callId, "approval", {
        outcome: decision.outcome,
        ...(decision.scope !== undefined ? { scope: decision.scope } : {}),
        ...(decision.decidedBy !== undefined ? { decidedBy: decision.decidedBy } : {}),
        ...(decision.message !== undefined ? { message: decision.message } : {}),
        decidedAt: Date.now(),
      });
    },

    async submitAnswer(conversationId, callId, answer, opts = {}) {
      if (await human.settleQuestion(conversationId, callId, { outcome: "answered", answer }, opts.decidedBy)) {return true;}
      return await answerSuspended(ctx, conversationId, callId, "question", {
        outcome: "answered",
        message: answer,
        ...(opts.decidedBy !== undefined ? { decidedBy: opts.decidedBy } : {}),
        decidedAt: Date.now(),
      });
    },

    async abort(conversationId, reason = ABORT_REASON_USER) {
      const turn = registry.get(conversationId);
      // 判定「有没有轮在跑」必须在清队列**之前**：没有轮在跑时清队列会把一次误点变成
      // 一次丢消息（队列本来要等下一次轮收尾才发）。
      if (turn === undefined) {return false;}

      // 清队列必须在 abort **之前**：这一轮收尾时会自动[出队](../../../docs/terms.md)起下一轮，
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
     * [崩溃恢复](../../../docs/terms.md)：库里还留着[起轮标记](../../../docs/terms.md)= 那一轮
     * 没人管了（进程被强杀、OOM、断电），补一条「已停止」。
     *
     * **判据是直接的**——不再依赖「chunk 行会被 GC 掉」这个副作用，GC 漏跑不会再把活着
     * 的轮误判成孤儿。幂等：补完就把标记清了，再跑一次扫不到它。
     *
     * 顺序是**先清标记再抢归属**：标记还在的话 `acquire` 会被自己要恢复的那条挡成
     * `busy`。
     *
     * **单进程**下它只在启动、开始服务之前跑，那时不可能有活跃轮，所以没有竞态。**多副本**
     * 下不成立：滚动重启时几个副本会同时开机、扫到同一条陈旧标记。那时的防护在仲裁机制里——
     * `clearStale` 带着与 `listStale` 同一条陈旧判据，后到的那个清不掉先到者刚拿到的令牌，
     * 它的 `acquire` 会老实报 `busy`。
     *
     * 它也**只兜得住「先重启、后有人发消息」这一种顺序**。反过来——别的副本先接手——租约行
     * 被覆盖，这里就扫不到了，那条路由起轮时的 `takeover` 补（见 `runtime/interrupted-marker.ts`）。
     */
    async recover() {
      const stale = await arbitration.listStale();
      let recovered = 0;
      const interruptedResumes: string[] = [];
      for (const entry of stale) {
        const { conversationId } = entry;
        try {
          await arbitration.clearStale(conversationId);
          const acquired = await arbitration.acquire(conversationId, {
            seedSeq: () => persistence.ledger.maxSeq(conversationId),
          });
          if (!acquired.ok) {continue;}
          try {
            // 裁决表那一半：崩掉的那一轮要是正在内存里等人，那一行再也不会有人结清了。
            // 挂起中（账本末尾有悬空调用）的行不动——那是在等人回来，不是孤儿。失败不能挡住下面补标记。
            const orphans = await settleOrphanedDecisionsSafely(persistence, logger, conversationId);
            // 与「接管时补收尾」共用同一个写法（`runtime/interrupted-marker.ts`），只是理由不同。
            const marker = await appendInterruptedMarker(persistence, acquired.grant, ABORT_REASON_SHUTDOWN);
            if (marker.written) {
              recovered += 1;
              logger.info(LOG_SCOPE, "recovered orphaned turn", { conversationId, seq: marker.seq, orphanedDecisions: orphans });
            } else if (marker.reason === "awaiting_human") {
              // 崩掉的是一次没做完的恢复：账本没动过，答案还在裁决表里。
              interruptedResumes.push(conversationId);
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
      // 崩掉的恢复轮：人已经答过了，他在等那个操作执行。推一把让它重来——**那条命令可能会被执行
      // 第二次**（崩溃不是干净边界，不知道它执行完没有），这是有意的取舍：宁可至少执行一次，也不要
      // 让人批准过的操作静默丢失（技术方案 §5.9）。不 await：一轮的寿命与启动扫描无关。
      for (const conversationId of interruptedResumes) {
        logger.warn(LOG_SCOPE, "crashed turn was a resume attempt; retrying it", { conversationId });
        void advance(ctx, conversationId).catch((error: unknown) => {
          logger.error(LOG_SCOPE, "failed to retry an interrupted resume", { conversationId, error: describeError(error) });
        });
      }
      if (recovered > 0) {logger.warn(LOG_SCOPE, "startup sweep finished", { scanned: stale.length, recovered });}
      else {logger.debug(LOG_SCOPE, "startup sweep finished, nothing to recover", { scanned: stale.length });}
      return { scanned: stale.length, recovered };
    },

    /**
     * [交权](../../../docs/terms.md)。五步的顺序都是硬要求：
     *
     * 1. **先置关闭闸门**，否则收尾期间[自动出队](../../../docs/terms.md)会源源不断起新轮，
     *    这个函数永远等不完。
     * 2. 快照当前全部活跃轮 + 各自的「收尾了」promise。
     * 3. **等待窗口**（`finishWindowMs > 0` 才有）：等人的轮立刻[挂起](../../../docs/terms.md)——挂起是
     *    无损的，那次调用原样留在账本里，人回来在任意节点接着干；干活的轮不动它，让它自然收尾。
     *    窗口期间每 `SHUTDOWN_FINISH_POLL_MS` 再看一遍，中途转入等人的轮也挂起，不占到窗口结束；
     *    全部收尾就提前结束窗口。
     * 4. **窗口到点还没收尾的：等人的挂起，其余中止。** 中止理由是 `ABORT_REASON_SHUTDOWN`——
     *    经 core 透传进收尾 metadata，界面据此显示「服务重启，这一轮已中断」而不是「已停止」。
     *    `finishWindowMs` 缺省 `0` 时窗口长度是 0，这一步就是发生的唯一一步。
     *    **两种都不清队列**：服务重启不该吞掉用户排的消息。
     * 5. 等齐或撞宽限期。撞了不抛错也不强制清理登记：那些轮成了[孤儿轮](../../../docs/terms.md)，
     *    交给下次启动的 `recover()`——两道防线在这里接上。
     */
    async shutdown(opts) {
      const graceMs = opts?.graceMs ?? options.shutdown?.graceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
      const finishWindowMs = opts?.finishWindowMs ?? options.shutdown?.finishWindowMs ?? DEFAULT_SHUTDOWN_FINISH_WINDOW_MS;
      shuttingDown = true;

      const snapshot = registry.snapshot();
      if (snapshot.length === 0) {
        logger.debug(LOG_SCOPE, "shutdown: no active turns", {});
        return { aborted: 0, suspended: 0, finished: 0, settled: true, pending: 0 };
      }
      logger.info(LOG_SCOPE, "shutdown: settling active turns", { count: snapshot.length, finishWindowMs, graceMs });

      const settledPromises = snapshot.map((turn) => turn.settled);
      let aborted = 0;
      let suspended = 0;

      // 等人的轮立刻挂起；`suspendedTurns` 用来去重，同一轮不会被挂起、计数两次。
      const suspendedTurns = new Set<ActiveTurn>();
      const suspendIfWaiting = (turn: ActiveTurn): boolean => {
        if (suspendedTurns.has(turn)) {return true;}
        if (turn.pendingReviews.size + turn.pendingQuestions.size === 0) {return false;}
        human.suspendTurn(turn, "handover");
        suspendedTurns.add(turn);
        suspended += 1;
        return true;
      };

      if (finishWindowMs > 0) {
        for (const turn of snapshot) {suspendIfWaiting(turn);}

        const deadline = Date.now() + finishWindowMs;
        let busy = snapshot.filter((turn) => !turn.done && !suspendedTurns.has(turn));
        // 只建一次：每轮询一次就建一个会给每个在跑的轮多挂一个回调，一直留到它收尾。
        // 挂起的轮也会收尾，所以「全部收尾」同样能提前结束窗口。
        const allSettled = Promise.all(busy.map((turn) => turn.settled));
        while (busy.length > 0) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) {break;}
          let tickTimer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            allSettled,
            new Promise<void>((resolve) => {
              tickTimer = setTimeout(resolve, Math.min(SHUTDOWN_FINISH_POLL_MS, remaining));
            }),
          ]);
          if (tickTimer !== undefined) {clearTimeout(tickTimer);}
          busy = busy.filter((turn) => !turn.done);
          for (const turn of busy) {suspendIfWaiting(turn);}
          busy = busy.filter((turn) => !suspendedTurns.has(turn));
        }
      }

      const finished = finishWindowMs > 0 ? snapshot.filter((turn) => turn.endStatus === "completed").length : 0;
      if (finished > 0) {logger.info(LOG_SCOPE, "shutdown: turns finished naturally during the finish window", { finished });}

      for (const turn of snapshot) {
        if (turn.done || suspendIfWaiting(turn)) {continue;}
        await abortTurn(turn, ABORT_REASON_SHUTDOWN);
        aborted += 1;
      }

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
        logger.error(LOG_SCOPE, "shutdown: timed out waiting for turns to settle", { aborted, suspended, finished, pending });
        return { aborted, suspended, finished, settled: false, pending };
      }
      logger.info(LOG_SCOPE, "shutdown: all turns settled", { aborted, suspended, finished });
      return { aborted, suspended, finished, settled: true, pending: 0 };
    },

    isShuttingDown() {
      return shuttingDown;
    },

    reportPresence(conversationId) {
      if (extendOnPresence) {human.reportPresence(conversationId);}
    },
  };
}

export type { EnqueueOptions, RuntimeHooks, SubmittedDecision };
