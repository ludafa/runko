/**
 * 起一轮（`startTurn`）——本目录的**入口**：登记这一轮（或把[起轮占位](../../../../../docs/terms.md)
 * 原地升级），然后把 `drive.ts` 的 `driveTurn` 作为后台任务放出去，同步返回。
 *
 * 「不 `await`」是这个设计的要点：一轮的寿命与任何一个 HTTP 请求都无关
 * （docs/tech/chat-webapp.md §2.2b）——`POST .../messages` 只负责**起**它，`GET .../stream`
 * 只负责**看**它。
 *
 * 这一轮全部收尾动作（清挂起项 → `emit('done')` → 从 `activeTurns` 删除 →
 * `onTurnSettled`）也都在本文件，顺序是硬要求，见 `startTurn` 里的注释。
 */
import type { Logger } from '../../logger.js';
import { logger as defaultLogger } from '../../logger.js';
import type { Db } from '../store.js';
import { getMaxEventSeq } from '../store.js';
import type {
  TurnMilestone,
  TurnMilestoneInfo,
  TurnSettledInfo,
} from './drive.js';
import { driveTurn } from './drive.js';
import { describeError, LOG_SCOPE } from './log.js';
import { createTurnEmitter } from './persistence.js';
import type { ActiveTurn } from './registry.js';
import { activeTurns, createTurnEventEmitter } from './registry.js';
import type { TurnReservation } from './reservation.js';
import { reservationRegistry } from './reservation.js';
import type { TurnDrivenSession } from './session.js';

export interface StartTurnParams {
  db: Db;
  conversationId: string;
  session: TurnDrivenSession;
  /**
   * 用户**原话**——进[账本](../../../../../docs/terms.md)、进[直播流](../../../../../docs/terms.md)，
   * 也就是界面上显示的那条用户消息。
   */
  text: string;
  /**
   * 实际喂给模型的文本，缺省即 `text`（docs/tech/composer-skill-mention.md §2.2）。
   *
   * 两者分开，是为了让服务端能在**不污染账本**的前提下给模型追加话术——目前唯一的
   * 用途是[skill 提及](../../../../../docs/terms.md)的那行系统提示（`turn-launcher.ts`
   * 里由 `buildModelText` 拼）：用户看到的仍是自己打的 `/frontend-design 改排版`，
   * 模型收到的多一句「请先 load-skill 加载它」。
   *
   * 提示行刻意**不进账本**：界面上显示一段本该隐形的系统话术很丑，而且它对后续轮
   * 没有价值（skill 那轮已经加载过了），留在账本里只是持续占 token。
   */
  modelText?: string;
  /**
   * Count of `kind = 'message'` rows already persisted for this session
   * *before* this turn starts (`routes/chat.ts` computes this off the same
   * `SessionState` it resumed the session from — `store.ts`'s
   * `loadResumeState`; `0` for a brand-new session that has never completed
   * a turn). `state.messages[priorMessageCount]` is where `@nimbo/core`'s own
   * turn-start user `NimboUIMessage` lands (`session.ts`'s `stream()` pushes
   * it synchronously, before ever yielding); `finalizeTurnPersistence` slices
   * `session.toJSON().messages` at `priorMessageCount + 1` — skipping over
   * that one message, since `driveTurn` already persisted+broadcast its own
   * copy of it at turn start (see that function's own comment) — to find
   * exactly the *remaining* messages this turn appended. The ledger only
   * ever grows by appending (`@nimbo/core`'s `session.ts` never reorders or
   * removes an existing message), so this index stays valid for the entire
   * turn regardless of how many steps/steers it goes through.
   */
  priorMessageCount: number;
  /**
   * Step/tool-call level observability tap — defaults to `../../logger.js`'s
   * stdout singleton so existing callers that don't pass one keep working
   * unchanged. Tests inject their own (`createLogger({ sink })`) to assert on
   * emitted lines without touching `process.stdout`.
   */
  logger?: Logger;
  /**
   * 「这一轮彻底结束了」的通知点（docs/tech/steer-and-queue.md §3）——在收尾**全部**
   * 做完、`activeTurns` 里这一轮已被删除之后调用。
   *
   * 「在 delete 之后」是硬要求而非风格问题：`turn-launcher.ts` 用它来起下一轮
   * （自动[出队](../../../../../docs/terms.md)），而 `startTurn` 开头就有「已有进行中的
   * 一轮就拒绝」的守卫——delete 之前调，下一轮必然被自己这一轮挡掉。
   *
   * 本目录刻意**不认识**「队列」这个概念：它只报告一个生命周期事件，要不要因此起下
   * 一轮是注入方的事（依赖方向见 `turn-launcher.ts` 文件头）。回调抛错只记日志，不
   * 影响这一轮已经完成的收尾。
   *
   * 参数 `info` 带上「这一轮是怎么结束的」（见 `TurnSettledInfo`）——同样只是报告，
   * 本目录不认识「通知」，用不用它是注入方的事。
   */
  onTurnSettled?: (info: TurnSettledInfo) => void;
  /**
   * 这一轮的两个「首次」时刻（docs/tech/telemetry.md §2.4）——见 `TurnMilestone`。
   * 与 `onTurnSettled` 同款：本目录只报告事件，落库/拼载荷是注入方
   * （`turn-launcher.ts`）的事；回调抛错只记日志，不影响这一轮。
   */
  onMilestone?: (milestone: TurnMilestone, info: TurnMilestoneInfo) => void;
  /**
   * 这一轮的[起轮占位](../../../../../docs/terms.md)句柄（docs/tech/turn-abort.md §3.3）
   * ——`turn-launcher.ts` 装配前从 `reserveTurn` 拿到、装配完连同 session 一起交进来，
   * 由 `startTurn` 把它就地升级成真正在跑的那一轮。
   *
   * 缺省（不传）= 老路径：当场新建登记。既有调用方与 `turn-runner.test.ts` 里直接调
   * `startTurn` 的用例因此一行不用改。
   */
  reservation?: TurnReservation;
}

export interface StartTurnResult {
  started: boolean;
}

/**
 * Rejects (`{ started: false }`) if this session already has a turn running
 * — `routes/chat.ts` turns that into a 409. Otherwise registers the
 * `ActiveTurn` synchronously (so `isTurnActive`/`subscribeTurn` see it
 * immediately) and spawns the background driver — deliberately not
 * `await`ed, not bound to any request's lifetime.
 *
 * 带 `reservation`（`turn-launcher.ts` 的正常路径）时不新建登记，而是把那个
 * [起轮占位](../../../../../docs/terms.md)**就地升级**成 `running`：同一个 `ActiveTurn`、
 * 同一个 `emitter`（占位期连上的 tail 因此无缝接住这一轮）、同一个 `abortController`
 * （装配期间按下的停止对升级后的这一轮依然有效）。不带 `reservation` 的老路径照旧
 * 当场新建——既有调用方与测试一行不改。
 */
export function startTurn(params: StartTurnParams): StartTurnResult {
  const { db, conversationId, session, text, priorMessageCount } = params;
  const log = params.logger ?? defaultLogger;
  const { reservation } = params;
  const reserved =
    reservation === undefined ? undefined : (
      reservationRegistry.get(reservation)
    );
  if (reserved === undefined) {
    if (activeTurns.has(conversationId)) return { started: false };
  } else if (activeTurns.get(conversationId) !== reserved) {
    return { started: false }; // 占位已被撤销（或已被别的轮取代）——不该再启动
  }
  // 交棒：此后 `releaseTurn` 对这个句柄是无操作，删登记归下面的收尾块。
  if (reservation !== undefined) reservationRegistry.delete(reservation);

  const turnStartSeq = getMaxEventSeq(db, conversationId);
  // 占位来的那个 emitter 直接复用（`reserveTurn` 已经建好、也已经有 tail 连着）。
  const emitter = reserved?.emitter ?? createTurnEventEmitter();
  const emit = createTurnEmitter(db, conversationId, emitter, turnStartSeq);
  // Captured once, bound to *this* turn's `session` — `steerTurn` never
  // sees `session` directly, only this closure (STEER-3B).
  const steer = (input: string): boolean => session.steer?.(input) ?? false;
  const activeTurn: ActiveTurn = reserved ?? {
    phase: 'running',
    emitter,
    done: false,
    abortController: new AbortController(),
    aborted: false,
    steer,
    pendingReviews: new Map(),
    pendingQuestions: new Map(),
  };
  if (reserved !== undefined) {
    // 就地升级（见函数注释）——`aborted`/`abortController` 一律保留占位期的那份。
    reserved.phase = 'running';
    reserved.steer = steer;
  } else {
    activeTurns.set(conversationId, activeTurn);
  }

  void driveTurn(
    db,
    conversationId,
    session,
    text,
    params.modelText ?? text,
    priorMessageCount,
    turnStartSeq,
    emit,
    log,
    activeTurn.abortController.signal,
    params.onMilestone,
  )
    .catch((error: unknown): TurnSettledInfo => {
      // `driveTurn` 自己已经兜住了所有抛出，走到这里意味着**连它的 catch 分支也抛了**
      // （例如那条合成 chunk 落盘时数据库出错）。仍然必须把下面的收尾跑完——否则
      // `activeTurns` 里这一轮永不删除，这个会话就被永久锁死（此后所有消息只会排队、
      // 再也起不了轮）。原先这里是 `.finally`，天然有这个保证；改成拿返回值之后要
      // 靠这一段把它补回来。
      log.error(LOG_SCOPE, 'driveTurn rejected unexpectedly', {
        conversationId,
        error: describeError(error),
      });
      return { status: 'crashed' };
    })
    .then((settled) => {
      // Defensive cleanup only — in the normal case both maps are already
      // empty by the time `driveTurn` settles, because the `@nimbo/core` loop
      // is itself `await`ing whatever `requestReview`/`requestUserAnswer`
      // promise is pending (it's the tool call's own `onReview`/`ask-user`
      // result), so the generator simply cannot reach its `return`/`throw`
      // while one is still outstanding. Anything still here is a genuine leak
      // (e.g. a bug upstream) being caught before it dangles forever. Neither
      // bridge emits anything for these (unlike the pre-migration version):
      // the wire has nothing bridge-event-shaped left to emit after a turn
      // ends (see `index.ts`'s header) — a stuck client is left to its own
      // `requestReview`/`requestUserAnswer` timeout, which fires from the very
      // same code path this block is defensively duplicating.
      for (const pending of activeTurn.pendingReviews.values()) {
        clearTimeout(pending.timer);
        pending.resolve({
          behavior: 'deny',
          message:
            'The turn this approval request belonged to has already ended.',
        });
      }
      activeTurn.pendingReviews.clear();

      for (const pending of activeTurn.pendingQuestions.values()) {
        clearTimeout(pending.timer);
        pending.resolve({ outcome: 'timeout' });
      }
      activeTurn.pendingQuestions.clear();

      emitter.emit('done');
      activeTurn.done = true;
      activeTurns.delete(conversationId);

      // 严格在 `activeTurns.delete` 之后——见 `StartTurnParams.onTurnSettled` 的注释
      // （下一轮的 `startTurn` 守卫依赖这个顺序）。回调是注入方的事，它抛错不该污染
      // 这一轮已经完成的收尾，故就地吞掉并记一行。
      try {
        params.onTurnSettled?.(settled);
      } catch (error) {
        log.error(LOG_SCOPE, 'onTurnSettled threw', {
          conversationId,
          error: describeError(error),
        });
      }
    });

  return { started: true };
}
