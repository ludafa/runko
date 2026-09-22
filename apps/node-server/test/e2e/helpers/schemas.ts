/**
 * chat 应用几个端点的响应形状——只声明测试实际要读的字段，用 zod 在运行时校验，
 * 换来精确类型而不必对 `res.json()` 的返回值做类型断言。
 *
 * `input`/`output` 复用 `@runko/core` 的 `jsonValueSchema`（工具调用的入参/结果本就是
 * 任意 JSON），不用 `any` 兜底、不用另起一份等价定义。
 */
import { jsonValueSchema } from '@runko/core';
import { z } from 'zod';

export const createdConversationSchema = z.object({ id: z.string() });

export const startTurnAckSchema = z.object({
  ok: z.literal(true),
  mode: z.enum(['started', 'steered', 'queued']),
});
export type StartTurnAck = z.infer<typeof startTurnAckSchema>;

export const activitySchema = z.object({
  active: z.boolean(),
  local: z.boolean(),
  holder: z.string().optional(),
});
export type Activity = z.infer<typeof activitySchema>;

/**
 * 一条消息里的一个「部件」。文字段只有 `type`；工具调用段还带 `toolCallId`/`state`/
 * `input`/`output`。两种形状合并声明成一个「宽松对象」而不是判别联合——测试只关心
 * 「能不能按 `toolCallId` 找到那次工具调用、读它的 `state`/`input`/`output`」，
 * 不需要为 AI SDK 那边随工具名变化的完整判别联合类型埋单。
 */
const messagePartSchema = z.object({
  type: z.string(),
  /** 文字段的正文。**不声明就会被 zod 剥掉**，按正文找消息的断言会永远落空。 */
  text: z.string().optional(),
  toolCallId: z.string().optional(),
  state: z.string().optional(),
  input: jsonValueSchema.optional(),
  output: jsonValueSchema.optional(),
});
export type MessagePart = z.infer<typeof messagePartSchema>;

const suspendedInfoSchema = z.object({
  callIds: z.array(z.string()),
  reason: z.string().optional(),
});

const messageMetadataSchema = z.object({
  status: z.string().optional(),
  suspended: suspendedInfoSchema.optional(),
});

const ledgerMessageSchema = z.object({
  id: z.string(),
  role: z.string(),
  parts: z.array(messagePartSchema),
  metadata: messageMetadataSchema.optional(),
});
export type LedgerMessage = z.infer<typeof ledgerMessageSchema>;

const ledgerFrameSchema = z.object({
  seq: z.number().int(),
  message: ledgerMessageSchema,
});
export type LedgerFrame = z.infer<typeof ledgerFrameSchema>;

/** `GET .../messages` 的响应——账本里现在只有成品消息，所以这里的每一帧都是 `{seq, message}`。 */
export const ledgerResponseSchema = z.object({
  frames: z.array(ledgerFrameSchema),
});

export const signUpResponseSchema = z.object({
  user: z.object({ id: z.string() }),
});
