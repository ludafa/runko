/**
 * 推送订阅接口的客户端（docs/app/push-notification/tech.md §3.1）。
 *
 * 与 `features/chat/api.ts` 同一姿态：手写 `fetch` + zod 校验，不用 kubb 生成的
 * client——那份 client 从不检查 `response.ok`，而这里要分辨 503（服务端没配
 * VAPID）与其它失败。
 */
import { z } from 'zod';

const pushConfigSchema = z.object({
  enabled: z.boolean(),
  publicKey: z.string().nullable(),
});

export type PushConfig = z.infer<typeof pushConfigSchema>;

export class PushApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(
      message.length > 0 ? message : `推送接口失败（HTTP ${String(status)}）`,
    );
    this.name = 'PushApiError';
    this.status = status;
  }
}

async function requestJson(input: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(input, { credentials: 'include', ...init });
  if (!response.ok) {
    let text = '';
    try {
      text = await response.text();
    } catch {
      /* 读不出 body 就用状态码兜底 */
    }
    throw new PushApiError(response.status, text);
  }
  return response.json() as Promise<unknown>;
}

export async function fetchPushConfig(
  signal?: AbortSignal,
): Promise<PushConfig> {
  const json = await requestJson('/api/push/config', { method: 'GET', signal });
  return pushConfigSchema.parse(json);
}

export interface SubscribeInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
}

/** 幂等：页面每次加载都会重报一次，用来兜住浏览器悄悄换过 endpoint 的情况。 */
export async function postSubscription(
  input: SubscribeInput,
  signal?: AbortSignal,
): Promise<void> {
  await requestJson('/api/push/subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      endpoint: input.endpoint,
      keys: { p256dh: input.p256dh, auth: input.auth },
      ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
    }),
    signal,
  });
}

export async function postUnsubscribe(
  endpoint: string,
  signal?: AbortSignal,
): Promise<void> {
  await requestJson('/api/push/unsubscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint }),
    signal,
  });
}

/** 给自己的全部设备发一条测试通知——端到端验证推送通道是否打通。 */
export async function postPushTest(signal?: AbortSignal): Promise<void> {
  await requestJson('/api/push/test', { method: 'POST', signal });
}
