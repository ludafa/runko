/**
 * chat agent API 的 wire 层 schema（docs/ingress/tech/chat-webapp.md §2.2、
 * docs/logic/orchestration/tech/single-ledger.md §5/§6「UIMessage 单账本」）。
 *
 * wire 上是一串 `ChatReplayFrame`，两支：`ChunkEnvelope`（`{ seq?, chunk }`，带
 * `seq` ⇔ 可持久、可回放）与 `MessageFrame`（`{ seq, message }`，只出现在回放里，
 * 是一条已完成的 `RunkoUIMessage` 原文）。完整理由见
 * `apps/node-server/src/schemas/chat.ts` 自己的文件头。
 *
 * 这里的帧形状是那份服务端 zod 的**手写镜像**，不是 kubb 生成的
 * `gen/zod/chatChunkEnvelopeSchema.ts`/`chatMessageFrameSchema.ts`。原因：
 * `apps/node-server` 给 `chunk`/`message` 发出的 OpenAPI schema 是 `{}`，kubb 只能
 * 从它推出裸 `z.any()`，也推不出 `seq`/`chunk` 的 `required` 列表，比真实 wire 形状
 * 松。需要比 kubb 的 OpenAPI 产物更精确时就手写一份，是本仓库既有的惯例。
 */
import type { RunkoChunk, RunkoUIMessage } from '@runko/core';
import { z } from 'zod';

// ---- JsonValue（packages/core/src/types.ts）——客户端这边用它把工具部件那个
// `unknown` 的 input/output 收窄（见 `timeline.ts` 的 `parseUnknownJsonValue`） ----

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

// ---- ChatReplayFrame（`apps/node-server` 的 `schemas/chat.ts`） ----

/**
 * 受控例外，理由与 `apps/node-server/src/schemas/chat.ts` 自己那份
 * `runkoChunkSchema`/`runkoUIMessageSchema` 相同。
 *
 * `RunkoChunk`/`RunkoUIMessage`（ai 的 `UIMessageChunk`/`UIMessage`，在
 * `@runko/core` 的 `state.ts` 里实例化）没有可复用的 zod schema，只能用 `z.any()`。
 * 逃逸被 `z.ZodType<T>` 标注圈住：导出 schema 的每个消费者看到的仍是精确的
 * TypeScript 类型，`any` 不会越过这一行声明。
 *
 * 这里只需要「结构上是不是这个信封形状」，不需要重做一遍深层校验：两者解析的值
 * 都已经过 `JSON.parse()`（SSE 的 `data:` 载荷，或 `GET .../messages` 的 JSON 响应
 * 体），而服务端在序列化之前就已经校验过真实的 `RunkoChunk`/`RunkoUIMessage` 形状。
 */
const runkoChunkSchema: z.ZodType<RunkoChunk> = z.any();

/** 同上，对应 `RunkoUIMessage`（`MessageFrame.message`）。 */
const runkoUIMessageSchema: z.ZodType<RunkoUIMessage> = z.any();

/**
 * `{ seq?, chunk }` —— 直播流自己的 wire 形状：带 `seq` ⇔ 可持久、可回放；没有
 * `seq` ⇔ 一次性（`text-delta`/`reasoning-delta`/任何 `transient: true` 的数据部件，
 * docs/logic/orchestration/tech/single-ledger.md §5 单-3）。
 *
 * 回放里 `kind = 'chunk'` 的行也复用这个形状，只是 `seq` 恒有（那是进行中或崩溃那
 * 一轮留下的可持久 chunk）。
 */
export const chunkEnvelopeSchema = z.object({
  seq: z.number().int().optional(),
  chunk: runkoChunkSchema,
});

export type ChunkEnvelope = z.infer<typeof chunkEnvelopeSchema>;

/**
 * `{ seq, message }` —— 只在回放里出现：一条已完成的 `RunkoUIMessage`，从
 * `kind = 'message'` 的行原样读回。它不会走直播流的广播路径（message 行只有在
 * 一轮已经结束之后才会写）。
 */
export const messageFrameSchema = z.object({
  seq: z.number().int(),
  message: runkoUIMessageSchema,
});

export type MessageFrame = z.infer<typeof messageFrameSchema>;

/**
 * 一条[排队](../../../../../docs/terms.md)中的待发消息（`apps/node-server` 的
 * `schemas/chat.ts` `QueuedMessageSchema` 的手写镜像，docs/logic/orchestration/tech/steer-and-queue.md §2.2）。
 */
export const queuedMessageSchema = z.object({
  id: z.string(),
  text: z.string(),
  userId: z.string(),
  createdAt: z.number(),
});

export type QueuedMessage = z.infer<typeof queuedMessageSchema>;

/**
 * `{ queue }` — 队列状态快照。两处共用：直播流的第三种帧（每条连接回放后必发一帧，
 * 队列变化时再广播；**没有 `seq`**，因为它是状态快照而非[账本](../../../../../docs/terms.md)
 * 事件，docs/logic/orchestration/tech/steer-and-queue.md §4.3），以及两个队列端点的响应体。
 */
export const queueFrameSchema = z.object({
  queue: z.array(queuedMessageSchema),
});

export type QueueFrame = z.infer<typeof queueFrameSchema>;

/**
 * `POST .../messages` 的响应（`apps/node-server` 的 `StartTurnAckSchema` 的手写镜像，
 * docs/logic/orchestration/tech/steer-and-queue.md §4.1）：`mode` 是服务端**实际**怎么处理了这条消息。
 *
 * 分流完全由服务端判定、客户端不预判，所以 `mode` 可能与请求的 `intent` 不一致——
 * 目前有一档会：请求 [插话](../../../../../docs/terms.md) 但那一轮还卡在
 * [起轮装配](../../../../../docs/terms.md)里时插不进去，服务端只能给它
 * [排队](../../../../../docs/terms.md)，回 `'queued'`（docs/logic/orchestration/tech/turn-abort.md §3.3）。
 */
export const startTurnAckSchema = z.object({
  ok: z.literal(true),
  mode: z.enum(['started', 'steered', 'queued']),
});

export type StartTurnMode = z.infer<typeof startTurnAckSchema>['mode'];

/**
 * `POST .../abort` 的响应（`apps/node-server` 的 `AbortTurnAckSchema` 的手写镜像，
 * docs/logic/orchestration/tech/turn-abort.md §3.2）：`ok` 只表示[停止](../../../../../docs/terms.md)**已
 * 请求**，「已停止」这个结果照旧走直播流上那条 `status: 'interrupted'` 的
 * `message-metadata`；`queue` 是清空后的队列快照（恒为空数组，停止即清空队列）。
 */
export const abortTurnAckSchema = z.object({
  ok: z.literal(true),
  queue: z.array(queuedMessageSchema),
});

/**
 * `{ turnActive }` — [轮状态快照](../../../../../docs/terms.md)（`apps/node-server` 的
 * `turnStateFrameSchema` 的手写镜像，docs/ingress/tech/chat-webapp.md §5.1）。每条
 * `GET .../stream` 在回放之后、进入直播之前必发一帧，内容是**服务端**此刻对
 * 「这个会话有没有[轮](../../../../../docs/terms.md)在跑」的权威答案。
 */
export const turnStateFrameSchema = z.object({ turnActive: z.boolean() });

export type TurnStateFrame = z.infer<typeof turnStateFrameSchema>;

/**
 * 这个应用能收到的 wire 帧只有四种：`ChunkEnvelope`、`MessageFrame`、`QueueFrame`、
 * `TurnStateFrame`。靠**结构**区分（对象实际带的是 `chunk`/`message`/`queue`/
 * `turnActive` 里的哪一个），没有共享的字面量判别字段——`apps/node-server` 自己的
 * `chatReplayFrameSchema` 用的是同一套纪律。
 *
 * 顺序无关紧要：zod v4 里 object schema 缺失的 `z.any()` 字段算校验失败，所以四支
 * 互不吞并（服务端同一份注释）。
 */
export const chatReplayFrameSchema = z.union([
  chunkEnvelopeSchema,
  messageFrameSchema,
  queueFrameSchema,
  turnStateFrameSchema,
]);

export type ChatReplayFrame =
  ChunkEnvelope | MessageFrame | QueueFrame | TurnStateFrame;

/** 会进[账本](../../../../../docs/terms.md)物化的两支——`QueueFrame` 与 `TurnStateFrame` 都是状态快照、不属于账本，由 `use-chat-messages.ts` 在喂给 `MessageLedger` 之前就分流掉。 */
export type LedgerFrame = ChunkEnvelope | MessageFrame;

/** 参数取最宽的 `ChatReplayFrame`（而不是 `LedgerFrame`）——同一个判别在两处都要用：`MessageLedger` 里对已分流的账本帧，和还没分流的原始 wire 帧上。传 `LedgerFrame` 时 false 分支照样收窄到 `ChunkEnvelope`。 */
export function isMessageFrame(frame: ChatReplayFrame): frame is MessageFrame {
  return 'message' in frame;
}

export function isQueueFrame(frame: ChatReplayFrame): frame is QueueFrame {
  return 'queue' in frame;
}

export function isTurnStateFrame(
  frame: ChatReplayFrame,
): frame is TurnStateFrame {
  return 'turnActive' in frame;
}

/**
 * 一个帧的 `seq`——`QueueFrame` 与 `TurnStateFrame` **恒无 seq**（都是状态快照，不是
 * [账本](../../../../../docs/terms.md)事件，所以不落盘、不参与 `after=` 续传；
 * docs/logic/orchestration/tech/steer-and-queue.md §4.3、docs/ingress/tech/chat-webapp.md §5.1），于是与 ephemeral
 * chunk 在去重/续传簿记上走同一条「没有 seq」的路径。
 */
export function frameSeq(frame: ChatReplayFrame): number | undefined {
  if (isQueueFrame(frame) || isTurnStateFrame(frame)) {
    return undefined;
  }
  return frame.seq;
}

/** `GET .../messages` 的响应形状——`{ frames: ChatReplayFrame[] }`，不是一个裸数组（docs/ingress/tech/chat-webapp.md §2.2「契约细化」）。 */
export const conversationMessagesListSchema = z.object({
  frames: z.array(chatReplayFrameSchema),
});

export type ChatMessagesList = z.infer<typeof conversationMessagesListSchema>;

/**
 * 把一条 SSE `data:` 载荷的 JSON 文本解析成 `ChatReplayFrame`。
 *
 * `JSON.parse` 的标准库返回类型是 `any`。这里把它直接喂给 `zod.safeParse()`、不落进
 * 任何具名的有类型变量，`any` 因此被圈在这一个表达式里，不会逃出本函数。
 */
export type ParsedFrameResult =
  { ok: true; frame: ChatReplayFrame } | { ok: false; error: string };

export function parseChatReplayFrame(raw: string): ParsedFrameResult {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      error: `invalid JSON in SSE data: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const result = chatReplayFrameSchema.safeParse(parsedJson);
  if (!result.success) {
    return { ok: false, error: result.error.message };
  }
  return { ok: true, frame: result.data };
}

// ---- Conversation（`apps/node-server` 的 `conversations` 行，wire 上走
// camelCase） ----

export const conversationStatusSchema = z.enum([
  'active',
  'sleeping',
  'expired',
]);

export type ConversationStatus = z.infer<typeof conversationStatusSchema>;

/** 沙盒 provider（docs/host/contract/tech/sandbox-provider.md）——这次会话跑在哪家云沙盒上，建会话时选定、1:1 绑定。 */
export const conversationProviderSchema = z.enum(['vercel', 'e2b']);

export type ConversationProvider = z.infer<typeof conversationProviderSchema>;

/**
 * [skill 清单](../../../../../docs/terms.md)的一条（docs/ingress/tech/composer-skill-mention.md §5.2）——
 * [composer](../../../../../docs/terms.md) 里打 `/` 时列的就是它：`name` 上屏做
 * [skill 提及](../../../../../docs/terms.md)的字面量，`description` 是菜单里那行灰字。
 */
export const skillSummarySchema = z.object({
  name: z.string(),
  description: z.string(),
});

export type SkillSummary = z.infer<typeof skillSummarySchema>;

export const conversationSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  repo: z.string(),
  branchName: z.string(),
  sandboxName: z.string(),
  provider: conversationProviderSchema,
  status: conversationStatusSchema,
  lastActiveAt: z.string(),
  /** 这个会话的[待发队列](../../../../../docs/terms.md)——页面加载时的初始快照，之后由 `QueueFrame` 与队列端点响应刷新（docs/logic/orchestration/tech/steer-and-queue.md §4.2）。 */
  queuedMessages: z.array(queuedMessageSchema),
  /**
   * 这个会话当前可选的 [skill 清单](../../../../../docs/terms.md)（docs/ingress/tech/composer-skill-mention.md §2.1）。
   *
   * `.default([])` 不是可有可无的宽容：服务端读的是库缓存列，会话建于本功能上线前、
   * 或那一列坏掉时都会给出空清单，前端这边应当照常渲染一个「没有 skill 可选」的
   * composer，而不是整页 parse 失败。
   */
  availableSkills: z.array(skillSummarySchema).default([]),
  /**
   * 这个会话此刻有没有[轮](../../../../../docs/terms.md)在跑——**服务端的权威答案**
   * （读的是[起轮标记](../../../../../docs/terms.md)那一列）。`useChatMessages` 拿它当
   * 挂载时的初值，撑到直播流那帧[轮状态快照](../../../../../docs/terms.md)到达为止。
   *
   * **必填，跟生成的契约一致**（`openapi.yml` 把它列进了 `required`，`gen/zod/` 也是
   * `z.boolean()`）。
   *
   * **别给它加 `.default(false)`。** 它是**每次请求现算**的（服务端读起轮标记那一
   * 列），不是存在会话行上的值，所以不存在「老会话没有这个字段」的兼容问题。加了
   * default 的实际后果反而是：将来字段改名时前端不报错，而是静默退回 `false`——正好
   * 就是这个字段要解决的那个 bug（有轮在跑却显示空闲）。
   */
  turnInProgress: z.boolean(),
  /**
   * 还有几张卡片在等人答（审批或提问）——内存窗口里等着的与已[挂起](../../../../../docs/terms.md)的
   * 都算。会话列表据此标出「在等你」（docs/ingress/tech/chat-webapp.md §6.3）。
   *
   * 必填、不加 default，理由同 `turnInProgress`：它是每次请求现算的，字段改名时该报错，
   * 而不是静默退回 0、让等着人答的会话在列表里看起来无事发生。
   */
  pendingDecisions: z.number().int(),
  createdAt: z.string(),
});

export type Conversation = z.infer<typeof conversationSchema>;

export const conversationListSchema = z.array(conversationSchema);

// ---- turn 遥测明细（docs/ingress/tech/chat-webapp.md §11.4，GET .../turns/{turn}/telemetry） ----

/** 一条遥测事件：`payloadJson` 是服务端收敛后的事件 JSON 原文（形状随 ai 小版本演化，前端按需解析、缺字段跳过，不在这里深度建模）。 */
export const turnTelemetryEventSchema = z.object({
  eventType: z.string(),
  ts: z.number(),
  payloadJson: z.string(),
});

export type TurnTelemetryEvent = z.infer<typeof turnTelemetryEventSchema>;

export const turnTelemetrySchema = z.object({
  events: z.array(turnTelemetryEventSchema),
});
