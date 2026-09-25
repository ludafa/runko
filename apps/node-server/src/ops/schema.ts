/**
 * [运维容器](../../../../docs/terms.md)三个接口的响应形状（docs/host/node/tech/cluster-console.md §7.1）。
 *
 * 不用 `@hono/zod-openapi`：运维容器只在集群内网里被节点调用，不对外暴露、
 * 不需要一份公开的 OpenAPI 文档。这里的 schema 单独放一个文件，是因为
 * 节点侧的运维客户端（`console/ops-client.ts`）要 `import` 它来校验从运维容器拿回的响应——
 * 这是「类型边界」的另一头：网络那头返回的 JSON 同样先经 zod 收窄，不做断言。
 */
import { z } from 'zod';

export const OPS_NODE_STATES = [
  'online',
  'going_offline',
  'offline',
  'unknown',
] as const;

export type OpsNodeState = (typeof OPS_NODE_STATES)[number];

export const OpsNodeSchema = z.object({
  /** 完整容器 id。 */
  id: z.string(),
  /** 前 12 位，等于容器的缺省主机名，也是租约 `holder` 里出现的那一截（§2.1）。 */
  shortId: z.string(),
  /** compose 的副本序号；标签缺失或非数字时为 `null`。 */
  index: z.number().int().nullable(),
  /** `http://<shortId>:<nodePort>`，与 `holder` 同形状，前端据此把会话挂到节点下。 */
  url: z.string(),
  state: z.enum(OPS_NODE_STATES),
  /** Docker 原始状态字，`state` 是 `'unknown'` 时靠它显示具体是什么状态。 */
  dockerState: z.string(),
  /** 强杀时刻（毫秒时间戳），只有 `state === 'going_offline'` 时非空。 */
  offlineDeadline: z.number().nullable(),
});

export type OpsNode = z.infer<typeof OpsNodeSchema>;

export const OpsNodesResponseSchema = z.array(OpsNodeSchema);

export type OpsNodesResponse = z.infer<typeof OpsNodesResponseSchema>;

export const OpsOfflineResponseSchema = z.object({
  ok: z.literal(true),
  /** 这次下线的强杀时刻，与 {@link OpsNodeSchema.offlineDeadline} 同一个值。 */
  offlineDeadline: z.number(),
});

export type OpsOfflineResponse = z.infer<typeof OpsOfflineResponseSchema>;

export const OpsOnlineResponseSchema = z.object({ ok: z.literal(true) });

export type OpsOnlineResponse = z.infer<typeof OpsOnlineResponseSchema>;

export const OpsErrorSchema = z.object({ error: z.string() });

export type OpsError = z.infer<typeof OpsErrorSchema>;
