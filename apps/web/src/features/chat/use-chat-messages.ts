/**
 * chat 功能的核心交付物（docs/ingress/tech/chat-webapp.md §2.2b）：把一轮的**执行**
 * 与**连接**解耦。
 *
 * `sendMessage` 只做两件事——发 `POST .../messages`（服务端就此起一轮，与任何一次
 * 请求/响应的生命周期无关），然后（重）开那条可续传的直播流
 * （`GET .../stream?after=<seq>`）。直播流在挂载时也会无条件开一次，所以刷新页面、
 * HMR 重载、标签页恢复都能重新连上刷新前还在跑的那一轮，从上次断开的地方接着收帧。
 *
 * `turnInProgressRef` 是本 hook 自己对「**这个**会话现在有没有轮在跑」的判断。它决定
 * 两件事：(a) `sendMessage` 走下面两条分支里的哪一条（起新一轮，还是排队/插话到进行
 * 中的那一轮）；(b) 一条刚结束的直播流（正常结束或出错结束）要不要重连。
 *
 * 它有三个写入源，权威性递增：
 *
 * 1. **挂载时的初值**（会话详情的 `turnInProgress`，服务端读[起轮标记](../../../../../docs/terms.md)
 *    那一列给出）：只用来撑到 tail 连上的那几十毫秒。
 * 2. **`MessageLedger` 的 `onTurnEnd`**（docs/logic/orchestration/tech/single-ledger.md §5 单-3 那条收尾
 *    `message-metadata`）：一轮真正结束的那一刻翻假。
 * 3. **[轮状态快照](../../../../../docs/terms.md)**（`applyTurnState`，
 *    docs/ingress/tech/chat-webapp.md §5.1）：**服务端的权威答案**，每条 tail 连上必发一帧。
 *
 * 第 3 条补的是前两条都盖不住的那个洞：一轮**崩溃**时（进程重启、`driveTurn` 的
 * catch 分支）收尾 metadata 永远不会到，而崩溃残留的 `kind = 'chunk'` 行又永不 GC，
 * 于是第 1 条那个初值此后**每次**打开这个会话都说「有轮在跑」，且永不自愈。后果是
 * 用户发的消息一律走[排队](../../../../../docs/terms.md)、没有下面那套乐观回显、而且
 * 永远等不到[出队](../../../../../docs/terms.md)（没有轮会收尾去触发它）；按
 * [停止](../../../../../docs/terms.md)也只会拿到 409。有了第 3 条，**任何**前端与服务端
 * 的分叉都会被下一次 tail 连接纠正。
 *
 * ---- 乐观用户回显（只是个短命占位） ----
 *
 * 起一轮的那条用户消息在 wire 上有真实位置：`apps/node-server` 的
 * `turn-runner/drive.ts` 里，`driveTurn` 会合成它并作为这一轮的**第一个**
 * `MessageFrame` 广播出去，严格早于这一轮产出的任何别的东西（见 `schemas/chat.ts`
 * 的文件头）。
 *
 * 所以 `pendingUserEchoes` 只是个**短命**占位，盖住「`sendMessage` 发出 `POST`」到
 * 「那条真实 `MessageFrame` 经 tail 到达」之间的那一小段空窗。它只在 `sendMessage`
 * 的「起新一轮」分支产生，插话分支不产生——插话会立刻拿到一条真实物化出来的条目。
 *
 * 每条回显锚在它发出时的 `messages.length` 上（`timeline.ts` 的 `buildRenderEntries`
 * 据此把它插回发出时的位置），并在 `MessageLedger` 报出一条 `role === 'user'` 的
 * `MessageFrame` 的那一刻按 FIFO 弹出（见下面构造 `ledgerRef` 时的 `onUserMessage`；
 * 为什么**只有** `MessageFrame` 能弹、插话消息那条 chunk 物化出来的条目不能，见
 * `materialize.ts` 的 `UserMessageListener` 注释）。
 *
 * 正常流程下同一时刻最多只有一条回显在等：一轮必须等上一轮的 `onTurnEnd` 触发之后
 * 才起得来，而那必然晚于上一轮自己那条回显被弹出。`buildRenderEntries` 仍然把同锚点
 * 的回显按 id 升序（= 发送顺序）排，那是防御性兜底（见它自己的注释），万一闭包过期
 * 之类的竞态真产生了两条也不会乱序。
 */
import type { RunkoMessageMetadata, RunkoUIMessage } from '@runko/core';
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
import {
  frameSeq,
  isQueueFrame,
  isReconnectFrame,
  isTurnStateFrame,
} from './schema';
import type { PendingUserEcho } from './timeline';
import { findWaitingCallIds } from './timeline';
import type { ChatTransport } from './transport';
import { useChatTransport } from './transport';
import {
  ChatWebSocketError,
  CLOSE_SERVICE_RESTART,
  streamConversationTailWs,
} from './ws';

export type ChatTurnStatus = 'idle' | 'streaming' | 'error';

/**
 * 一条用户消息在**已有进行中的一轮**时该走哪条路（docs/logic/orchestration/tech/steer-and-queue.md §4.1）：
 * `'queue'` 排队到下一轮（composer 的 Enter 默认），`'steer'` 注入当前这一轮
 * （Alt+Enter / 插话按钮）。没有进行中的一轮时两者都是起新一轮。
 */
export type SendIntent = 'queue' | 'steer';

export interface UseChatMessagesResult {
  messages: RunkoUIMessage[];
  /** 短命占位：起轮那条真实 `MessageFrame` 一到就按 FIFO 弹出（见文件头）。用 `timeline.ts` 的 `buildRenderEntries` 把它们与 `messages` 交错渲染。 */
  pendingUserEchoes: PendingUserEcho[];
  status: ChatTurnStatus;
  error: string | undefined;
  /** 从 `sendMessage` 起、到这一轮第一帧到达为止恒为 true——docs/ingress/tech/chat-webapp.md §2.3 那个「沙盒恢复中…」的闸门。 */
  awaitingFirstEvent: boolean;
  /**
   * 服务端持有的[待发队列](../../../../../docs/terms.md)（docs/logic/orchestration/tech/steer-and-queue.md）
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
   * [停止](../../../../../docs/terms.md)进行中的那一轮（docs/logic/orchestration/tech/turn-abort.md §4.1）
   * ——`POST .../abort`，服务端真中止 + 清空待发队列。**不做乐观状态翻转**：界面回到空闲
   * 只认直播流上那条 `status: 'interrupted'` 的 `message-metadata`。没有进行中的一轮时
   * 是无操作。
   */
  stopTurn: () => void;
  /** 已按下停止、这一轮还没真正停住的中间态——停止键据此进禁用态，避免连点发出多次停止。 */
  stopping: boolean;
  /**
   * 正有一个 `POST .../approvals/:callId` 或 `.../questions/:callId` 在飞的那些
   * `callId`。卡片据此禁用自己的按钮、显示转圈，并挡住同一个 `callId` 的第二次提交。
   *
   * 还包括**答过的[挂起](../../../../../docs/terms.md)调用**：答完到恢复那一轮真的改写它，
   * 中间可能隔几十秒（唤醒沙盒），这段时间按钮不能重新亮起来（docs/ingress/tech/chat-webapp.md §6.2 ③）。
   */
  submittingCallIds: ReadonlySet<string>;
  /**
   * [挂起](../../../../../docs/terms.md)之后还在等人答的调用，从账本推出来（`timeline.ts` 的
   * `findWaitingCallIds`）。这些卡片虽然属于已收尾的轮，却仍然可以答。
   */
  waitingCallIds: ReadonlySet<string>;
  /**
   * `submitApproval`/`submitAnswer` 对这些 `callId` 拿回了 `404`——服务端已经不再挂着
   * 它们了（超时了，或者那一轮已经结束）。这份集合经 `TimelineView`/页面传给工具部件
   * 的卡片，让对应部件画成「已失效」而不是「等待中」。
   */
  locallyExpiredCallIds: ReadonlySet<string>;
  /** 裁决一条挂起的工具调用审批（docs/logic/orchestration/tech/single-ledger.md §6）。结果不从这次调用自己的返回值来，而是等 tail 上对应部件那条 `tool-approval-response` chunk（「不做乐观翻转」）。 */
  submitApproval: (
    callId: string,
    behavior: 'allow' | 'allow-session' | 'deny',
  ) => void;
  /** 回答一条挂起的 `ask-user` 提问——与 `submitApproval` 同一种「只认 wire」的姿态。 */
  submitAnswer: (callId: string, answer: string) => void;
}

/** 直播流重连的指数退避——1s、2s、4s、8s、16s，然后安静放弃。真正的断线（没收到[请重连帧](../../../../../docs/terms.md)就断了）走这一条。 */
const TAIL_RECONNECT_BASE_DELAY_MS = 1000;
const TAIL_RECONNECT_MAX_ATTEMPTS = 5;

/**
 * [快速重连](../../../../../docs/terms.md)（docs/logic/orchestration/tech/handover.md §8）：收到
 * [请重连帧](../../../../../docs/terms.md)、或 WebSocket 以 1012 关闭时，**不走**上面那套指数
 * 退避——每隔这么久马上再试一次。
 */
const FAST_RECONNECT_INTERVAL_MS = 250;
/** 快速重连最多试这么久；用完了还没连上，退回原有的指数退避（从头计数）。 */
const FAST_RECONNECT_WINDOW_MS = 10_000;

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
 * `interrupted` 归 `idle` 而不是 `error`（docs/logic/orchestration/tech/turn-abort.md §4.1）：那是用户自己
 * 按的[停止](../../../../../docs/terms.md)，不是故障——「已停止」的呈现落在时间线里那条
 * 收尾标记上（`turn-marker.tsx`），不占顶部那条红色的直播中断提示。
 */
function statusFromTurnEnd(metadata: RunkoMessageMetadata): ChatTurnStatus {
  return metadata.status === 'failed' ? 'error' : 'idle';
}

function errorFromTurnEnd(metadata: RunkoMessageMetadata): string | undefined {
  return metadata.status === 'failed' ? metadata.error?.message : undefined;
}

/**
 * [直播流](../../../../../docs/terms.md)走哪条通道，由用户在设置页选（`transport.ts`）。
 * 两个实现签名相同，重连与断线续传都在本文件里、两边共用。
 *
 * 为什么留两条、为什么开关交给用户：见 docs/ingress/features/ws-stream.md。
 */
function streamerFor(transport: ChatTransport) {
  return transport === 'ws' ? streamConversationTailWs : streamConversationTail;
}

export function useChatMessages(
  conversationId: string,
  initialFrames: ChatReplayFrame[],
  initialQueuedMessages: QueuedMessage[] = [],
  /**
   * 挂载时「这个会话有没有轮在跑」的初值——来自会话详情的 `turnInProgress`
   * （服务端读[起轮标记](../../../../../docs/terms.md)那一列给出的权威答案）。
   *
   * 它只需要撑到 tail 连上：那一刻[轮状态快照](../../../../../docs/terms.md)会再校正
   * 一次（见文件头写入源 3）。
   */
  initialTurnInProgress = false,
): UseChatMessagesResult {
  /** 用户在设置页选的通道。改了要立刻换——见下面那个开 tail 的 effect。 */
  const transport = useChatTransport();
  const [messages, setMessages] = useState<RunkoUIMessage[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>(
    () =>
      // 初值优先取 `initialFrames` 里最后一帧队列快照（纯防御——今天
      // `GET .../messages` 只返回账本帧，不会带 `QueueFrame`），否则用会话详情给的
      // 那一份（docs/logic/orchestration/tech/steer-and-queue.md §4.2）。之后一律由直播流的快照接管。
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
  /** 答过的挂起调用。只增不减：它只在与 `waitingCallIds` 的交集里起作用，部件一变就自然失效。 */
  const [answeredWaitingCallIds, setAnsweredWaitingCallIds] = useState<
    ReadonlySet<string>
  >(new Set());
  const waitingCallIds = useMemo(
    () => findWaitingCallIds(messages),
    [messages],
  );

  const turnInProgressRef = useRef(initialTurnInProgress);
  /** `queuedMessages` 的 ref 镜像——`MessageLedger` 的 `onTurnEnd` 回调（构造时闭包捕获，见下）要在轮收尾的那一刻读到**当下**的队列长度，不能读被闭包冻住的那一份。 */
  const queuedMessagesRef = useRef(initialQueuedMessages);
  const nextEchoIdRef = useRef(0);
  const tailAbortRef = useRef<AbortController | undefined>(undefined);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  /**
   * 收到[请重连帧](../../../../../docs/terms.md)（或 WS 以 1012 关闭）时，置为
   * `Date.now() + FAST_RECONNECT_WINDOW_MS`；`maybeReconnect` 据此判定这次重连要不要
   * 走[快速重连](../../../../../docs/terms.md)而不是指数退避。`undefined` = 没有这回事，
   * 走原有退避。
   */
  const fastReconnectDeadlineRef = useRef<number | undefined>(undefined);
  /**
   * `maybeReconnect()` 判定要真正重新打开一条 tail 连接时（快速重连或指数退避，两条
   * 路都会）置真，`startTail()` 里在接新连接的帧之前消费并复位。
   *
   * 只在**重连**时置真——`sendMessage`/`followResumedTurn`/挂起排队那几处主动
   * `openTail()` 不走这里：那些是**上一轮已经收尾之后**为一轮全新的对话开连接，
   * 上一轮没来得及落地的草稿本来就不会再被更新，丢了就是真丢，不能碰。
   *
   * 覆盖两种情形：① `onTurnEnd` 已经确认过「模型输出段被交权」（那次已经立刻丢过一次，
   * 这里防的是请重连帧到达前，这条连接自己先意外断线重连的窄窗口）；② 那条
   * `handed-over` 的 metadata 发出的那一刻连接正好断着，客户端从未见过它——这两种都
   * 一样：接手节点接着调模型是**新开一条**assistant 消息（旧的半截字不会再更新），
   * 而同节点上真正的网络抖动重连，服务端会把当前草稿按原 id 重发、`upsert()` 自然
   * 覆盖——所以「重连一律先丢一次手上的草稿」在这两种情形下都不会丢真实内容。
   */
  const discardDraftOnNextReconnectRef = useRef(false);

  // 只有带 seq（已落盘）的帧才做去重簿记（docs/logic/orchestration/tech/single-ledger.md §5 单-3）。
  // 一次性的 `ChunkEnvelope` 没有 `seq` 可以拿来去重，也不需要——它不会像落盘帧那样
  // 被回放/重连重复投递一次。
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

  // 本 hook 的整个生命周期里只有一个 `MessageLedger` 实例，与「`initialFrames` 只被
  // 消费一次」对应——换会话时父组件靠 `key={conversationId}` 把本 hook 整个重挂。
  //
  // 它在 effect 里构造**并**灌种，不在 render 期间做。原因：账本有些路径（插话消息、
  // 或一条独立的收尾 `message-metadata` chunk）会**同步**调 `onChange`/`onTurnEnd`
  // 回调，而不是像 `readUIMessageStream()` 驱动的那条路那样必经一个微任务才异步落地；
  // 这两个回调闭包里读了 `turnInProgressRef`/`reconnectAttemptRef`，`react-hooks/refs`
  // 会拦——它没法证明 `new MessageLedger(...)` 的构造函数不会同步调用它们。
  //
  // `initializedRef` 用来扛住 React StrictMode 故意做的 mount→cleanup→mount 双调：
  // 组件中间并没有真的卸载，所以这个 ref 不会被重置。没有它的话，第二次调用会再造一个
  // 账本、把同一段历史重灌一遍。
  //
  // 这一段声明在下面开 tail 的 effect **之前**，让这段（同步的）簿记先落定。`[]` 依赖
  // 数组是刻意的，不是 lint 疏漏：本 hook 实例的 `initialFrames`/`conversationId` 在它
  // 整个生命周期里固定不变（换会话时父组件 `key={conversationId}` 重挂，见
  // `chat-conversation.tsx`）。
  /** 队列的唯一写入口：ref 与 state 一起更新（ref 供 `onTurnEnd` 那个闭包同步读，见其注释）。服务端快照直接覆盖，不做合并——服务端始终是队列的权威。 */
  const applyQueueSnapshot = useCallback((queue: QueuedMessage[]) => {
    queuedMessagesRef.current = queue;
    setQueuedMessages(queue);
  }, []);

  /**
   * [轮状态快照](../../../../../docs/terms.md)的唯一落点（docs/ingress/tech/chat-webapp.md §5.1）
   * ——服务端在**每条** tail 连上时告诉我们「这个会话到底有没有轮在跑」，这里据它校正
   * `turnInProgressRef` 与 `status`。任何「前端与服务端的分叉」都会被下一次 tail 连接
   * 纠正。
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
        // 这一轮真的停住了（或自己收尾了）——「正在停」的中间态到此结束。放在下面
        // 那个「队列非空则保持 streaming」的提前 return 之前，两条路都要复位。
        setStopping(false);

        // [已交权](../../../../../docs/terms.md)：这一轮没结束，别的节点接着跑——不报错、
        // 不落回 idle，保持 `streaming`，等新节点的帧接上（docs/logic/orchestration/tech/handover.md §6）。
        // `handedOver.callIds` 为空 = 模型输出段被交权，那半段字要被接手节点重新生成的
        // 内容整体替换，这里立刻丢掉（`materialize.ts` `replaceDraft` 的注释）；非空 = 工具段
        // 被交权，账本末尾那次悬空调用是真实状态，留给接手节点结清，不能当草稿丢。
        if (metadata.status === 'handed-over') {
          if ((metadata.handedOver?.callIds.length ?? 0) === 0) {
            // 立刻丢一次——这里就是「草稿变成成品」的分界点，减少请重连帧到达之前
            // 那几十到几百毫秒里界面停留在半截字上的时间。就算这条连接在这之后、
            // 请重连帧到达之前意外断线，下一次真正重连时 `startTail()` 也会兜底
            // 再丢一次（见 `discardDraftOnNextReconnectRef` 的注释）。
            ledgerRef.current?.replaceDraft();
          }
          turnInProgressRef.current = true;
          setStatus('streaming');
          setAwaitingFirstEvent(true);
          return;
        }

        setError(errorFromTurnEnd(metadata));

        // [待发队列](../../../../../docs/terms.md)非空 = 服务端**必然**会自动
        // [出队](../../../../../docs/terms.md)起下一轮（docs/logic/orchestration/tech/steer-and-queue.md §5.1，
        // 上一轮成功或失败都会走这一步）。所以这里不落回 idle：保持 `streaming` +
        // `turnInProgressRef`，让 tail 的既有退避重连去接住那一轮——否则用户会看到
        // 「转完 → 静止 → 又开始转」的闪烁，甚至以为排队的消息没发出去。
        // 起轮真失败时消息留在队列里，重连退避耗尽后安静停下，刷新即恢复。
        //
        // [挂起](../../../../../docs/terms.md)的那一轮除外：服务端这时不出队，要等人把卡片答完
        // （docs/ingress/tech/chat-webapp.md §6.2 ⑤）。
        if (
          metadata.status !== 'suspended' &&
          queuedMessagesRef.current.length > 0
        ) {
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
        // 起轮那条真实的用户消息刚到（见文件头）——按 FIFO 弹掉最老的那条待发回显。
        // 判空是为了让「本来就是空的」成为真正的无操作：返回同一个数组引用能让 React
        // 跳过重渲染，而不是白调一次 `setState`。挂载回放时会走到这一支，那时
        // `pendingUserEchoes` 一定还是空的。
        setPendingUserEchoes((prev) =>
          prev.length === 0 ? prev : prev.slice(1),
        );
      },
    );
    ledgerRef.current = ledger;
    for (const frame of initialFrames) {
      // 三种非账本帧都跳过、不喂 `MessageLedger`（`QueueFrame`，docs/logic/orchestration/tech/steer-and-queue.md §4.3；
      // [轮状态快照](../../../../../docs/terms.md)，docs/ingress/tech/chat-webapp.md §5.1；
      // [请重连帧](../../../../../docs/terms.md)，docs/logic/orchestration/tech/handover.md §8）。队列快照对状态的
      // 贡献已经在 `queuedMessages` 的初值里算过了（见上）；轮状态快照与请重连帧都根本不会
      // 出现在 `initialFrames` 里（`GET .../messages` 只回放持久行，它们只走直播流），这里
      // 跳过纯粹是让类型收窄在一处说清。
      if (
        isQueueFrame(frame) ||
        isTurnStateFrame(frame) ||
        isReconnectFrame(frame)
      ) {
        continue;
      }
      ledger.applyFrame(frame);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `initialFrames` 是本 hook 实例固定的种子，不是响应式 prop（见上面的注释）
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
      if (isReconnectFrame(frame)) {
        // [请重连帧](../../../../../docs/terms.md)：这条连接要关了，新持有者已经接手——
        // 开一扇[快速重连](../../../../../docs/terms.md)窗口，`maybeReconnect` 据此跳过
        // 指数退避（docs/logic/orchestration/tech/handover.md §8）。它是这条连接的最后一帧，
        // 服务端发完就会自己关掉，用不着这里主动断。
        fastReconnectDeadlineRef.current =
          Date.now() + FAST_RECONNECT_WINDOW_MS;
        return;
      }
      const seq = frame.seq;
      if (seq !== undefined) {
        // 去重：兜住 tail 重连时的重叠段与重复投递
        if (seenSeqs.current.has(seq)) {
          return;
        }
        seenSeqs.current.add(seq);
        lastSeqRef.current = Math.max(lastSeqRef.current, seq);
      }
      setAwaitingFirstEvent(false);
      // `ledgerRef.current` 只在「挂载」到「上面那个构造 effect 跑完」之间那一瞬是
      // `undefined`。开 tail 的那个 effect 声明在它后面（同一阶段的 passive effect
      // 按声明顺序执行），所以真正调到这里时它一定已经就位。这里用可选链兜着，不用
      // 非空断言。
      ledgerRef.current?.applyFrame(frame);
    },
    [applyQueueSnapshot, applyTurnState],
  );

  // `openTailRef` 里永远是**本次** render 的 `startTail` 闭包（每次 render 都重新捕获
  // 最新的 `conversationId`/`applyFrame`，并在下面无条件赋值）。这是「ref 指向最新回调」
  // 的标准写法：这个函数要能从 `setTimeout` 里调起自己的最新版本，而直接引用会踩到
  // 「`const` 声明前自引用」的 lint。
  //
  // `openTail` 才是稳定的（永不重建的）句柄，所有调用方（挂载 effect、`sendMessage`）
  // 用的都是它。
  const openTailRef = useRef<() => void>(() => undefined);

  function startTail(): void {
    // `maybeReconnect()` 判定要重连时已经置真——见 `discardDraftOnNextReconnectRef`
    // 的注释：这里在真正（重）开连接、接住新连接的帧之前丢一次手上的草稿。
    if (discardDraftOnNextReconnectRef.current) {
      discardDraftOnNextReconnectRef.current = false;
      ledgerRef.current?.replaceDraft();
    }

    tailAbortRef.current?.abort();
    const controller = new AbortController();
    tailAbortRef.current = controller;

    function maybeReconnect(): void {
      // 主动停掉的（卸载/取消/被新连接顶替）——绝不自动重连
      if (controller.signal.aborted) {
        return;
      }
      // 那一轮已经结束了——安静收工，没有什么要追的
      if (!turnInProgressRef.current) {
        return;
      }

      // [快速重连](../../../../../docs/terms.md)：收到过请重连帧（或 WS 以 1012 关闭），
      // 窗口没过期就不走下面的指数退避，隔 `FAST_RECONNECT_INTERVAL_MS` 直接再试。
      const fastDeadline = fastReconnectDeadlineRef.current;
      if (fastDeadline !== undefined) {
        if (Date.now() < fastDeadline) {
          discardDraftOnNextReconnectRef.current = true;
          reconnectTimeoutRef.current = setTimeout(() => {
            openTailRef.current();
          }, FAST_RECONNECT_INTERVAL_MS);
          return;
        }
        // 窗口用完还没连上——退回原有的退避逻辑，从头计数。
        fastReconnectDeadlineRef.current = undefined;
        reconnectAttemptRef.current = 0;
      }

      // 退避次数用完，安静放弃
      if (reconnectAttemptRef.current >= TAIL_RECONNECT_MAX_ATTEMPTS) {
        return;
      }
      const attempt = reconnectAttemptRef.current;
      reconnectAttemptRef.current += 1;
      const delay = TAIL_RECONNECT_BASE_DELAY_MS * 2 ** attempt;
      discardDraftOnNextReconnectRef.current = true;
      reconnectTimeoutRef.current = setTimeout(() => {
        openTailRef.current();
      }, delay);
    }

    // 这条连接是否已经收到过第一帧——收到就说明这次（重）连成功了，结束[快速重连]
    // (../../../../../docs/terms.md)窗口，回到「只有真断线才 250ms 重试」的姿态。
    // 不然窗口只在到期时才清（见 `fastReconnectDeadlineRef` 的注释）：一次成功的
    // 重连并不会替我们把它关掉，窗口剩下的时间里，哪怕是完全正常的收线/断线也会被
    // 当成快速重连、每 250ms 重试一次。
    let receivedFirstFrame = false;
    function handleFrame(frame: ChatReplayFrame): void {
      if (!receivedFirstFrame) {
        receivedFirstFrame = true;
        fastReconnectDeadlineRef.current = undefined;
      }
      applyFrame(frame);
    }

    // 每次（重）连都现读一次用户的选择：设置页一改，下一次连接就换通道。
    streamerFor(transport)(
      conversationId,
      lastSeqRef.current,
      { onFrame: handleFrame },
      controller.signal,
    )
      .then(() => {
        maybeReconnect(); // 流关了——可能是这一轮跑完了（上面会直接 return），也可能是服务端抽了一下
      })
      .catch((tailError: unknown) => {
        // 主动取消/卸载/被顶替，不是掉线
        if (isAbortError(tailError)) {
          return;
        }
        // WebSocket 专属：以[请重连帧](../../../../../docs/terms.md)之后的关闭码收尾，
        // 与收到那一帧本身同等对待（它前面理应已经收到过那一帧，这里是双保险，
        // 见 `ws.ts` `CLOSE_SERVICE_RESTART` 的注释）。
        if (
          tailError instanceof ChatWebSocketError &&
          tailError.code === CLOSE_SERVICE_RESTART
        ) {
          fastReconnectDeadlineRef.current =
            Date.now() + FAST_RECONNECT_WINDOW_MS;
        }
        maybeReconnect();
      });
  }

  // ref 只能在 render 之外写（事件处理器/effect 里，不能在 render 本身里）。这个不带
  // 依赖数组的 effect 在每次 commit 之后把 `openTailRef` 同步成**本次** render 的
  // `startTail`，而且总排在下面那个挂载/重连 effect 之前（同一阶段的 passive effect
  // 按声明顺序执行）。
  useEffect(() => {
    openTailRef.current = startTail;
  });

  const openTail = useCallback(() => {
    openTailRef.current();
  }, []);

  // `transport` 在依赖里：用户在设置页换了通道，这里就断开旧连接、用新通道重连。
  // 不会丢内容——重连带着 `lastSeqRef`，从上次收到的那条接着来（与掉线重连同一条路）。
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
  }, [conversationId, openTail, transport]);

  const sendMessage = useCallback(
    (text: string, intent: SendIntent = 'queue') => {
      const trimmed = text.trim();
      if (trimmed.length === 0) {
        return;
      }

      if (!turnInProgressRef.current && waitingCallIds.size > 0) {
        // [挂起](../../../../../docs/terms.md)中：服务端不会起轮，只会把它放进待发队列
        // （docs/ingress/tech/chat-webapp.md §6.2 ⑤）。所以没有「起新一轮」的乐观回显，也谈不上
        // 插话。发完重开一次 tail 取回队列快照：直播流此刻关着，服务端广播的那帧收不到。
        postChatMessage(conversationId, trimmed, 'queue').then(
          () => {
            openTail();
          },
          (postError: unknown) => {
            setError(describeError(postError));
          },
        );
        return;
      }

      if (turnInProgressRef.current) {
        // 有进行中的一轮：`intent` 决定这条消息是排队还是插话
        // （docs/logic/orchestration/tech/steer-and-queue.md §4.1，服务端才是判定方，这里只是把意图传过去）。
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
              // 只能给它排队（docs/logic/orchestration/tech/turn-abort.md §3.3）。这条「待注入」回显因此
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
          // 这一轮此刻已经在服务端跑起来了，与这次请求无关——（重）开 tail 去观察它。
          // 上一条 tail（如果有）到这里必然已经结束（上面那个判断由
          // `turnInProgressRef` 把着），所以不会和**上一轮**那条还活着的连接抢。
          openTail();
        })
        .catch((postError: unknown) => {
          turnInProgressRef.current = false;
          setAwaitingFirstEvent(false);
          setStatus('error');
          setError(describeError(postError));
          // 这一轮根本没起来——把乐观回显撤掉。
          setPendingUserEchoes((prev) =>
            prev.filter((echo) => echo.id !== echoId),
          );
        });
    },
    [conversationId, openTail, messages.length, waitingCallIds],
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
   * [停止](../../../../../docs/terms.md)本轮（docs/logic/orchestration/tech/turn-abort.md §4.1）。
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
   * `POST .../approvals/:callId` / `.../questions/:callId`
   * （docs/logic/orchestration/tech/single-ledger.md §6）：下面的 `submitApproval` 与
   * `submitAnswer` 都收口到这里。
   *
   * 流程是：把 `callId` 标成「提交中」→ 发请求 → 失败时分两档处理。`404` 说明服务端
   * 已经不挂着它了，记进 `locallyExpiredCallIds`；其余错误经 hook 自己的 `error` 抛给
   * 界面，对应部件保持挂起、可以重试。
   *
   * 成功这条路刻意**不动** `messages`：裁决的真实效果要等 tail 上对应那条
   * `tool-approval-response` chunk（或 `ask-user` 部件自己的 `output-available`）到达才
   * 落地（「不做乐观翻转——多 tab 一致性靠事件」）。
   */
  /** 对外的「提交中」：在飞的请求，加上答过、但恢复那一轮还没改写到的挂起调用（见接口注释）。 */
  const effectiveSubmittingCallIds = useMemo(() => {
    const stillWaiting = [...answeredWaitingCallIds].filter((callId) =>
      waitingCallIds.has(callId),
    );
    if (stillWaiting.length === 0) {
      return submittingCallIds;
    }
    const union = new Set(submittingCallIds);
    for (const callId of stillWaiting) {
      union.add(callId);
    }
    return union;
  }, [submittingCallIds, answeredWaitingCallIds, waitingCallIds]);

  /**
   * 答了一张挂起的卡片之后去接恢复那一轮（docs/ingress/tech/chat-webapp.md §6.2 ③）。
   *
   * 服务端要等恢复那一轮登记好才回 200，所以此刻重开的 tail 一定看得到它。其余照
   * `sendMessage` 起新一轮那条路走，只是没有乐观回显——人没说话，只是答了一张卡片。
   * 恢复那一轮也要走起轮装配（沙盒可能要唤醒），「正在准备…」占位是真的在等。
   */
  const followResumedTurn = useCallback(() => {
    turnInProgressRef.current = true;
    reconnectAttemptRef.current = 0;
    setStatus('streaming');
    setError(undefined);
    setAwaitingFirstEvent(true);
    openTail();
  }, [openTail]);

  const submitDecision = useCallback(
    (callId: string, request: () => Promise<void>) => {
      // 同一个 callId 同时只允许一个在飞。卡片自己也会禁用按钮，这里是第二道防线。
      if (effectiveSubmittingCallIds.has(callId)) {
        return;
      }
      // 在点下去这一刻判：答的是不是一张挂起的卡片。
      const resumes = waitingCallIds.has(callId);
      markSubmitting(callId);
      request()
        .then(
          () => {
            if (resumes) {
              setAnsweredWaitingCallIds((prev) => new Set(prev).add(callId));
              followResumedTurn();
            }
          },
          (requestError: unknown) => {
            if (
              requestError instanceof ChatApiError &&
              requestError.status === 404
            ) {
              setLocallyExpiredCallIds((prev) => new Set(prev).add(callId));
              // 挂起的卡片拿到 404，多半是已经答过、恢复没做成：服务端这时会顺手再推一把
              // （docs/ingress/tech/chat-webapp.md §6.2 ③）。重开一次直播流去看——真起了恢复，
              // 轮状态快照会说「有轮在跑」，否则回放完就关，不多做什么。
              if (resumes) {
                openTail();
              }
              return;
            }
            setError(describeError(requestError));
          },
        )
        .finally(() => {
          clearSubmitting(callId);
        });
    },
    [
      effectiveSubmittingCallIds,
      waitingCallIds,
      markSubmitting,
      clearSubmitting,
      followResumedTurn,
      openTail,
    ],
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
      submittingCallIds: effectiveSubmittingCallIds,
      waitingCallIds,
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
      effectiveSubmittingCallIds,
      waitingCallIds,
      locallyExpiredCallIds,
      submitApproval,
      submitAnswer,
    ],
  );
}
