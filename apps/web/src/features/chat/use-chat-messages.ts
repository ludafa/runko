/**
 * The chat feature's core deliverable (docs/tech/chat-webapp.md §2.2b, the P12-4 rewrite,
 * carried over verbatim through the P13-5-4 UIMessage-ledger migration): turn
 * *execution* and *connection* are decoupled — `sendMessage` only fires
 * `POST .../messages` (starts the turn server-side, independent of any
 * request/response lifetime) and then (re)opens the resumable live tail
 * (`GET .../stream?after=<seq>`); the tail is *also* opened unconditionally
 * on mount, so a page refresh/HMR reload/tab restore reconnects to whatever
 * turn was still in flight before the reload, picking its remaining frames
 * up exactly where the last connection left off.
 *
 * `turnInProgressRef` is the hook's own belief about whether *this* conversation
 * currently has a turn running. It gates: (a) which of the two `sendMessage`
 * branches below runs (start a new turn vs. queue/steer the in-progress one —
 * STEER-3B), (b) whether a tail that just ended (cleanly or via error) should
 * reconnect.
 *
 * 它有三个写入源，权威性递增：
 *
 * 1. **挂载时的初值**（会话详情的 `turnInProgress`，服务端读[起轮标记](../../../../../docs/terms.md)
 *    那一列给出）：只用来撑到 tail 连上的那几十毫秒。
 * 2. **`MessageLedger` 的 `onTurnEnd`**（docs/tech/single-ledger.md §5 单-3 那条收尾
 *    `message-metadata`）：一轮真正结束的那一刻翻假。
 * 3. **[轮状态快照](../../../../../docs/terms.md)**（`applyTurnState`，
 *    docs/tech/chat-webapp.md §5.1）：**服务端的权威答案**，每条 tail 连上必发一帧。
 *
 * 第 3 条是后来加的，补的正是前两条都盖不住的那个洞：一轮**崩溃**时（进程重启、
 * `driveTurn` 的 catch 分支）收尾 metadata 永远不会到，而崩溃残留的 `kind = 'chunk'`
 * 行又永不 GC，于是第 1 条那个猜测此后**每次**打开这个会话都猜「有轮在跑」，且永不
 * 自愈。后果是用户发的消息一律走[排队](../../../../../docs/terms.md)、没有下面那套
 * 乐观回显、而且永远等不到[出队](../../../../../docs/terms.md)（没有轮会收尾去触发
 * 它）；按[停止](../../../../../docs/terms.md)也只会拿到 409。现在**任何**前端与服务端
 * 的分叉都会被下一次 tail 连接纠正。
 *
 * ---- optimistic user echo (short-lived — this ticket's fix) ----
 *
 * `apps/node-server`'s `turn-runner/drive.ts` now gives a turn-starting user message a
 * real wire position: `driveTurn` synthesizes and broadcasts it as this
 * turn's very first `MessageFrame`, strictly before anything else that turn
 * produces (`schemas/chat.ts`'s file header). `pendingUserEchoes`
 * (`sendMessage`'s new-turn branch only, never the steer branch, which
 * *does* get a real materialized entry straight away) is therefore only ever
 * a **short-lived** placeholder now, covering the brief window between
 * `sendMessage` firing the `POST` and that real `MessageFrame` actually
 * arriving over the tail — each one anchored to `messages.length` at the
 * moment it was sent (`timeline.ts`'s `buildRenderEntries` splices it back
 * into its sent-at position) and popped, FIFO, the instant `MessageLedger`
 * reports a `role === 'user'` `MessageFrame` (`ledgerRef`'s construction
 * below, `onUserMessage` — see `materialize.ts`'s `UserMessageListener` doc
 * comment for why *only* a `MessageFrame` pops one, never a steer message's
 * chunk-materialized entry). Because a turn can't even start until the
 * previous one's `onTurnEnd` has fired — which is necessarily *after* that
 * turn's own user-message echo was already popped — at most one echo is ever
 * pending at a time in the normal flow; `buildRenderEntries` still sorts
 * same-anchor echoes into ascending-id (send) order as a defensive fallback
 * (its own doc comment) in case a stale-closure race ever produces more than
 * one anyway.
 */
import type { NimboMessageMetadata, NimboUIMessage } from '@nimbo/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  ChatApiError,
  clearQueuedMessages,
  deleteQueuedMessage,
  postAbortTurn,
  postApprovalDecision,
  postChatMessage,
  postQuestionAnswer,
  streamConversationTail,
} from './api';
import { MessageLedger } from './materialize';
import type { ChatReplayFrame, QueuedMessage } from './schema';
import { frameSeq, isQueueFrame, isTurnStateFrame } from './schema';
import type { PendingUserEcho } from './timeline';

export type ChatTurnStatus = 'idle' | 'streaming' | 'error';

/**
 * 一条用户消息在**已有进行中的一轮**时该走哪条路（docs/tech/steer-and-queue.md §4.1）：
 * `'queue'` 排队到下一轮（composer 的 Enter 默认），`'steer'` 注入当前这一轮
 * （Alt+Enter / 插话按钮）。没有进行中的一轮时两者都是起新一轮。
 */
export type SendIntent = 'queue' | 'steer';

export interface UseChatMessagesResult {
  messages: NimboUIMessage[];
  /** Short-lived — popped, FIFO, once the real turn-start `MessageFrame` arrives (see file header) — render these interleaved with `messages` via `timeline.ts`'s `buildRenderEntries`. */
  pendingUserEchoes: PendingUserEcho[];
  status: ChatTurnStatus;
  error: string | undefined;
  /** True from `sendMessage` until the first frame of that turn arrives — docs/tech/chat-webapp.md §2.3's "沙盒恢复中…" gate. */
  awaitingFirstEvent: boolean;
  /**
   * 服务端持有的[待发队列](../../../../../docs/terms.md)（docs/tech/steer-and-queue.md）
   * ——初值来自会话详情，之后由直播流的 `QueueFrame` 与删除/清空的响应快照覆盖。
   * 服务端始终是权威，这里不做乐观合并。
   */
  queuedMessages: QueuedMessage[];
  /** `intent` 省略即 `'queue'`（composer 的 Enter 默认）；没有进行中的一轮时 intent 无差别，都会起新一轮。 */
  sendMessage: (text: string, intent?: SendIntent) => void;
  /** 删掉一条还没发出的排队消息。已经出队起轮的删不掉（服务端 404，这里静默忽略——它已经是一条正常消息了）。 */
  removeQueuedMessage: (messageId: string) => void;
  /**
   * 把一条排队消息**取出来立刻插进当前这一轮**（[steer](../../../../../docs/terms.md)）。
   * 服务端没有原子端点，实现是「先出队、再以 steer 发出」两个请求——失败处理见实现处注释。
   */
  promoteQueuedMessage: (message: QueuedMessage) => void;
  /** 清空待发队列。 */
  clearQueue: () => void;
  /**
   * [停止](../../../../../docs/terms.md)进行中的那一轮（docs/tech/turn-abort.md §4.1）
   * ——`POST .../abort`，服务端真中止 + 清空待发队列。**不做乐观状态翻转**：界面回到空闲
   * 只认直播流上那条 `status: 'interrupted'` 的 `message-metadata`。没有进行中的一轮时
   * 是无操作。
   */
  stopTurn: () => void;
  /** 已按下停止、这一轮还没真正停住的中间态——停止键据此进禁用态，避免连点发出多次停止。 */
  stopping: boolean;
  /**
   * `callId`s with an in-flight `POST .../approvals/:callId` or
   * `.../questions/:callId` — cards use this to disable their own
   * buttons/show a spinner and block a second submit for the same `callId`
   * while one is already outstanding.
   */
  submittingCallIds: ReadonlySet<string>;
  /**
   * `submitApproval`/`submitAnswer` got a `404` back for these `callId`s —
   * the server no longer has them pending (already timed out, or the turn
   * already ended). Fed into the tool-part cards (via `TimelineView`/the
   * page) to render the matching part as expired instead of pending.
   */
  locallyExpiredCallIds: ReadonlySet<string>;
  /** Resolve a pending tool-call approval (docs/tech/single-ledger.md §6) — result arrives back over the tail as the matching part's `tool-approval-response` chunk, not from this call's own resolution ("不做乐观翻转"). */
  submitApproval: (
    callId: string,
    behavior: 'allow' | 'allow-session' | 'deny',
  ) => void;
  /** Answer a pending `ask-user` question — same "wire is the only source of truth" posture as `submitApproval`. */
  submitAnswer: (callId: string, answer: string) => void;
}

/** Exponential backoff for tail reconnects — 1s, 2s, 4s, 8s, 16s, then give up quietly. */
const TAIL_RECONNECT_BASE_DELAY_MS = 1000;
const TAIL_RECONNECT_MAX_ATTEMPTS = 5;

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function describeError(error: unknown): string {
  if (error instanceof ChatApiError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * `interrupted` 归 `idle` 而不是 `error`（docs/tech/turn-abort.md §4.1）：那是用户自己
 * 按的[停止](../../../../../docs/terms.md)，不是故障——「已停止」的呈现落在时间线里那条
 * 收尾标记上（`turn-marker.tsx`），不占顶部那条红色的直播中断提示。
 */
function statusFromTurnEnd(metadata: NimboMessageMetadata): ChatTurnStatus {
  return metadata.status === 'failed' ? 'error' : 'idle';
}

function errorFromTurnEnd(metadata: NimboMessageMetadata): string | undefined {
  return metadata.status === 'failed' ? metadata.error?.message : undefined;
}

export function useChatMessages(
  conversationId: string,
  initialFrames: ChatReplayFrame[],
  initialQueuedMessages: QueuedMessage[] = [],
  /**
   * 挂载时「这个会话有没有轮在跑」的初值——来自会话详情的 `turnInProgress`
   * （服务端读[起轮标记](../../../../../docs/terms.md)那一列给出的权威答案）。
   *
   * 它取代了本 hook 曾经的那个猜测（「历史回放的最后一帧是不是 chunk」）：
   * [进行中草稿](../../../../../docs/terms.md)搬进内存之后账本里根本不再有 chunk 行，
   * 那个猜测**恒为假**，于是页面刚打开的几十毫秒里一个明明在跑的会话会被当成空闲。
   * 这个初值只需要撑到 tail 连上——那一刻[轮状态快照](../../../../../docs/terms.md)
   * 会再校正一次（见文件头写入源 3）。
   */
  initialTurnInProgress = false,
): UseChatMessagesResult {
  const [messages, setMessages] = useState<NimboUIMessage[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>(
    () =>
      // 初值优先取 `initialFrames` 里最后一帧队列快照（纯防御——今天
      // `GET .../messages` 只返回账本帧，不会带 `QueueFrame`），否则用会话详情给的
      // 那一份（docs/tech/steer-and-queue.md §4.2）。之后一律由直播流的快照接管。
      initialFrames.filter(isQueueFrame).at(-1)?.queue ?? initialQueuedMessages,
  );
  const [pendingUserEchoes, setPendingUserEchoes] = useState<PendingUserEcho[]>(
    [],
  );
  const [status, setStatus] = useState<ChatTurnStatus>(
    initialTurnInProgress ? 'streaming' : 'idle',
  );
  const [error, setError] = useState<string | undefined>(undefined);
  const [awaitingFirstEvent, setAwaitingFirstEvent] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [submittingCallIds, setSubmittingCallIds] = useState<
    ReadonlySet<string>
  >(new Set());
  const [locallyExpiredCallIds, setLocallyExpiredCallIds] = useState<
    ReadonlySet<string>
  >(new Set());

  const turnInProgressRef = useRef(initialTurnInProgress);
  /** `queuedMessages` 的 ref 镜像——`MessageLedger` 的 `onTurnEnd` 回调（构造时闭包捕获，见下）要在轮收尾的那一刻读到**当下**的队列长度，不能读被闭包冻住的那一份。 */
  const queuedMessagesRef = useRef(initialQueuedMessages);
  const nextEchoIdRef = useRef(0);
  const tailAbortRef = useRef<AbortController | undefined>(undefined);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  // Only seq'd (persisted) frames are dedup-tracked (docs/tech/single-ledger.md §5 单-3) — an
  // ephemeral `ChunkEnvelope` (no `seq`) has no `seq` to dedupe by, and
  // doesn't need one (it's never redelivered by a replay/reconnect the way a
  // persisted frame can be).
  const seenSeqs = useRef(
    new Set(
      initialFrames
        .map(frameSeq)
        .filter((seq): seq is number => seq !== undefined),
    ),
  );
  const lastSeqRef = useRef(
    initialFrames.reduce((max, frame) => {
      const seq = frameSeq(frame);
      return seq !== undefined ? Math.max(max, seq) : max;
    }, 0),
  );

  // One `MessageLedger` instance for this hook's whole lifetime (mirrors
  // `initialFrames` being consumed exactly once — the parent remounts this
  // hook fresh, `key={conversationId}`, on a conversation change, same as before this
  // migration). Constructed *and* seeded inside an effect, not during render:
  // some ledger paths (a steer message, or a standalone turn-end
  // `message-metadata` chunk) call their `onChange`/`onTurnEnd` callbacks
  // *synchronously* — unlike the `readUIMessageStream()`-driven path, which
  // only ever resolves asynchronously via a microtask — and those callbacks
  // close over `turnInProgressRef`/`reconnectAttemptRef` (`react-hooks/refs`
  // flags a ref read inside a closure handed to a call that happens during
  // render, since it can't prove `new MessageLedger(...)`'s constructor
  // won't invoke it synchronously). `initializedRef` survives React
  // StrictMode's deliberate mount→cleanup→mount double-invoke (the component
  // itself is never actually unmounted in between, so the ref isn't reset)
  // — without it, the second invocation would construct a second ledger and
  // re-feed the same history. Declared *before* the tail-opening effect below
  // so this (synchronous) bookkeeping is settled first; `[]` deps is
  // intentional, not a lint oversight: this hook instance's `initialFrames`/
  // `conversationId` are fixed for its whole lifetime (the parent remounts fresh,
  // `key={conversationId}`, on a conversation change — `chat-conversation.tsx`).
  /** 队列的唯一写入口：ref 与 state 一起更新（ref 供 `onTurnEnd` 那个闭包同步读，见其注释）。服务端快照直接覆盖，不做合并——服务端始终是队列的权威。 */
  const applyQueueSnapshot = useCallback((queue: QueuedMessage[]) => {
    queuedMessagesRef.current = queue;
    setQueuedMessages(queue);
  }, []);

  /**
   * [轮状态快照](../../../../../docs/terms.md)的唯一落点（docs/tech/chat-webapp.md §5.1）
   * ——服务端在**每条** tail 连上时告诉我们「这个会话到底有没有轮在跑」，这里据它校正
   * `turnInProgressRef` 与 `status`。
   *
   * 为什么需要它：本 hook 曾经只能**猜**这件事（`lastFrameIsChunk`，见文件头），而那个
   * 猜测在一轮崩溃后长期失准、且永不自愈——用户发的消息一律走排队、没有乐观回显、
   * 还永远等不到出队，按停止也只拿到 409。现在任何「前端与服务端的分叉」都会被下一次
   * tail 连接纠正。
   *
   * 两处刻意的克制：
   *
   * - **不覆盖 `'error'`**：那条红色的直播中断提示是另一件事（连接坏了），不该被一帧
   *   「没有轮在跑」抹掉——它本来就意味着没有轮在跑。只把 `'streaming'` 落回 `'idle'`。
   * - **`turnActive: true` 时不动 `status` 之外的东西**：不清 `error`、不碰队列，那些各有
   *   自己的权威来源。
   */
  const applyTurnState = useCallback((turnActive: boolean) => {
    turnInProgressRef.current = turnActive;
    if (turnActive) {
      setStatus('streaming');
      return;
    }
    setAwaitingFirstEvent(false);
    setStatus((prev) => (prev === 'streaming' ? 'idle' : prev));
    setStopping(false); // 「正在停」的中间态也该结束：服务端已经没有轮可停了
  }, []);

  const ledgerRef = useRef<MessageLedger | undefined>(undefined);
  const initializedRef = useRef(false);
  useEffect(() => {
    if (initializedRef.current) {
      return;
    }
    initializedRef.current = true;
    const ledger = new MessageLedger(
      (nextMessages) => {
        setMessages(nextMessages);
      },
      (metadata) => {
        reconnectAttemptRef.current = 0;
        setError(errorFromTurnEnd(metadata));
        // 这一轮真的停住了（或自己收尾了）——「正在停」的中间态到此结束。放在下面
        // 那个「队列非空则保持 streaming」的提前 return 之前，两条路都要复位。
        setStopping(false);

        // [待发队列](../../../../../docs/terms.md)非空 = 服务端**必然**会自动
        // [出队](../../../../../docs/terms.md)起下一轮（docs/tech/steer-and-queue.md §5.1，
        // 上一轮成功或失败都会走这一步）。所以这里不落回 idle：保持 `streaming` +
        // `turnInProgressRef`，让 tail 的既有退避重连去接住那一轮——否则用户会看到
        // 「转完 → 静止 → 又开始转」的闪烁，甚至以为排队的消息没发出去。
        // 起轮真失败时消息留在队列里，重连退避耗尽后安静停下，刷新即恢复。
        if (queuedMessagesRef.current.length > 0) {
          turnInProgressRef.current = true;
          setStatus('streaming');
          // 下一轮同样要走一整段[起轮装配](../../../../../docs/terms.md)才会出第一帧
          // ——与用户手动发消息那条路一样，AI 侧先摆上「正在准备…」占位，别让时间线
          // 静止在上一轮的收尾上。第一帧一到（或轮状态快照告知没轮在跑）就复位。
          setAwaitingFirstEvent(true);
          return;
        }

        turnInProgressRef.current = false;
        setStatus(statusFromTurnEnd(metadata));
      },
      () => {
        // The real turn-start user message just landed (see file header) —
        // pop the oldest pending echo, FIFO. Guarded so an already-empty
        // queue is a true no-op (returning the same array reference bails
        // React out of a re-render) rather than a harmless-but-wasteful
        // `setState` call — this branch is reachable on mount replay, where
        // `pendingUserEchoes` is always still empty.
        setPendingUserEchoes((prev) =>
          prev.length === 0 ? prev : prev.slice(1),
        );
      },
    );
    ledgerRef.current = ledger;
    for (const frame of initialFrames) {
      // 两种状态快照帧都不属于账本（`QueueFrame`，docs/tech/steer-and-queue.md §4.3；
      // [轮状态快照](../../../../../docs/terms.md)，docs/tech/chat-webapp.md §5.1）
      // ——跳过，不喂 `MessageLedger`。队列快照对状态的贡献已经在 `queuedMessages` 的
      // 初值里算过了（见上）；轮状态快照根本不会出现在 `initialFrames` 里（`GET .../messages`
      // 只回放持久行，它只走直播流），这里跳过它纯粹是让类型收窄在一处说清。
      if (isQueueFrame(frame) || isTurnStateFrame(frame)) {
        continue;
      }
      ledger.applyFrame(frame);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `initialFrames` is this hook instance's fixed seed, not a reactive prop (see comment above)
  }, []);

  const applyFrame = useCallback(
    (frame: ChatReplayFrame) => {
      if (isQueueFrame(frame)) {
        // 权威快照（每条 tail 连上必发一帧，队列变化再广播一帧）——多标签一致靠它。
        applyQueueSnapshot(frame.queue);
        return;
      }
      if (isTurnStateFrame(frame)) {
        applyTurnState(frame.turnActive);
        return;
      }
      const seq = frame.seq;
      if (seq !== undefined) {
        // dedupe: tail reconnect overlap / re-delivery safety net
        if (seenSeqs.current.has(seq)) {
          return;
        }
        seenSeqs.current.add(seq);
        lastSeqRef.current = Math.max(lastSeqRef.current, seq);
      }
      setAwaitingFirstEvent(false);
      // `ledgerRef.current` is only ever `undefined` in the vanishingly brief
      // window between mount and the construction effect above running — the
      // tail's own mount effect is declared after it (same-phase passive
      // effects run in declaration order), so by the time anything actually
      // calls this, it's always set. Guarded rather than asserted non-null.
      ledgerRef.current?.applyFrame(frame);
    },
    [applyQueueSnapshot, applyTurnState],
  );

  // `openTailRef` always holds *this* render's `startTail` closure (fresh
  // `conversationId`/`applyFrame` captured every render, assigned unconditionally
  // below — the standard "ref to latest callback" idiom for a function that
  // needs to schedule a call to its own latest version from a `setTimeout`
  // without a lint-flagged self-reference-before-declaration on the `const`
  // it's assigned to). `openTail` itself is the stable (never-recreated)
  // handle every caller (the mount effect, `sendMessage`) actually uses.
  const openTailRef = useRef<() => void>(() => undefined);

  function startTail(): void {
    tailAbortRef.current?.abort();
    const controller = new AbortController();
    tailAbortRef.current = controller;

    function maybeReconnect(): void {
      // intentionally stopped (unmount/cancel/superseded) — never auto-reconnect
      if (controller.signal.aborted) {
        return;
      }
      // turn already concluded — quiet, nothing to catch up on
      if (!turnInProgressRef.current) {
        return;
      }
      // give up quietly
      if (reconnectAttemptRef.current >= TAIL_RECONNECT_MAX_ATTEMPTS) {
        return;
      }
      const attempt = reconnectAttemptRef.current;
      reconnectAttemptRef.current += 1;
      const delay = TAIL_RECONNECT_BASE_DELAY_MS * 2 ** attempt;
      reconnectTimeoutRef.current = setTimeout(() => {
        openTailRef.current();
      }, delay);
    }

    streamConversationTail(
      conversationId,
      lastSeqRef.current,
      { onFrame: applyFrame },
      controller.signal,
    )
      .then(() => {
        maybeReconnect(); // the tail closed — could be a finished turn (no-op above) or a server hiccup
      })
      .catch((tailError: unknown) => {
        // intentional cancel/unmount/supersede, not a disconnect
        if (isAbortError(tailError)) {
          return;
        }
        maybeReconnect();
      });
  }

  // Refs may only be written outside of render (event handlers/effects, not
  // render itself) — this syncs `openTailRef` to *this* render's `startTail`
  // after every commit (no dependency array), always ahead of the
  // mount/reconnect effect below (same-phase passive effects run in
  // declaration order).
  useEffect(() => {
    openTailRef.current = startTail;
  });

  const openTail = useCallback(() => {
    openTailRef.current();
  }, []);

  useEffect(() => {
    reconnectAttemptRef.current = 0;
    openTail();
    return () => {
      tailAbortRef.current?.abort();
      if (reconnectTimeoutRef.current !== undefined) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = undefined;
      }
    };
  }, [conversationId, openTail]);

  const sendMessage = useCallback(
    (text: string, intent: SendIntent = 'queue') => {
      const trimmed = text.trim();
      if (trimmed.length === 0) {
        return;
      }

      if (turnInProgressRef.current) {
        // 有进行中的一轮：`intent` 决定这条消息是排队还是插话
        // （docs/tech/steer-and-queue.md §4.1，服务端才是判定方，这里只是把意图传过去）。
        // 都不需要重开 tail（这一轮的那条还开着）。失败不动
        // `status`/`turnInProgressRef`：这一轮本身跑得好好的，与这条消息有没有
        // 递进去无关。
        //
        // 两条路的反馈方式不同：
        // - **排队**不做乐观 echo——服务端的 `QueueFrame` 快照会把它回填到待发区，
        //   那里就是它的可见位置。
        // - **插话**做乐观 echo（2026-07-25 加）。它的真实注入点是 core 的下一个
        //   step 边界，当前工具跑得久就可能等几十秒；在那之前界面上什么都不发生，
        //   用户会以为按钮没生效。所以先摆一条标着「待注入」的回显，等 core 真正
        //   注入、真实 user 消息落账本时，由 `onUserMessage` 的 FIFO pop 顶替掉。
        if (intent === 'steer') {
          nextEchoIdRef.current += 1;
          const steerEchoId = nextEchoIdRef.current;
          setPendingUserEchoes((prev) => [
            ...prev,
            {
              id: steerEchoId,
              text: trimmed,
              // 恒定锚到**末尾**（`buildRenderEntries` 会把越界的锚点夹到
              // `entries.length`），而不是像起新一轮那样用 `messages.length` 快照。
              // 差别在等待时长：起新一轮的回显几乎立刻被顶替，快照锚点没机会失效；
              // 插话要等下一个 step 边界，这期间 agent 还在不停产出新消息——用快照
              // 锚点的话，新消息会append 到锚点之后，这条「待注入」就被留在时间线
              // 中间，越飘越上。它属于「还没发生的事」，就该一直待在最下面。
              afterMessageCount: Number.MAX_SAFE_INTEGER,
              steered: true,
            },
          ]);
          postChatMessage(conversationId, trimmed, intent).then(
            (mode) => {
              // 服务端可能**没有**真把它插进这一轮：那一轮还卡在
              // [起轮装配](../../../../../docs/terms.md)里时插不进去（还没有 session），
              // 只能给它排队（docs/tech/turn-abort.md §3.3）。这条「待注入」回显因此
              // 永远等不到注入点，撤掉——它的可见位置改由队列快照给（待发区）。
              if (mode === 'queued') {
                setPendingUserEchoes((prev) =>
                  prev.filter((echo) => echo.id !== steerEchoId),
                );
              }
            },
            (postError: unknown) => {
              // 没递出去就别在时间线上留一条「待注入」——它永远等不到注入。
              setPendingUserEchoes((prev) =>
                prev.filter((echo) => echo.id !== steerEchoId),
              );
              setError(describeError(postError));
            },
          );
          return;
        }

        postChatMessage(conversationId, trimmed, intent).catch(
          (postError: unknown) => {
            setError(describeError(postError));
          },
        );
        return;
      }

      nextEchoIdRef.current += 1;
      const echoId = nextEchoIdRef.current;
      setPendingUserEchoes((prev) => [
        ...prev,
        { id: echoId, text: trimmed, afterMessageCount: messages.length },
      ]);
      setStatus('streaming');
      setError(undefined);
      setAwaitingFirstEvent(true);
      turnInProgressRef.current = true;
      reconnectAttemptRef.current = 0;

      // 没有进行中的一轮 → 服务端必然起新一轮（intent 在这条路径上无差别），
      // 所以这里照旧走乐观 echo + 重开 tail 的老路。
      postChatMessage(conversationId, trimmed, intent)
        .then(() => {
          // The turn is now running server-side, independent of this
          // request — (re)connect the tail to observe it. A prior tail, if
          // any, has necessarily already ended by now (`turnInProgressRef`
          // gated the guard above), so this can't race an existing live
          // connection for the *previous* turn.
          openTail();
        })
        .catch((postError: unknown) => {
          turnInProgressRef.current = false;
          setAwaitingFirstEvent(false);
          setStatus('error');
          setError(describeError(postError));
          // The turn never actually started — undo the optimistic echo.
          setPendingUserEchoes((prev) =>
            prev.filter((echo) => echo.id !== echoId),
          );
        });
    },
    [conversationId, openTail, messages.length],
  );

  const removeQueuedMessage = useCallback(
    (messageId: string) => {
      deleteQueuedMessage(conversationId, messageId)
        .then(applyQueueSnapshot)
        .catch((deleteError: unknown) => {
          // 404 = 这条已经不在队列里了（刚被自动出队成了一轮，或另一个标签页删了）
          // ——不是错误，队列的下一帧快照自会把它从待发区抹掉。
          if (
            deleteError instanceof ChatApiError &&
            deleteError.status === 404
          ) {
            return;
          }
          setError(describeError(deleteError));
        });
    },
    [conversationId, applyQueueSnapshot],
  );

  /**
   * 待发区的「插进本轮」：把一条已排队的消息取出来，立刻注入当前这一轮。
   *
   * 服务端**没有**原子端点（队列端点只会删，`POST .../messages` 只会新增），
   * 所以只能连发两个请求。顺序是刻意的——**先出队、再 steer**：
   *
   * - 反过来（先 steer 再出队）一旦出队那步失败，这条消息会在本轮结束后**再
   *   执行一次**。重复执行一条可能带副作用的指令，比丢失难收拾得多。
   * - 这个顺序的坏情况是「出了队却没插进去」，可恢复：这里会尽力把它按原样
   *   排回队列；连补回都失败时，把原文放进错误提示里，让用户能直接复制重发。
   *   任何一档都不静默吞掉。
   */
  const promoteQueuedMessage = useCallback(
    (message: QueuedMessage) => {
      deleteQueuedMessage(conversationId, message.id).then(
        (snapshot) => {
          applyQueueSnapshot(snapshot);
          postChatMessage(conversationId, message.text, 'steer').catch(
            (steerError: unknown) => {
              const why = describeError(steerError);
              postChatMessage(conversationId, message.text, 'queue').then(
                () => {
                  setError(`插进本轮失败：${why}——这条消息已退回待发队列`);
                },
                () => {
                  setError(
                    `插进本轮失败：${why}——这条消息也没能退回队列，需要你重发：${message.text}`,
                  );
                },
              );
            },
          );
        },
        (deleteError: unknown) => {
          // 404 = 这条刚被自动出队、已经起了一轮——它本来就已经在跑了，不是错误。
          if (
            deleteError instanceof ChatApiError &&
            deleteError.status === 404
          ) {
            return;
          }
          setError(describeError(deleteError));
        },
      );
    },
    [conversationId, applyQueueSnapshot],
  );

  const clearQueue = useCallback(() => {
    clearQueuedMessages(conversationId)
      .then(applyQueueSnapshot)
      .catch((clearError: unknown) => {
        setError(describeError(clearError));
      });
  }, [conversationId, applyQueueSnapshot]);

  /**
   * [停止](../../../../../docs/terms.md)本轮（docs/tech/turn-abort.md §4.1）。取代了本
   * hook 早先那个 `cancel`——它只 abort 本地那条 SSE 连接、把 status 拍成 idle，服务端
   * 那一轮照样跑到底（刷新页面又全冒出来），从来没敢接到界面上。
   *
   * 两条刻意的姿态：
   *
   * - **不断开 tail**：还要靠它接住这一轮的 `interrupted` 收尾帧。
   * - **不做乐观翻转**：`status`/`turnInProgressRef` 一律等 wire 上真实到达的那条
   *   `message-metadata`（与审批同一姿态）；这里只置一个「正在停」的中间态。
   */
  const stopTurn = useCallback(() => {
    // 没有进行中的一轮 = 无操作
    if (!turnInProgressRef.current) {
      return;
    }
    setStopping(true);
    postAbortTurn(conversationId)
      .then(applyQueueSnapshot)
      .catch((abortError: unknown) => {
        setStopping(false);
        // 409 = 没有进行中的一轮：这一轮刚好自己收尾了，或另一个标签页已经停了它
        // ——用户要的结果已经达成，不是错误。
        if (abortError instanceof ChatApiError && abortError.status === 409) {
          return;
        }
        setError(describeError(abortError));
      });
  }, [conversationId, applyQueueSnapshot]);

  const markSubmitting = useCallback((callId: string) => {
    setSubmittingCallIds((prev) => new Set(prev).add(callId));
  }, []);

  const clearSubmitting = useCallback((callId: string) => {
    setSubmittingCallIds((prev) => {
      if (!prev.has(callId)) {
        return prev;
      }
      const next = new Set(prev);
      next.delete(callId);
      return next;
    });
  }, []);

  /**
   * `POST .../approvals/:callId` / `.../questions/:callId` (docs/tech/single-ledger.md §6): both
   * `submitApproval` and `submitAnswer` below funnel through this — mark
   * `callId` submitting, fire the request, and on failure either flag it
   * `locallyExpiredCallIds` (a `404`: the server no longer has it pending) or
   * surface it via the hook's own `error` (anything else — the part stays
   * pending, retryable). The *success* path deliberately does nothing to
   * `messages`: the decision's real effect only lands once the matching
   * `tool-approval-response` chunk (or the `ask-user` part's own
   * `output-available`) arrives over the tail ("不做乐观翻转——多 tab 一致性
   * 靠事件").
   */
  const submitDecision = useCallback(
    (callId: string, request: () => Promise<void>) => {
      // one in flight per callId — the card also disables its own button, this is defense in depth
      if (submittingCallIds.has(callId)) {
        return;
      }
      markSubmitting(callId);
      request()
        .catch((requestError: unknown) => {
          if (
            requestError instanceof ChatApiError &&
            requestError.status === 404
          ) {
            setLocallyExpiredCallIds((prev) => new Set(prev).add(callId));
            return;
          }
          setError(describeError(requestError));
        })
        .finally(() => {
          clearSubmitting(callId);
        });
    },
    [submittingCallIds, markSubmitting, clearSubmitting],
  );

  const submitApproval = useCallback(
    (callId: string, behavior: 'allow' | 'allow-session' | 'deny') => {
      submitDecision(callId, () =>
        postApprovalDecision(conversationId, callId, { behavior }),
      );
    },
    [conversationId, submitDecision],
  );

  const submitAnswer = useCallback(
    (callId: string, answer: string) => {
      const trimmed = answer.trim();
      if (trimmed.length === 0) {
        return;
      }
      submitDecision(callId, () =>
        postQuestionAnswer(conversationId, callId, trimmed),
      );
    },
    [conversationId, submitDecision],
  );

  return useMemo(
    () => ({
      messages,
      pendingUserEchoes,
      status,
      error,
      awaitingFirstEvent,
      queuedMessages,
      sendMessage,
      removeQueuedMessage,
      promoteQueuedMessage,
      clearQueue,
      stopTurn,
      stopping,
      submittingCallIds,
      locallyExpiredCallIds,
      submitApproval,
      submitAnswer,
    }),
    [
      messages,
      pendingUserEchoes,
      status,
      error,
      awaitingFirstEvent,
      queuedMessages,
      sendMessage,
      removeQueuedMessage,
      promoteQueuedMessage,
      clearQueue,
      stopTurn,
      stopping,
      submittingCallIds,
      locallyExpiredCallIds,
      submitApproval,
      submitAnswer,
    ],
  );
}
