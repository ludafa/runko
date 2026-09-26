/**
 * 把 wire 上的 `ChatReplayFrame` 序列增量物化成一份可直接渲染的 `RunkoUIMessage[]`
 * ——服务端那本[账本](../../../../../docs/terms.md)在客户端的镜像。
 *
 * `MessageFrame` 已经是成品消息，原样 upsert，不用再处理。`ChunkEnvelope` 则要喂给 ai 官方的
 * 增量构建器 `readUIMessageStream()`。下面四件事是这个类真正在解决的问题。
 *
 * ## 一、`readUIMessageStream()` 要**一条消息一次调用**，不是一轮一次
 *
 * core 的 `loop.ts` 给**每一个** assistant step、以及每条插话注入的 user 消息，都开一对新的
 * `start` / `finish`。所以一轮的 chunk 流其实是好几段独立消息流**首尾相接**，不是一条连续的流。
 *
 * ⚠️ 而 `readUIMessageStream()` 是就地累积的：它只在 `start` 时改 `.id`，**从不重置
 * `.parts`**。把一整轮喂进**一次**调用，各 step 的部件会被静默合并成一条消息。
 *
 * 所以 `MessageLedger` 在每个 `start` 重开一对 `ReadableStream` + `readUIMessageStream()`，
 * 在配对的 `finish` 关掉。
 *
 * ## 二、插话注入的 **user** 消息不能走 `readUIMessageStream()`
 *
 * 它内部的状态**写死了 `role: "assistant"`**（ai 自己的 `createStreamingUIMessageState`：连
 * `message` 这个种子参数也只接受 role 已经是 assistant 的种子）。对模型流式产出的消息当然没
 * 问题，但插话那条 user 消息走它会被**贴错 role**。
 *
 * 分辨两者的唯一信号是 `start` chunk 上的 `messageMetadata.steered === true`。带这个标记的
 * 直接手工构建（`applySteerChunk`，只认 `text-*` / `file` 这几种——正好是 `drainSteerMessages`
 * 可能产出的全部，永远不会有工具调用、推理或 data 部件）。
 *
 * ## 三、轮尾的 `message-metadata` chunk 落地时**没有打开的消息**
 *
 * 它总是在最后一个 step 的 `finish` **之后**才来——与服务端落库的姿态一致：metadata 挂在
 * 前一条**已经建完**的消息上，不在某条消息自己的 chunk 序列里。
 *
 * `MessageLedger` 把它并到最近见过的那条 assistant 消息上；那种「一轮还没跑完任何 step 就失败」
 * 的少见情形下，造一条空的占位 assistant 消息来承接。`onTurnEnd` 也在这一刻触发，每轮恰好一次。
 *
 * ## 四、`MessageFrame` 里 role 是 user 时触发 `onUserMessage`
 *
 * 今天它只可能是起轮那条合成的用户消息（`@runko/agent` 的 `driveTurn` 广播的）。为什么用它、
 * 而不是插话那条 user 消息的 chunk 序列，来撤掉乐观回显，见 `UserMessageListener` 的注释。
 *
 * ## ⚠️ 「最近见过的 assistant 消息」**不等于**「最近物化出来的」
 *
 * `readUIMessageStream()` 的投递是**异步**的：`enqueue()` 进去的东西要到后续的微任务 / 宏任务
 * 才会到达 `consume()` 的 `for await`，**绝不会**在同一次 `applyChunk()` 里同步到达。实测连两个
 * 微任务都不够，得有一个真正的宏任务边界才冲得出来（测试里的 `flushLedger()` 就是干这个的）。
 *
 * 这会让两种调用方式分叉：**回放**是在一个紧凑的同步循环里把整轮帧灌进来，走到轮尾那条
 * metadata 时，异步管线可能还一条消息都没吐出来；**直播**则每帧之间隔着真实的 tick，管线早就
 * 跟上了。而这个类必须保证：**同一串帧，回放与直播必须物化出同一份 `RunkoUIMessage[]`**，
 * 与时序无关。
 *
 * 做法是两条，都只依赖 `applyChunk()` **同步就已经拿到**的信息：
 *
 * 1. **`lastAssistantId` 在看到非插话的 `start` 那一刻就更新**（`chunk.messageId`），不等它的
 *    消息对象从 `consume()` 里冒出来。消息的 **id 在 `start` 时就完全确定**了，异步流进来的
 *    只是内容——于是「哪条消息是最后一条」这件事不再有时序依赖。
 * 2. **独立的 metadata 从不写进已存的消息**，而是先放进 `pendingMetadata`（id → metadata），
 *    在 `snapshot()` 里**懒合并**到那一刻 `byId` 里的对象上。
 *
 *    第 2 条单靠第 1 条不够：认对了 id，那条消息也可能**还没**物化进 `byId`。更糟的是，就算
 *    当场并进去了，之后管线再 `upsert()` 一次（消息流得更全了）会**整个替换**存的对象，把并
 *    进去的 metadata 悄悄冲掉。懒合并则是构造上就与时序无关——目标消息物化没物化、之后还要
 *    被 `upsert()` 多少次，都不影响：每次取快照都拿**当前最新**的内容重新与 metadata 组合。
 */
import type {
  RunkoChunk,
  RunkoMessageMetadata,
  RunkoUIMessage,
} from '@runko/core';
import type { FileUIPart, TextUIPart } from 'ai';
import { isToolUIPart, readUIMessageStream } from 'ai';

import type { LedgerFrame } from './schema';
import { isMessageFrame } from './schema';

// ---- 插话注入的 user 消息：手工构建，不走 `readUIMessageStream()`（理由见文件头）。
// 下面认的这几种 chunk，正好是 `drainSteerMessages`（loop.ts）能为它产出的全部。 ----

interface SteerMessageBuilder {
  message: RunkoUIMessage;
  openText: Map<string, TextUIPart>;
}

function startSteerMessage(
  messageId: string,
  metadata: RunkoMessageMetadata | undefined,
): SteerMessageBuilder {
  const message: RunkoUIMessage = { id: messageId, role: 'user', parts: [] };
  if (metadata !== undefined) {
    message.metadata = metadata;
  }
  return { message, openText: new Map() };
}

function applySteerChunk(
  builder: SteerMessageBuilder,
  chunk: RunkoChunk,
): void {
  switch (chunk.type) {
    case 'text-start': {
      const part: TextUIPart = { type: 'text', text: '', state: 'streaming' };
      builder.openText.set(chunk.id, part);
      builder.message.parts.push(part);
      break;
    }
    case 'text-delta': {
      const part = builder.openText.get(chunk.id);
      if (part !== undefined) {
        part.text += chunk.delta;
      }
      break;
    }
    case 'text-end': {
      const part = builder.openText.get(chunk.id);
      if (part !== undefined) {
        part.state = 'done';
      }
      break;
    }
    case 'file': {
      const part: FileUIPart = {
        type: 'file',
        url: chunk.url,
        mediaType: chunk.mediaType,
      };
      builder.message.parts.push(part);
      break;
    }
    default:
      break; // `start` / `finish` 是边界，由调用方处理；插话消息不会有别的 chunk。
  }
}

// ---- 恢复那一轮开头的 chunk（`openResumedMessage` 的注释） ----

/**
 * 能认出「恢复改写的是哪次调用」的 chunk 只有这几种，而恢复那一轮总是以其中一种开头（`loop.ts` 的
 * `settleResumedCall`）。数据部件不带 `toolCallId`，只能跟在它们后面进同一条流。
 *
 * `approvalId` 在 runko 里恒等于 `toolCallId`（`loop.ts` 发审批 chunk 时就是这么填的）。
 */
function resumedToolCallId(chunk: RunkoChunk): string | undefined {
  switch (chunk.type) {
    case 'tool-approval-response':
      return chunk.approvalId;
    case 'tool-output-available':
    case 'tool-output-error':
    case 'tool-output-denied':
      return chunk.toolCallId;
    default:
      return undefined;
  }
}

export type MessageLedgerListener = (messages: RunkoUIMessage[]) => void;
export type TurnEndListener = (metadata: RunkoMessageMetadata) => void;
/**
 * 在一条 `role === 'user'` 的 `MessageFrame` 落地时触发。今天它**只可能**是起轮那条合成的
 * 用户消息（`@runko/agent` 的 `driveTurn` 把它作为本轮第一帧广播出来）。
 *
 * 插话注入的 user 消息**不会**走到这里：它是以 `ChunkEnvelope` 序列到达的（真正的
 * `start` / `text-*` / `finish`，经 `applySteerChunk` + `upsert` 物化）。它**之后**也会以
 * `MessageFrame` 形态出现一次——那一轮结束后它的 `kind = 'message'` 行被回放时——那时
 * `upsert` 按 id 去重，对 `byId` 是空操作，但这个监听器仍会为它触发一次。
 *
 * `use-chat-messages.ts` 靠它在真实消息落地的一瞬撤掉乐观回显。上面那次重复触发在那边也无害：
 * 对一个已经空了的回显队列再撤一次，什么也不会发生。
 */
export type UserMessageListener = () => void;

export class MessageLedger {
  private readonly order: string[] = [];
  /** `order` 的成员集（O(1) 判重）——`order` 会长到几百条，每次占位都线性扫一遍不划算。 */
  private readonly ordered = new Set<string>();
  private readonly byId = new Map<string, RunkoUIMessage>();
  /** 已经以 `MessageFrame`（带 seq 的成品消息）落地过的 id——`replaceDraft()` 据此分辨「真丢得起的草稿」与「绝不能丢的成品」，见该方法注释。 */
  private readonly landedMessageIds = new Set<string>();
  /**
   * 每条消息最近一次以 `MessageFrame` 落地时的 `pipeGeneration`。`consume()` 据此认出「成品已经到了、
   * 这条管道吐出来的却是它之前的草稿」：服务端先广播成品、再发收尾帧
   * （docs/logic/orchestration/tech/single-ledger.md §6.1），管道里还没投递完的旧 chunk 会晚于成品到达
   * `consume()`，照常 `upsert()` 就会把成品盖回草稿——交权时那就是被扔掉的半步又冒出来。
   */
  private readonly landedAtGeneration = new Map<string, number>();
  private openController:
    ReadableStreamDefaultController<RunkoChunk> | undefined;
  private steerBuilder: SteerMessageBuilder | undefined;
  /**
   * 每开一条 `readUIMessageStream()` 管道（`applyChunk` 的 `start` 分支、
   * `openResumedMessage`）就 +1、发给那条管道当代号。`replaceDraft()` 丢草稿时把
   * 当时打开着的那个代号记进 `discardedPipeGeneration`——即使 `closeOpenMessage()`
   * 已经调过 `controller.close()`，`ReadableStream` 在那之前已经 `enqueue()` 过的
   * chunk 仍会照常投递给 `consume()` 的 `for await`（这是 stream 的标准行为，
   * `close()` 只挡新 chunk，不清空已排队的）。没有这道代号闸门，那些迟到的 chunk
   * 会在 `replaceDraft()` 之后把同一条消息重新 `upsert()` 回时间线末尾——被丢弃的
   * 半截回答死灰复燃。
   */
  private pipeGeneration = 0;
  /** 当前打开着的管道代号——`undefined` = 没有打开的管道。与 `openController` 成对。 */
  private openPipeGeneration: number | undefined;
  /** `replaceDraft()` 丢弃时记下的管道代号；这个代号的 `consume()` 之后一律忽略。 */
  private discardedPipeGeneration: number | undefined;
  /** 看到非插话的 `start` 就**同步**记下，绝不从 `consume()`（异步）的 `upsert()` 反推。见文件头最后一节。 */
  private lastAssistantId: string | undefined;
  /** 等着并给 `lastAssistantId` 那条消息的独立 metadata——在 `snapshot()` 里懒合并，绝不直接写进 `byId`。见文件头最后一节。 */
  private readonly pendingMetadata = new Map<string, RunkoMessageMetadata>();
  private placeholderCount = 0;
  private readonly onChange: MessageLedgerListener;
  private readonly onTurnEnd: TurnEndListener | undefined;
  private readonly onUserMessage: UserMessageListener | undefined;

  constructor(
    onChange: MessageLedgerListener,
    onTurnEnd?: TurnEndListener,
    onUserMessage?: UserMessageListener,
  ) {
    this.onChange = onChange;
    this.onTurnEnd = onTurnEnd;
    this.onUserMessage = onUserMessage;
  }

  /** 按 wire 顺序喂一帧进来。回放帧与直播帧一视同仁——它们都只是 `ChatReplayFrame`。 */
  applyFrame(frame: LedgerFrame): void {
    if (isMessageFrame(frame)) {
      this.landedMessageIds.add(frame.message.id);
      this.landedAtGeneration.set(frame.message.id, this.pipeGeneration);
      this.upsert(frame.message);
      if (frame.message.role === 'user') {
        this.onUserMessage?.();
      }
      return;
    }
    this.applyChunk(frame.chunk);
  }

  /**
   * [交权](../../../../../docs/terms.md)（docs/logic/orchestration/tech/handover.md §6.1、§8）时的「整体替换草稿」：
   * 丢掉所有**只由 chunk 物化出来、还没有以 `MessageFrame`（带 seq 的成品消息）落地过**
   * 的消息，顺带关掉打开着的那条流、清空 steer 构建器与 `lastAssistantId`（它们要么指向
   * 刚被丢掉的消息，要么本就该在这种「另起炉灶」的时刻清零）。
   *
   * 目的：模型输出段被交权时，旧节点流出来的半段字（连同那条只有 `step-start`、metadata
   * 为 `handed-over` 的占位消息）要被接手节点重新生成的内容替换，不能与新内容并存。
   * **已经以 `MessageFrame` 落地过的成品消息绝不会被这个方法丢掉**——不管它来自初始回放
   * 还是更早一次重连的回放。
   *
   * 调用方（`use-chat-messages.ts`）只在确认这一轮是「模型输出段被交权」（`handedOver`
   * 悬空调用为空）时才调用它：工具段被交权时账本末尾那次悬空调用是真实状态、要留给
   * 接手节点结清，不能被当成草稿丢掉。
   *
   * **顺带关闭当前管道的后续投递**：`closeOpenMessage()` 只是让 `ReadableStream`
   * 不再接受新 chunk，管道里已经 `enqueue()` 过的那些还是会异步投给 `consume()`。
   * 这里先把当时打开着的管道代号记进 `discardedPipeGeneration`，`consume()` 收到
   * 属于这个代号的消息一律忽略——否则那些迟到的 chunk 会在这个方法返回之后，把刚
   * 丢弃的草稿重新 `upsert()` 回时间线末尾。见 `pipeGeneration` 字段注释。
   */
  replaceDraft(): void {
    if (this.openPipeGeneration !== undefined) {
      this.discardedPipeGeneration = this.openPipeGeneration;
    }
    this.closeOpenMessage();
    this.steerBuilder = undefined;
    this.lastAssistantId = undefined;
    let changed = false;
    for (let index = this.order.length - 1; index >= 0; index -= 1) {
      const id = this.order[index];
      if (id === undefined || this.landedMessageIds.has(id)) {
        continue;
      }
      this.order.splice(index, 1);
      this.ordered.delete(id);
      this.byId.delete(id);
      this.pendingMetadata.delete(id);
      changed = true;
    }
    if (changed) {
      this.notifyChange();
    }
  }

  private applyChunk(chunk: RunkoChunk): void {
    if (chunk.type === 'start') {
      this.closeOpenMessage(); // 防御：上一条流没关就关掉，不泄漏（loop.ts 的边界总是成对的，正常走不到）。
      if (
        chunk.messageMetadata?.steered === true &&
        chunk.messageId !== undefined
      ) {
        // 与下面那条同理：在 `start` 这一刻（同步）就把位子占下，内容等 `finish` 才 upsert。
        this.ensureOrder(chunk.messageId);
        this.steerBuilder = startSteerMessage(
          chunk.messageId,
          chunk.messageMetadata,
        );
      } else {
        // 在这里**同步**记下，不等 `consume()` 那边（异步的）`upsert()`——这样轮尾那条
        // 独立的 `message-metadata` 永远知道该并给谁，哪怕这条消息的内容还没物化出来。
        // 理由见文件头最后一节。
        if (chunk.messageId !== undefined) {
          this.lastAssistantId = chunk.messageId;
          // 顺序在这里就定死（`ensureOrder` 的注释说明了为什么不能等异步物化）：
          // `start` chunk 已经带着 messageId，而它是**同步**到达的。
          this.ensureOrder(chunk.messageId);
        }
        this.pipeGeneration += 1;
        const generation = this.pipeGeneration;
        this.openPipeGeneration = generation;
        const stream = new ReadableStream<RunkoChunk>({
          start: (controller) => {
            this.openController = controller;
          },
        });
        void this.consume(
          readUIMessageStream<RunkoUIMessage>({ stream }),
          generation,
        );
      }
    }

    if (this.steerBuilder !== undefined) {
      applySteerChunk(this.steerBuilder, chunk);
      if (chunk.type === 'finish') {
        this.upsert(this.steerBuilder.message);
        this.steerBuilder = undefined;
      }
      return;
    }

    if (this.openController === undefined) {
      // 此刻没有打开的消息。core 的 loop 在 start/finish 窗口之外只会产出两种 chunk：
      // 轮尾的 metadata（文件头第三节），以及恢复那一轮开头的那几个（`openResumedMessage` 的注释）。
      if (chunk.type === 'message-metadata') {
        this.applyStandaloneMetadata(chunk.messageMetadata);
        return;
      }
      if (!this.openResumedMessage(chunk)) {
        return;
      }
    } else if (chunk.type === 'message-metadata') {
      // `message-metadata` 只有一个出处（core 的 `finalizeTurn`），恒是收尾信号——不管此刻
      // 打开的是恢复那一轮的种子流（`openResumedMessage`，没有自己的 `finish`），还是
      // [交权](../../../../../docs/terms.md)在模型输出中途掐断的那一步的流（core 的
      // `runOneStep` 这种情形下直接抛出，不再 yield `finish-step`/`finish`，同样没有自己
      // 的 `finish`）：两种都没等到 `finish` 就直接来了收尾 metadata，一律关流、并到这条
      // 消息上、触发一次 `onTurnEnd`。
      this.closeOpenMessage();
      this.applyStandaloneMetadata(chunk.messageMetadata);
      return;
    }

    // 可选链不是多余的：上面那一支刚开的种子流是在回调里赋给 `openController` 的，编译器看不见。
    this.openController?.enqueue(chunk);
    if (chunk.type === 'finish') {
      this.closeOpenMessage();
    }
  }

  private closeOpenMessage(): void {
    this.openController?.close();
    this.openController = undefined;
    this.openPipeGeneration = undefined;
  }

  /**
   * [恢复](../../../../../docs/terms.md)那一轮开头的 chunk **前面没有 `start`**：它的第一步不调模型，
   * 而是原地改写上一轮最后那条消息（结清那次悬空调用），先发 `tool-approval-response` / `tool-output-*`
   * 和计时数据部件。所以这里按 `toolCallId` 找到那条已经物化的消息，拿它的副本当种子开一条流；
   * 下一个 `start` 或收尾 `message-metadata` 到来时关掉。设计见 docs/ingress/tech/chat-webapp.md §6.2 ④。
   *
   * 找不到就返回 `false`，这个 chunk 照旧丢掉——整轮结束时成品消息会补上。
   *
   * **必须传副本**：ai 会就地修改种子消息，直接传 `byId` 里那个对象等于绕过 React 改状态。
   */
  private openResumedMessage(chunk: RunkoChunk): boolean {
    const toolCallId = resumedToolCallId(chunk);
    if (toolCallId === undefined) {
      return false;
    }
    const target = this.findMessageWithToolCall(toolCallId);
    if (target === undefined) {
      return false;
    }
    // 收尾 metadata 要并给这条消息：恢复那一轮如果只结清了一个、还有别的在等，
    // core 会把新的 `suspended` 写回它。
    this.lastAssistantId = target.id;
    this.pipeGeneration += 1;
    const generation = this.pipeGeneration;
    this.openPipeGeneration = generation;
    const stream = new ReadableStream<RunkoChunk>({
      start: (controller) => {
        this.openController = controller;
      },
    });
    void this.consume(
      readUIMessageStream<RunkoUIMessage>({
        message: structuredClone(target),
        stream,
      }),
      generation,
    );
    return true;
  }

  /** 从后往前找：恢复改写的恒是上一轮的最后一条 assistant 消息，一般一步就找到。 */
  private findMessageWithToolCall(
    toolCallId: string,
  ): RunkoUIMessage | undefined {
    for (let index = this.order.length - 1; index >= 0; index -= 1) {
      const id = this.order[index];
      const message = id === undefined ? undefined : this.byId.get(id);
      if (
        message?.role === 'assistant' &&
        message.parts.some(
          (part) => isToolUIPart(part) && part.toolCallId === toolCallId,
        )
      ) {
        return message;
      }
    }
    return undefined;
  }

  private async consume(
    iterable: AsyncIterable<RunkoUIMessage>,
    generation: number,
  ): Promise<void> {
    for await (const message of iterable) {
      if (generation === this.discardedPipeGeneration) {
        // 这条消息来自一条已被 `replaceDraft()` 丢弃的旧管道——`close()` 之前就
        // 排队好的 chunk，见 `pipeGeneration` 字段注释。忽略，不重新 upsert。
        continue;
      }
      // 这条管道开起来之后，同一条消息的成品已经落地了：成品为准，草稿不再覆盖它。
      // 管道开在成品之后（恢复那一轮拿成品当种子接着写）的不受影响。
      const landedAt = this.landedAtGeneration.get(message.id);
      if (landedAt !== undefined && landedAt >= generation) {
        continue;
      }
      this.upsert(message);
    }
  }

  private applyStandaloneMetadata(metadata: RunkoMessageMetadata): void {
    if (this.lastAssistantId === undefined) {
      // 这个会话里还没有任何 assistant 消息开过头（一轮在第一个 step 之前就失败了）——
      // 没有东西可并，造一条占位消息承接，与服务端 `loop.ts` 的
      // `appendPlaceholderAssistantMessage` 同一姿态。
      this.placeholderCount += 1;
      this.upsert({
        id: `turn-signal-${String(this.placeholderCount)}`,
        role: 'assistant',
        parts: [],
        metadata,
      });
    } else {
      // 先排队，**不直接写进 `byId`**：目标消息可能还没物化，也可能之后还会被 `upsert()`
      // 整个替换掉、把急着并进去的那份冲没。改由 `snapshot()` 每次读取时，拿当前最新的
      // 内容与它重新组合。理由见文件头最后一节第 2 条。
      const prior = this.pendingMetadata.get(this.lastAssistantId);
      this.pendingMetadata.set(
        this.lastAssistantId,
        prior === undefined ? metadata : { ...prior, ...metadata },
      );
      this.notifyChange();
    }
    this.onTurnEnd?.(metadata);
  }

  /**
   * 在渲染顺序里给 `id` 占一个位子（幂等）。**顺序按 wire 上的到达先后定，与内容什么
   * 时候物化出来无关**——这是本类顺序正确性的唯一依据。
   *
   * 为什么必须单独占位、不能等 `upsert`：两种帧的物化时机差着一个微任务。
   * `MessageFrame` 走 `upsert` **同步**落位；`ChunkEnvelope` 要经
   * `readUIMessageStream()` **异步**产出消息才 upsert。所以一段「先是崩溃轮的 chunk
   * 行、后是新轮的 message 行」的历史回放下来，同步那批会先把 `order` 占满，异步物化
   * 的旧轮消息只能排到**末尾**——界面上就是旧轮跑到新轮下面去了（用户实测）。
   *
   * 崩溃的轮以前总是账本里的最后一轮（崩溃即终止），所以这个洞一直没机会暴露；现在
   * 崩溃轮之后还能继续对话（docs/logic/orchestration/tech/graceful-shutdown.md），它就浮出来了。
   */
  private ensureOrder(id: string): void {
    if (this.ordered.has(id)) {
      return;
    }
    this.ordered.add(id);
    this.order.push(id);
  }

  private upsert(message: RunkoUIMessage): void {
    this.ensureOrder(message.id);
    this.byId.set(message.id, message);
    this.notifyChange();
  }

  private notifyChange(): void {
    this.onChange(this.snapshot());
  }

  private snapshot(): RunkoUIMessage[] {
    return this.order.flatMap((id) => {
      const message = this.byId.get(id);
      // 占了位、内容还没物化出来（`ensureOrder` 在 `start` chunk 就占位，而
      // `readUIMessageStream` 要一个微任务之后才吐出第一版消息）——这一格暂时跳过，
      // 等物化完成的那次 `notifyChange` 它自然出现在**这个位置**上，而不是末尾。
      // 刻意不塞一条空 assistant 消息占坑：那会在界面上闪一个空气泡。
      if (message === undefined) {
        return [];
      }
      const pending = this.pendingMetadata.get(id);
      if (pending === undefined) {
        return [message];
      }
      const mergedMetadata: RunkoMessageMetadata =
        message.metadata === undefined ?
          pending
        : { ...message.metadata, ...pending };
      return [{ ...message, metadata: mergedMetadata }];
    });
  }
}
