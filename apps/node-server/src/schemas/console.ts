/**
 * [集群控制台](../../../../docs/terms.md) API 的 wire 形状（`routes/console.ts`）。
 * 设计见 docs/host/node/tech/cluster-console.md §8。
 */
import { z } from '@hono/zod-openapi';

import { OPS_NODE_STATES } from '../ops/schema.js';

/** 与[运维容器](../../../../docs/terms.md)的 `OpsNodeState` 共用同一份取值——两处各写一份
 * 字面量迟早会分叉，这里从它派生。 */
export const ConsoleNodeStateSchema = z.enum(OPS_NODE_STATES);

export const ConsoleNodeSchema = z
  .object({
    /** 容器 id；没配运维容器时就是 holder 地址（`docker inspect` 无从谈起）。 */
    id: z.string(),
    /** compose 的副本序号；没配运维容器时不知道，为 `null`。 */
    index: z.number().int().nullable(),
    /** 与租约表 `holder` 同形状的地址，前端据此把会话挂到节点下。 */
    url: z.string().nullable(),
    state: ConsoleNodeStateSchema,
    /** Docker 原始状态字；没配运维容器时不知道，为 `null`。 */
    dockerState: z.string().nullable(),
    /** 强杀时刻（毫秒时间戳），只有 `state === 'going_offline'` 时非空。 */
    offlineDeadline: z.number().nullable(),
  })
  .openapi('ConsoleNode');

export type ConsoleNode = z.infer<typeof ConsoleNodeSchema>;

export const ConsoleConversationSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    ownerEmail: z.string(),
    /** 持有者的可达地址，与 `ConsoleNode.url` 同形状，前端据此把这条会话挂到某个节点下。 */
    holder: z.string(),
    heartbeatAt: z.number(),
    /** 心跳已超过[归属仲裁](../../../../docs/terms.md)的接管阈值——挂在节点下，但标成「疑似失联」。 */
    stale: z.boolean(),
  })
  .openapi('ConsoleConversation');

export type ConsoleConversation = z.infer<typeof ConsoleConversationSchema>;

export const ConsoleOverviewSchema = z
  .object({
    /** 没配运维容器（单进程跑法）时为 false：前端把下线/上线按钮置灰并说明原因。 */
    controllable: z.boolean(),
    nodes: z.array(ConsoleNodeSchema),
    /** 没在任何节点上跑的会话不出现在这里——空闲的会话不占节点（功能手册 §3.2）。 */
    conversations: z.array(ConsoleConversationSchema),
    /** 服务端时刻（毫秒），前端据此算「心跳几秒前」与下线倒计时，不受本机时钟偏差影响。 */
    now: z.number(),
    /** 只在「配了运维容器但打不通/响应不对」时出现——前端据此显示一条提示条。 */
    opsError: z.string().optional(),
  })
  .openapi('ConsoleOverview');

export type ConsoleOverviewDto = z.infer<typeof ConsoleOverviewSchema>;

export const ConsoleNodeParamsSchema = z.object({
  id: z.string().openapi({
    param: { name: 'id', in: 'path' },
    examples: ['a1b2c3d4e5f6'],
  }),
});

export const ConsoleOfflineAckSchema = z
  .object({
    ok: z.literal(true),
    /** 这次下线的强杀时刻，与 {@link ConsoleNodeSchema.offlineDeadline} 同一个值。 */
    offlineDeadline: z.number(),
  })
  .openapi('ConsoleOfflineAck');

export type ConsoleOfflineAck = z.infer<typeof ConsoleOfflineAckSchema>;

export const ConsoleOnlineAckSchema = z
  .object({ ok: z.literal(true) })
  .openapi('ConsoleOnlineAck');

export type ConsoleOnlineAck = z.infer<typeof ConsoleOnlineAckSchema>;
