/**
 * [保活](../../../docs/terms.md)引擎 —— [续期闸门](../../../docs/terms.md)的通用实现
 * （docs/tech/sandbox-keepalive.md §5.4）。
 *
 * **这个文件是一件工具，不是 core 的行为。** `session.ts` 不 import 它、不调它、
 * 也不知道它存在——core 侧依然零定时器零保活策略（见 `types.ts` 的
 * `NimboActivityAware`）。只有[沙盒适配器](../../../docs/terms.md)会显式
 * `createKeepAlive(...)` 把它造出来，造出来之后定时器归适配器所有。
 *
 * 放在 core 而不是各适配器包里，是因为 E2B 与 Vercel 的闸门逻辑逐行相同，两份拷贝
 * 必然漂移——而「补足」语义要可预测就必须两家行为一致。厂商真正不同的两件事
 * （怎么查剩余、怎么补）经 `KeepAliveDriver` 注入，见各适配器包。
 *
 * ---- 为什么需要它：平台超时是绝对截止时间 ----
 *
 * 云沙盒的超时是倒计时，**跑命令不会把它往后推**（Cloudflare 的 `sleepAfter`
 * 是例外，它是真空闲检测，所以那个适配器不用这套）。所以一轮只要跑得比超时长，
 * 沙盒就会在跑到一半时被平台暂停。详见 docs/features/sandbox-keepalive.md §1。
 *
 * ---- 三个信号源，一个闸门 ----
 *
 * `onActivity`（core 推来的[活动信号](../../../docs/terms.md)）、`beginExec`
 * （适配器在自己的远程调用期间自打点）、`keepAlive`（宿主手动补一次）三处都汇进
 * `ensureLifetime`，由它按「剩余够不够」决定要不要真的打网络。**补足语义**：够了
 * 就什么都不做——这正是 Vercel「加时」型 API 不会被反复累加的原因。
 */
import type { ActivitySignal } from "./types.js";

/** 一次真实续期尝试的结果，交给宿主看日志、以及同步宿主自己的存活时间账（见 docs/tech/sandbox-keepalive.md §6.1）。 */
export interface RenewInfo {
  ok: boolean;
  /** 这次是被谁触发的。 */
  trigger: "activity" | "exec" | "approval" | "manual";
  /** 续期后预计的到期时刻（epoch 毫秒），仅 `ok` 时有。 */
  expiresAt?: number;
  error?: unknown;
}

export interface KeepAliveOptions {
  /** 每次补足到多少毫秒。应与建盒时设的 timeout 一致。 */
  idleTimeoutMs: number;
  /** [单轮保活上限](../../../docs/terms.md)，默认 30 分钟。到点停止续期，让失控的一轮自然终结。 */
  maxTurnMs?: number;
  /** [审批保活预算](../../../docs/terms.md)，默认 5 分钟。**配 0 = 审批期间完全不续**。 */
  approvalBudgetMs?: number;
  /** 每次真的调用了厂商续期 API 之后触发（成功失败都触发）。 */
  onRenew?(info: RenewInfo): void;
}

/** 厂商差异的注入点——闸门本身与平台无关，只有这两件事因家而异。 */
export interface KeepAliveDriver {
  /**
   * 预计还能活多少毫秒。查不到就返回 `undefined`，闸门改用本地记账
   * （E2B 没有对应属性；Vercel 有 `sandbox.timeout`）。
   */
  remainingMs(): Promise<number | undefined>;
  /**
   * 把存活时长补到 `targetMs`。`remainingMs` 是刚查到的剩余（可能 `undefined`）——
   * 「加时」型 API（Vercel `extendTimeout`）需要它来算差额，「重置」型
   * （E2B `setTimeout`）直接忽略。
   */
  renew(targetMs: number, remainingMs: number | undefined): Promise<void>;
}

export interface KeepAlive {
  /** 接 core 的[活动信号](../../../docs/terms.md)。同步、不抛错——契约见 `NimboActivityAware`。 */
  onActivity(signal: ActivitySignal): void;
  /** 手动补足一次。宿主在轮之外用（起轮前、审批路由等），**不受[单轮保活上限](../../../docs/terms.md)约束**。 */
  keepAlive(targetMs: number): Promise<void>;
  /** 一次远程调用开始，返回结束函数（幂等）。期间按 `idleTimeoutMs/2` 自打点。 */
  beginExec(): () => void;
}

const DEFAULT_MAX_TURN_MS = 30 * 60_000;
const DEFAULT_APPROVAL_BUDGET_MS = 5 * 60_000;
const MIN_TICK_MS = 1_000;

/**
 * 「水位还够」的判定线：剩余 ≥ 目标的这个比例就什么都不做。
 *
 * **必须严格大于打点周期占比（1/2），否则闸门会把自己的打点全挡掉。** 施工中实测
 * 到过这个 off-by-one：阈值也取 1/2 时，定时器每次在剩余恰好等于目标一半的那一刻
 * 触发，`>=` 判定成立 → 永远跳过 → 除首次外一次都不续。取 3/4 让两者拉开：每次
 * 打点时剩余是 1/2，稳稳低于 3/4 必定放行；而刚续过就再调一次（剩余接近满）必定
 * 被挡，这正是 Vercel「加时」型 API 不会被反复累加的保证。
 */
const RENEW_BELOW_RATIO = 0.75;

/** 别为了一个保活定时器把进程的事件循环吊着不让退出。浏览器端的 `setInterval` 返回 number、没有 `unref`，故先探测。 */
function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
}

export function createKeepAlive(driver: KeepAliveDriver, opts: KeepAliveOptions): KeepAlive {
  const idleTimeoutMs = opts.idleTimeoutMs;
  const maxTurnMs = opts.maxTurnMs ?? DEFAULT_MAX_TURN_MS;
  const approvalBudgetMs = opts.approvalBudgetMs ?? DEFAULT_APPROVAL_BUDGET_MS;
  /**
   * 打点周期取超时的一半，于是「水位低于一半才补」与「每半个超时打一次」是同一件事
   * ——不需要再单配一个周期参数，两者天然对齐。
   */
  const tickMs = Math.max(MIN_TICK_MS, Math.floor(idleTimeoutMs / 2));

  /** 本地记账的预计到期时刻。`0` 表示「从没续过、当作已到期」，所以第一次必定真的续。 */
  let expectedExpiryAt = 0;

  /** 当前这一轮的标识与起点，用于 `maxTurnMs`。 */
  let turnKey = "";
  let turnStartedAt = 0;

  let approvalStartedAt = 0;
  let approvalTimer: ReturnType<typeof setInterval> | undefined;

  /** 并行工具调用会有多个 exec 同时在跑，共用一个定时器 + 引用计数，比每个 exec 各起一个省。 */
  let execDepth = 0;
  let execTimer: ReturnType<typeof setInterval> | undefined;

  /** 同 target 的续期合并、不同 target 的排队——避免两个信号源同时打出两次网络调用。 */
  let inflight: Promise<void> | undefined;
  let inflightTarget = 0;

  async function doEnsure(targetMs: number, trigger: RenewInfo["trigger"]): Promise<void> {
    let remaining: number | undefined;
    try {
      remaining = await driver.remainingMs();
    } catch {
      remaining = undefined; // 查不到不是错误，退回本地记账即可
    }

    const now = Date.now();
    /**
     * 平台报得出剩余就以它为准（Vercel 官方推荐的「先查剩余、不够再补」）；报不出
     * 才退回本地记账（E2B 没有对应属性）。`expectedExpiryAt === 0` 表示从没续过，
     * 当作负无穷 → 首次必定真的续。
     */
    const local = expectedExpiryAt === 0 ? Number.NEGATIVE_INFINITY : expectedExpiryAt - now;
    const effective = remaining ?? local;
    if (effective >= targetMs * RENEW_BELOW_RATIO) return; // 水位够，什么都不做——这就是「补足」

    try {
      await driver.renew(targetMs, remaining);
      expectedExpiryAt = Date.now() + targetMs;
      opts.onRenew?.({ ok: true, trigger, expiresAt: expectedExpiryAt });
    } catch (error) {
      // 不上抛。续期失败不该打断这一轮——沙盒真死了，下一次工具调用会给出好得多的错误。
      opts.onRenew?.({ ok: false, trigger, error });
    }
  }

  function ensureLifetime(targetMs: number, trigger: RenewInfo["trigger"]): Promise<void> {
    if (inflight !== undefined && inflightTarget === targetMs) return inflight;
    const previous = inflight ?? Promise.resolve();
    inflightTarget = targetMs;
    const run = previous.then(() => doEnsure(targetMs, trigger));
    inflight = run;
    // `doEnsure` 自己吞掉所有错误，所以这里不会有未处理拒绝。
    void run.then(() => {
      if (inflight === run) inflight = undefined;
    });
    return run;
  }

  /** 这一轮还在[单轮保活上限](../../../docs/terms.md)之内吗；顺便认出新一轮并重置计时。 */
  function withinTurnCap(signal: ActivitySignal): boolean {
    const key = `${signal.session.id}#${String(signal.session.turn)}`;
    if (key !== turnKey) {
      turnKey = key;
      turnStartedAt = Date.now();
      stopApproval(); // 新一轮开始，上一轮遗留的审批状态一律作废
    }
    return Date.now() - turnStartedAt < maxTurnMs;
  }

  function stopApproval(): void {
    if (approvalTimer !== undefined) {
      clearInterval(approvalTimer);
      approvalTimer = undefined;
    }
    approvalStartedAt = 0;
  }

  function startApproval(): void {
    if (approvalTimer !== undefined) return; // 已在审批模式（并行工具可能连发多个请求）
    if (approvalBudgetMs <= 0) return; // 配 0：一次都不为等人续期
    approvalStartedAt = Date.now();
    void ensureLifetime(idleTimeoutMs, "approval");
    const timer = setInterval(() => {
      if (Date.now() - approvalStartedAt >= approvalBudgetMs) {
        stopApproval();
        return;
      }
      void ensureLifetime(idleTimeoutMs, "approval");
    }, tickMs);
    unrefTimer(timer);
    approvalTimer = timer;
  }

  return {
    onActivity(signal: ActivitySignal): void {
      const within = withinTurnCap(signal);
      if (signal.reason === "awaiting-approval") {
        if (within) startApproval();
        return;
      }
      // 任何 `progress` 都意味着离开了等人状态——这是实现方停掉审批保活的唯一依据。
      stopApproval();
      if (within) void ensureLifetime(idleTimeoutMs, "activity");
    },

    keepAlive(targetMs: number): Promise<void> {
      return ensureLifetime(targetMs, "manual");
    },

    beginExec(): () => void {
      execDepth += 1;
      if (execTimer === undefined) {
        const timer = setInterval(() => {
          // 长命令也受单轮上限约束；`turnStartedAt === 0` 表示没有活动信号源
          // （宿主直接用 workspace、没走 core 的会话），此时不设上限。
          if (turnStartedAt !== 0 && Date.now() - turnStartedAt >= maxTurnMs) return;
          void ensureLifetime(idleTimeoutMs, "exec");
        }, tickMs);
        unrefTimer(timer);
        execTimer = timer;
      }
      let stopped = false;
      return () => {
        if (stopped) return; // 幂等
        stopped = true;
        execDepth -= 1;
        if (execDepth === 0 && execTimer !== undefined) {
          clearInterval(execTimer);
          execTimer = undefined;
        }
      };
    },
  };
}
