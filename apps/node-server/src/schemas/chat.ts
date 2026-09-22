import { z } from '@hono/zod-openapi';
import type { RunkoChunk, RunkoUIMessage } from '@runko/core';

// ---------------------------------------------------------------------------
// chat 应用的 wire 词汇表：[直播流](../../../../docs/terms.md)与回放端点上传什么形状。
//
// 一共四种帧，**靠「带了哪个字段」区分**，没有统一的 type 字段：
//
// | 帧 | 形状 | 出现在哪 |
// |---|---|---|
// | `ChunkEnvelope`  | `{ seq?, chunk }`  | 直播流的主体 |
// | `MessageFrame`   | `{ seq, message }` | 回放的全部；直播里每轮只有一帧（起轮那条用户消息） |
// | `QueueFrame`     | `{ queue }`        | 待发队列快照 |
// | `TurnStateFrame` | `{ turnActive }`   | 这个会话有没有轮在跑 |
//
// **回放不需要重放 chunk**：`RunkoUIMessage` 本身就是聊天界面消息列表要的形状，客户端
// 把 `MessageFrame` 直接拼进去即可。只有进行中那一轮要把它的 `ChunkEnvelope` 喂给增量
// 构建器（ai 的 `readUIMessageStream`），叠在历史之上。
//
// 方案与取舍见 [chat 应用 · 技术方案](../../../../docs/ingress/tech/chat-webapp.md) 与
// [单一数据账本 · 技术方案](../../../../docs/logic/orchestration/tech/single-ledger.md)。
// ---------------------------------------------------------------------------

/**
 * ⚠️ **刻意的类型逃逸，范围仅限这两行。**
 *
 * `RunkoChunk` / `RunkoUIMessage` 是 ai SDK 的 `UIMessageChunk` / `UIMessage` 在
 * `@runko/core` 里的实例化，**没有可复用的 zod schema**：ai 导出的 `uiMessageChunkSchema`
 * 是个 `LazySchema`（`zod-to-openapi` 走不了），而且它是泛型原型、不是 runko 的实例化。
 *
 * `z.any()` 是 `zod-to-openapi` 唯一认的「无约束」，文档里如实呈现成「任意 ai SDK
 * chunk / message」。外面那层 `z.ZodType<T>` 把 `any` 关在这一行里——**调用方拿到的仍是
 * 精确类型**。
 *
 * 这两处解析的值都已经过 `JSON.parse`（从[账本](../../../../docs/terms.md)读回，或
 * `session.stream()` 本来就带类型的输出），不是未经校验的外部输入。
 */
const runkoChunkSchema: z.ZodType<RunkoChunk> = z.any();

/** 同上，`RunkoUIMessage` 版。 */
const runkoUIMessageSchema: z.ZodType<RunkoUIMessage> = z.any();

/**
 * `{ seq?, chunk }`——**`seq` 在不在，就是这条 chunk 落没落库**：在 = 可回放（判据是
 * `@runko/agent` 的 `isDurableChunk`）；不在 = 一过性的（`text-delta`、`reasoning-delta`、
 * `transient: true` 的 data part）。
 *
 * 回放一条 `kind = 'chunk'` 行时复用同一个形状，那时 `seq` 必定在。
 */
export const chunkEnvelopeSchema = z
  .object({
    seq: z.number().int().optional(),
    chunk: runkoChunkSchema,
  })
  .openapi('ChatChunkEnvelope');

export type ChunkEnvelope = z.infer<typeof chunkEnvelopeSchema>;

/**
 * `{ seq, message }`——一条成品 `RunkoUIMessage`，从 `kind = 'message'` 行原样读回。
 *
 * 基本只出现在回放里：这种行通常等一轮跑完才写，那时已经没有直播内容了。**唯一的例外是
 * 起轮那条用户消息**——它落库的同一瞬间就广播出去，作为这一轮的第一帧，好让客户端不必猜
 * 自己刚发的消息最终长什么样。
 */
export const messageFrameSchema = z
  .object({
    seq: z.number().int(),
    message: runkoUIMessageSchema,
  })
  .openapi('ChatMessageFrame');

export type MessageFrame = z.infer<typeof messageFrameSchema>;

/**
 * 一条[排队](../../../../docs/terms.md)中的待发消息——[待发队列](../../../../docs/terms.md)
 * 里的一条，也是 wire 上 `QueueFrame` 与队列端点响应的元素。
 *
 * `userId` 不是冗余镜像 conversation owner：[出队](../../../../docs/terms.md)起轮时
 * [会话级授权](../../../../docs/terms.md)按「本轮发起者」匹配（`conversation-grants.ts`），
 * 必须知道这条消息是谁排的。
 *
 * 见[插话与排队 · 技术方案](../../../../docs/logic/orchestration/tech/steer-and-queue.md)。
 */
export const QueuedMessageSchema = z
  .object({
    id: z.string(),
    text: z.string().min(1),
    userId: z.string(),
    createdAt: z.number().int(),
  })
  .openapi('QueuedMessage');

export type QueuedMessage = z.infer<typeof QueuedMessageSchema>;

/**
 * `{ queue }`——队列状态快照。两处共用一个形状：
 *
 * - **wire 帧**：[直播流](../../../../docs/terms.md)的第三种帧。刻意**没有 `seq`**——它不是
 *   [账本](../../../../docs/terms.md)事件，而是[transient](../../../../docs/terms.md)档的状态
 *   快照（「此刻队列长这样」，重发一次即最新，没有回放价值），因此不落库、不占 seq、
 *   不参与 `after=` 续传。
 * - **队列端点响应**：`DELETE .../queue/{messageId}` 与 `DELETE .../queue` 都返回变更后的
 *   完整快照，调用方一次往返拿到权威状态。
 */
export const queueFrameSchema = z
  .object({ queue: z.array(QueuedMessageSchema) })
  .openapi('ChatQueueFrame');

export type QueueFrame = z.infer<typeof queueFrameSchema>;

/**
 * `{ turnActive }`——[轮状态快照](../../../../docs/terms.md)。与队列快照同构（**没有 `seq`**、
 * 不落库、不参与 `after=` 续传），每条 `GET .../stream` 在回放之后、进入直播之前必发一帧。
 *
 * **它替掉的是「前端自己猜」**：服务端手上有权威答案（`isTurnActive`），下发就是了。因为
 * **每条**连接都发一帧，前端与服务端对轮状态的任何分叉都会被下一次重连纠正——不只是打开
 * 会话那一刻。
 */
export const turnStateFrameSchema = z
  .object({ turnActive: z.boolean() })
  .openapi('ChatTurnStateFrame');

export type TurnStateFrame = z.infer<typeof turnStateFrameSchema>;

/**
 * 四种帧的并集。**没有共同的判别字段**，靠「带了 `chunk` / `message` / `queue` /
 * `turnActive` 里的哪一个」区分——四个键不会同时出现在一帧上，结构上就够分。
 *
 * 一个容易担心的点：`chunkEnvelopeSchema` 的 `chunk: z.any()` 会不会把别的帧吞进来？
 * **不会**——zod v4 把「对象缺这个键」判为失败，哪怕那个键的类型是 `z.any()`。
 */
export const chatReplayFrameSchema = z.union([
  chunkEnvelopeSchema,
  messageFrameSchema,
  queueFrameSchema,
  turnStateFrameSchema,
]);

export type ChatReplayFrame =
  ChunkEnvelope | MessageFrame | QueueFrame | TurnStateFrame;

/**
 * `GET .../messages` 的响应（**不是裸数组**）：这个会话的全部行，按 seq 排序。
 *
 * **账本里现在只有成品消息。** [进行中草稿](../../../../docs/terms.md)搬进内存之后不再写
 * `kind = 'chunk'` 行，所以回放就是一串 `MessageFrame`。`ChunkEnvelope` 这一支只为**存量
 * chunk 行**保留，读时被 `agent/persistence.ts` 滤掉。进行中那一轮的草稿走
 * [直播流](../../../../docs/terms.md)重连补发，不经这个端点。
 */
export const ConversationMessagesListSchema = z
  .object({ frames: z.array(chatReplayFrameSchema) })
  .openapi('ConversationMessagesList');

export type ConversationMessagesListDto = z.infer<
  typeof ConversationMessagesListSchema
>;

// ---------------------------------------------------------------------------
// routes/chat.ts 的请求 / 响应形状
// ---------------------------------------------------------------------------

/**
 * [skill 清单](../../../../docs/terms.md)的一条——`name` 是目录名，同时也是 `load-skill`
 * 的入参与 [skill 提及](../../../../docs/terms.md)的字面量；`description` 是 SKILL.md
 * frontmatter 里那句话，菜单里那行灰字。
 */
export const SkillSummarySchema = z
  .object({
    name: z.string(),
    description: z.string(),
  })
  .openapi('SkillSummary');

export type SkillSummaryDto = z.infer<typeof SkillSummarySchema>;

export const ConversationSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    /** 仓库与工作分支——[本地沙盒](../../../../docs/terms.md)这一档没有，为 null。 */
    repo: z.string().nullable(),
    branchName: z.string().nullable(),
    sandboxName: z.string(),
    /** 沙盒 provider——前端据此渲染 provider 徽标。 */
    provider: z.enum(['vercel', 'e2b', 'local']),
    status: z.enum(['active', 'sleeping', 'expired']),
    lastActiveAt: z.string(),
    /** 这个会话的[待发队列](../../../../docs/terms.md)——页面加载时的初始快照，之后由 `QueueFrame` 或队列端点响应刷新。列表端点也带（侧边栏可显示「N 条待发」）。 */
    queuedMessages: z.array(QueuedMessageSchema),
    /**
     * 这个会话当前可选的 [skill 清单](../../../../docs/terms.md)——[composer](../../../../docs/terms.md)
     * 里打 `/` 时列的就是它。
     *
     * 读的是库缓存（`conversations.available_skills_json`），**不碰沙盒**：休眠中的会话照样
     * 能列菜单，不会为此把沙盒唤醒。代价是最多滞后一轮。
     */
    availableSkills: z.array(SkillSummarySchema),
    /**
     * 这个会话此刻有没有[轮](../../../../docs/terms.md)在跑——**服务端的权威答案**：先看本
     * 进程的登记册，再看库里的归属，所以别的副本正在跑也算。
     *
     * 有了它，页面刚打开的那几十毫秒里前端就不用猜。猜错的后果是把一个正在跑的会话当成
     * 空闲，用户这时发的消息会去起新轮，而不是[排队](../../../../docs/terms.md)。
     */
    turnInProgress: z.boolean(),
    /**
     * 还有几张卡片在等人答（审批或 `ask-user` 提问）。内存窗口里等着的与已
     * [挂起](../../../../docs/terms.md)的都算——会话列表据此标出「在等你」。每次请求现算
     * （裁决表里 `decided_at` 为空的行），一次分组查询，列表不做 N+1。
     */
    pendingDecisions: z.number().int().nonnegative(),
    createdAt: z.string(),
  })
  .openapi('Conversation');

export type ConversationDto = z.infer<typeof ConversationSchema>;

export const CreateConversationInputSchema = z
  .object({
    title: z.string().min(1).max(255).optional(),
    /** 这次会话用哪家沙盒；省略时落服务端默认 `SANDBOX_PROVIDER`（未配则 `vercel`）。 */
    provider: z.enum(['vercel', 'e2b', 'local']).optional(),
  })
  .openapi('CreateConversationInput');

export const PostChatMessageInputSchema = z
  .object({
    text: z.string().min(1),
    /**
     * 这条消息**在已有进行中的一轮时**该走哪条路：`'queue'`（默认）=
     * [排队](../../../../docs/terms.md)到下一轮，`'steer'` =
     * [中途插话](../../../../docs/terms.md)注入当前这一轮。
     *
     * **没有**进行中的一轮时两者无差别，都是起新一轮——分流规则完全由服务端判定，
     * 客户端不预判。
     */
    intent: z.enum(['queue', 'steer']).optional(),
  })
  .openapi('PostChatMessageInput');

/**
 * `POST .../messages` 的 202 响应。**它只说这次请求被怎么处理了，不带任何内容**——内容一律
 * 走 `GET .../stream`。
 *
 * `mode` 三档：
 *
 * - `'started'`：没有轮在跑，这次起了新的一轮；
 * - `'steered'`：有轮在跑，文本被[中途插话](../../../../docs/terms.md)注入了那一轮；
 * - `'queued'`：有轮在跑，文本进了[待发队列](../../../../docs/terms.md)，等这一轮结束再
 *   [出队](../../../../docs/terms.md)。
 */
export const StartTurnAckSchema = z
  .object({
    ok: z.literal(true),
    mode: z.enum(['started', 'steered', 'queued']),
  })
  .openapi('StartTurnAck');

export type StartTurnAck = z.infer<typeof StartTurnAckSchema>;

/**
 * `POST .../abort` 的 200 响应：`ok` 只表示[停止](../../../../docs/terms.md)**已请求**
 * ——真正停下的时刻由 agent 当时在做什么决定，而「已停止」这个结果和其它轮收尾一样，走
 * [直播流](../../../../docs/terms.md)上那条 `status: 'interrupted'` 的 `message-metadata`
 * chunk 送达，不在本响应里。
 *
 * `queue` 是清空后的[待发队列](../../../../docs/terms.md)快照（恒为空数组）——停止即清空
 * 队列，带上它让调用方一次往返就拿到权威状态，与 `DELETE .../queue` 返回快照同一姿态。
 */
export const AbortTurnAckSchema = z
  .object({ ok: z.literal(true), queue: z.array(QueuedMessageSchema) })
  .openapi('AbortTurnAck');

export type AbortTurnAck = z.infer<typeof AbortTurnAckSchema>;

export const ConversationParamsSchema = z.object({
  id: z
    .string()
    .openapi({ param: { name: 'id', in: 'path' }, examples: ['3f1b2c4d-...'] }),
});

/** 两个回放端点（`GET .../messages` 与 `GET .../stream`）共用的断线续传游标。 */
export const ConversationReplayQuerySchema = z.object({
  after: z.coerce
    .number()
    .int()
    .nonnegative()
    .optional()
    .openapi({ param: { name: 'after', in: 'query' } }),
});

/**
 * `POST .../approvals/{callId}` 的路径参数：`id` 是会话，`callId` 是待裁决的那次工具调用
 * 自己的 id（`@runko/core` 的 `ApprovalContext.callId`，挂在 `tool-approval-request` chunk
 * 上叫 `approvalId`）。
 *
 * `POST .../questions/{callId}` 原样复用它——形状相同、`callId` 也是同一个 id 空间
 * （`ToolContext.callId`），只是那边指的是 `ask-user` 这次调用。
 */
export const ChatApprovalParamsSchema = z.object({
  id: z
    .string()
    .openapi({ param: { name: 'id', in: 'path' }, examples: ['3f1b2c4d-...'] }),
  callId: z
    .string()
    .openapi({ param: { name: 'callId', in: 'path' }, examples: ['call_1'] }),
});

/**
 * `DELETE .../queue/{messageId}` 的路径参数：`id` 同 `ConversationParamsSchema`；`messageId`
 * 是[待发队列](../../../../docs/terms.md)条目自己的 `QueuedMessage.id`（入队时
 * `randomUUID()` 生成，与工具调用的 `callId` 是两个不相干的 id 空间）。
 */
export const ChatQueueParamsSchema = z.object({
  id: z
    .string()
    .openapi({ param: { name: 'id', in: 'path' }, examples: ['3f1b2c4d-...'] }),
  messageId: z.string().openapi({
    param: { name: 'messageId', in: 'path' },
    examples: ['9c2e1f70-...'],
  }),
});

/**
 * `POST .../approvals/{callId}` 的请求体：一个人对待裁决工具调用的决定。`message` 只在
 * `deny` 时有意义（拒绝理由，回填模型），`allow` / `allow-session` 下忽略。
 *
 * `allow-session` = [会话级授权](../../../../docs/terms.md)：放行本次**并且**记住这次具体
 * 调用（tool + 入参指纹），本会话内相同调用后续直接放行、不再弹卡片。对 `@runko/core`
 * 而言它和 `allow` 无异（都映射成 `HumanDecision.{behavior:'allow'}`）——「会话内记住」是
 * 纯 chat 层概念（`conversation-grants.ts`），core 不感知。
 */
export const PostApprovalInputSchema = z
  .object({
    behavior: z.enum(['allow', 'allow-session', 'deny']),
    message: z.string().optional(),
  })
  .openapi('PostApprovalInput');

/**
 * `POST .../approvals/{callId}` 的 200 响应——**纯 ack**。裁决结果本身走
 * [直播流](../../../../docs/terms.md)上的 `tool-approval-response` chunk 送达。
 *
 * `POST .../questions/{callId}` 的 200 复用它（那边的结果同样只体现为 `ask-user` 这个工具
 * 部件的 `output-available` 状态），没必要为同一个 `{ ok: true }` 再写一份。
 */
export const ApprovalAckSchema = z
  .object({ ok: z.literal(true) })
  .openapi('ApprovalAck');

export type ApprovalAck = z.infer<typeof ApprovalAckSchema>;

/**
 * `POST .../questions/{callId}` 的请求体：一个人对 `ask-user` 提问的自由文本回答。
 * **必填**——不像审批的 `deny` 理由可以省，这里没有「什么都不答」这种情况。
 */
export const PostAnswerInputSchema = z
  .object({
    answer: z.string().min(1),
  })
  .openapi('PostAnswerInput');

/**
 * `POST .../presence` 的请求体（[在场](../../../../docs/terms.md)心跳）：`focused` =
 * 「此刻这条会话正在这个人眼前」——页面可见**且**窗口聚焦**且**路由停在这条会话，
 * 三者缺一即为 false。
 *
 * 只有页面自己知道这三件事，所以必须由它上报：服务端能看到的「有没有活的 SSE 连接」在被
 * 切到后台的标签页上照样为真，而那恰恰是最需要通知的情形。
 */
/**
 * 这台服务端的能力快照（`GET /api/chat/config`）——前端据此决定新建会话弹窗里能选哪几档
 * 沙盒、要不要在会话页标「演示模型」。
 *
 * **不是配置项的镜像**：它只回答「现在能做什么」，不回答「配了哪些 key」，更不外泄 key 本身。
 */
export const ChatConfigSchema = z
  .object({
    /** 这台服务端配得起的[沙盒 provider](../../../../docs/terms.md)，至少有 `local`。 */
    providers: z.array(z.enum(['vercel', 'e2b', 'local'])),
    defaultProvider: z.enum(['vercel', 'e2b', 'local']),
    /** `demo` = 没配模型 key，用的是[演示模型](../../../../docs/terms.md)。 */
    model: z.enum(['deepseek', 'demo']),
  })
  .openapi('ChatConfig');

export type ChatConfigDto = z.infer<typeof ChatConfigSchema>;

/**
 * 登录页要知道的那点事（`GET /api/auth-config`，**不需要登录**）：只有「GitHub 登录开没开」。
 * 单开一个不鉴权的端点，是因为这个问题恰恰要在登录之前回答。
 */
export const AuthConfigSchema = z
  .object({ github: z.boolean() })
  .openapi('AuthConfig');

/**
 * 这条会话此刻有没有轮在跑、归哪个副本跑（`GET …/activity`）。
 *
 * 给运维与多副本验证环境用：转发对不对、接管有没有发生，看的就是 `holder` 这一列。
 * `local` = 就在你问的这个副本上。
 */
export const ActivitySchema = z
  .object({
    active: z.boolean(),
    local: z.boolean(),
    /** 持有者的可达地址；单进程跑法与没人持有时没有这个字段。 */
    holder: z.string().optional(),
  })
  .openapi('Activity');

export const PresenceInputSchema = z
  .object({ focused: z.boolean() })
  .openapi('PresenceInput');

/** `GET .../turns/{turn}/telemetry` 的路径参数：`id` 同 `ConversationParamsSchema`；`turn` 是账本 metadata 里的轮次号（1 起）。 */
export const TurnTelemetryParamsSchema = z.object({
  id: z
    .string()
    .openapi({ param: { name: 'id', in: 'path' }, examples: ['3f1b2c4d-...'] }),
  turn: z.coerce
    .number()
    .int()
    .min(1)
    .openapi({ param: { name: 'turn', in: 'path' }, examples: [1] }),
});

/**
 * 一条[遥测](../../../../docs/terms.md)事件：`payloadJson` 保持字符串原样透传（收敛后的
 * 事件 JSON，形状随 ai 小版本演化，服务端不做二次建模），前端自行 `JSON.parse` 按需取字段。
 */
export const TurnTelemetryEventSchema = z
  .object({
    eventType: z.string(),
    ts: z.number(),
    payloadJson: z.string(),
  })
  .openapi('TurnTelemetryEvent');

/** `GET .../turns/{turn}/telemetry` 的 200 响应——遥测缺席（未启用、该轮无数据、会话尚无 runko header）一律空数组，不是错误。 */
export const TurnTelemetrySchema = z
  .object({ events: z.array(TurnTelemetryEventSchema) })
  .openapi('TurnTelemetry');

export type TurnTelemetryDto = z.infer<typeof TurnTelemetrySchema>;
