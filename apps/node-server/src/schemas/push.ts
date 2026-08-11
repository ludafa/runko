/**
 * 推送订阅接口的 wire 契约（docs/app/push-notification/tech.md §3.1）。
 *
 * 形状直接对齐浏览器 `PushSubscription.toJSON()` 的输出（`{endpoint, keys:{p256dh,
 * auth}}`）——前端拿到订阅后原样 POST 上来，中间不做任何搬运，少一层就少一处
 * 可能对不齐的地方。
 */
import { z } from '@hono/zod-openapi';

/** endpoint 是推送服务给的 URL，实测长度在几十到几百字节；给个宽松上限防滥用。 */
const endpointSchema = z
  .string()
  .min(1)
  .max(2048)
  .meta({
    description: '浏览器给出的推送投递 URL，本站点内唯一标识一台设备',
    examples: ['https://fcm.googleapis.com/fcm/send/abc123'],
  });

export const PushConfigSchema = z
  .object({
    enabled: z.boolean().meta({
      description: '服务端是否配了 VAPID 密钥。false 时前端不渲染铃铛',
    }),
    publicKey: z.string().nullable().meta({
      description:
        'VAPID 公钥，前端 `pushManager.subscribe` 要用；未启用时为 null',
    }),
  })
  .openapi('PushConfig');

export const PushSubscribeInputSchema = z
  .object({
    endpoint: endpointSchema,
    keys: z.object({
      p256dh: z.string().min(1).max(256),
      auth: z.string().min(1).max(256),
    }),
    userAgent: z.string().max(512).optional().meta({
      description: '只为让人认出「这是我哪台设备」，不参与任何判断',
    }),
  })
  .openapi('PushSubscribeInput');

export const PushUnsubscribeInputSchema = z
  .object({ endpoint: endpointSchema })
  .openapi('PushUnsubscribeInput');

export const PushAckSchema = z
  .object({ ok: z.literal(true) })
  .openapi('PushAck');

export type PushConfigDto = z.infer<typeof PushConfigSchema>;
export type PushSubscribeInput = z.infer<typeof PushSubscribeInputSchema>;
export type PushUnsubscribeInput = z.infer<typeof PushUnsubscribeInputSchema>;
