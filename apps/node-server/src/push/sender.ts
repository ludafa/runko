/**
 * 投递层（docs/tech/push-notification.md §6）：给定一个 userId 和一条载荷，投给
 * 这个人的**所有**设备；失效的订阅就地回收。
 *
 * 这一层不做任何「该不该发」的判断——那是 `notifier.ts` 三道闸门的事。它只负责
 * 「已经决定要发了，怎么发出去、发不出去怎么办」。
 *
 * **永不 reject**：`sendToUser` 内部 `Promise.allSettled` + 全程 try/catch。一条
 * 通知发不出去，绝不能让一轮跑不下去（docs/tech/push-notification.md §9 不变量 1）。
 */
import type { Urgency } from 'web-push';
import webpush from 'web-push';

import type { Db } from '../agent/store.js';
import type { Logger } from '../logger.js';
import { logger as defaultLogger } from '../logger.js';
import {
  deleteSubscription,
  listSubscriptions,
  markError,
  markSent,
} from './store.js';
import type { PushKind, PushPayload } from './types.js';
import { getVapidConfig } from './vapid.js';

const LOG_SCOPE = 'push';

/** 「一轮结束」两类共用一个[合并标签](../../../../docs/terms.md)组：它们对同一条会话互斥且时序相继，最新那条才是当前事实。 */
const TAG_GROUP: Record<PushKind, string> = {
  approval: 'approval',
  question: 'question',
  'turn-done': 'turn',
  'turn-failed': 'turn',
};

/**
 * 推送服务 `Topic` 头的前缀。**必须显式映射**，不能取 kind 首字母——`turn-done`
 * 与 `turn-failed` 首字母相同，靠首字母会撞车（这里它们本就共用一组，但依赖
 * "恰好撞对"是不能维护的）。
 */
const TOPIC_PREFIX: Record<PushKind, string> = {
  approval: 'a',
  question: 'q',
  'turn-done': 't',
  'turn-failed': 't',
};

/** 「一轮结束」类通知的存活时长：十分钟后才送达的「跑完了」已经没有意义。 */
const TURN_TTL_SECONDS = 600;

export function tagFor(kind: PushKind, conversationId: string): string {
  return `${TAG_GROUP[kind]}:${conversationId}`;
}

/**
 * 推送服务用它合并**尚未投递**的旧消息（与 `tag` 合并已显示的通知是两层同样
 * 意图的机制）。格式限制很死：≤32 字符、URL-safe base64 字符集——装不下一个 36
 * 字符的 uuid，所以取去掉连字符后的前 24 位（uuid 是 hex，天然在字符集内）。
 */
export function topicFor(kind: PushKind, conversationId: string): string {
  const compact = conversationId.replace(/-/g, '').slice(0, 24);
  return `${TOPIC_PREFIX[kind]}${compact}`;
}

function urgencyFor(kind: PushKind): Urgency {
  // 要人做决定的两类是「现在就得知道」；一轮结束是「知道就行」，别为它唤醒
  // 一台正在省电的手机。
  return kind === 'approval' || kind === 'question' ? 'high' : 'normal';
}

export interface SendOptions {
  /**
   * 覆盖存活时长。审批/提问由调用方（`notifier.ts`）按**当前审批超时的剩余秒数**
   * 传入：送不到用户手上就已经自动拒绝了的通知，不如别送
   * （docs/tech/push-notification.md §6.3）。
   */
  ttlSeconds?: number;
  logger?: Logger;
  /** 真正打网络的那一下。默认走 `web-push`；测试注入假的，不必 mock 整个模块。 */
  transport?: PushTransport;
}

export interface TransportSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface TransportOptions {
  TTL: number;
  urgency: Urgency;
  topic: string;
}

export type PushTransport = (
  subscription: TransportSubscription,
  payload: string,
  options: TransportOptions,
) => Promise<void>;

/**
 * 从任意抛出物里取 HTTP 状态码。
 *
 * 用结构守卫而不是 `instanceof webpush.WebPushError`：注入的假 transport 抛的是
 * 普通对象，真 `WebPushError` 也满足这个形状——一个判断覆盖两种来源，且不需要
 * 任何类型断言。
 */
function statusCodeOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  if (!('statusCode' in error)) return undefined;
  const { statusCode } = error;
  return typeof statusCode === 'number' ? statusCode : undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createDefaultTransport(): PushTransport | undefined {
  const vapid = getVapidConfig();
  if (vapid === undefined) return undefined;
  return async (subscription, payload, options) => {
    await webpush.sendNotification(subscription, payload, {
      ...options,
      contentEncoding: 'aes128gcm',
      vapidDetails: {
        subject: vapid.subject,
        publicKey: vapid.publicKey,
        privateKey: vapid.privateKey,
      },
    });
  };
}

/**
 * 投给这个人的每一台设备。**不 reject、不抛**。
 *
 * 失败处置分两档（docs/tech/push-notification.md §6.5）：
 *
 * - **404 / 410** —— 这个订阅已作废（撤了权限 / 浏览器换了 endpoint / 清了站点
 *   数据）→ **删行**。这是唯一会删行的路径。
 * - **其余（429 / 5xx / 网络错误）** —— 推送服务自己的问题 → 记 `last_error`，
 *   留行，不重试。一次网络抖动不该让用户默默失去通知。
 *
 * 没有重试队列是有意的：通知是转瞬即逝的提醒，补发一条十分钟前的「要审批」没有
 * 价值，而它已经被 TTL 挡在推送服务那一侧了。
 */
export async function sendToUser(
  db: Db,
  userId: string,
  payload: PushPayload,
  opts: SendOptions = {},
): Promise<void> {
  const log = opts.logger ?? defaultLogger;
  const transport = opts.transport ?? createDefaultTransport();
  if (transport === undefined) return; // 总闸关着（没配 VAPID）

  let subscriptions;
  try {
    subscriptions = listSubscriptions(db, userId);
  } catch (error) {
    log.error(LOG_SCOPE, '读订阅失败，本次不投递', {
      userId,
      error: describe(error),
    });
    return;
  }
  if (subscriptions.length === 0) return;

  const body = JSON.stringify(payload);
  const options: TransportOptions = {
    TTL: opts.ttlSeconds ?? TURN_TTL_SECONDS,
    urgency: urgencyFor(payload.kind),
    topic: topicFor(payload.kind, payload.conversationId),
  };

  await Promise.allSettled(
    subscriptions.map(async (row) => {
      try {
        await transport(
          {
            endpoint: row.endpoint,
            keys: { p256dh: row.p256dh, auth: row.auth },
          },
          body,
          options,
        );
        markSent(db, row.endpoint);
      } catch (error) {
        const statusCode = statusCodeOf(error);
        if (statusCode === 404 || statusCode === 410) {
          deleteSubscription(db, row.endpoint);
          log.info(LOG_SCOPE, '订阅已失效，已回收', {
            userId,
            statusCode,
          });
          return;
        }
        const message = describe(error);
        markError(db, row.endpoint, message);
        log.warn(LOG_SCOPE, '投递失败，保留订阅', {
          userId,
          kind: payload.kind,
          ...(statusCode !== undefined ? { statusCode } : {}),
          error: message,
        });
      }
    }),
  );
}
