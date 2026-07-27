/**
 * 推送功能的**总闸**（docs/tech/push-notification.md §6.5）。
 *
 * [VAPID 密钥对](../../../../docs/terms.md)是服务端向推送服务（Chrome 走 FCM、
 * Firefox 走 autopush）自证身份的公私钥。三个环境变量缺任何一个 ⇒ 整个推送功能
 * 静默禁用：前端不渲染铃铛、订阅接口返 503、`notifier` 四个方法立即 return。
 *
 * **为什么是「静默」而不是报错**：自部署 nimbo chat 的人不该被一个没配好的可选
 * 功能拦住。启动时打一行说明就够了（`logPushStartup`），之后不再刷。
 *
 * 每次调用重新读 env（不缓存）——与本仓库既有的 `resolveIdleTimeoutMs`/
 * `resolveApprovalTimeoutMs` 同一姿态：读三个环境变量比维护一份缓存 + 一个测试用
 * 的重置入口便宜得多。
 */
import type { Logger } from '../logger.js';
import { resolveEnabledEvents } from './events.js';

const LOG_SCOPE = 'push';

export interface VapidConfig {
  /** URL-safe base64 公钥，原样交给浏览器的 `pushManager.subscribe`。 */
  publicKey: string;
  privateKey: string;
  /** `mailto:` 或 `https:` 开头——推送服务要求能联系上发送方。 */
  subject: string;
}

function readTrimmed(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw === undefined || raw.length === 0 ? undefined : raw;
}

/**
 * 三个变量齐了才返回配置，否则 `undefined`（**不抛**——调用方全是"没配就跳过"
 * 的姿态，抛错只会逼每个调用点包一层 try）。
 */
export function getVapidConfig(): VapidConfig | undefined {
  const publicKey = readTrimmed('VAPID_PUBLIC_KEY');
  const privateKey = readTrimmed('VAPID_PRIVATE_KEY');
  const subject = readTrimmed('VAPID_SUBJECT');
  if (
    publicKey === undefined ||
    privateKey === undefined ||
    subject === undefined
  ) {
    return undefined;
  }
  return { publicKey, privateKey, subject };
}

export function isPushEnabled(): boolean {
  return getVapidConfig() !== undefined;
}

/** 哪几个变量还缺——只给 `logPushStartup` 用，好让"没配"这行日志说得出缺什么。 */
function missingVapidVars(): string[] {
  return ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'].filter(
    (name) => readTrimmed(name) === undefined,
  );
}

/**
 * 启动时调用一次（`index.ts`）：把"推送开没开、开了哪几类"摊在日志里。
 *
 * 只在这里打日志，是为了让"没配置"这件事**恰好说一遍**——`isPushEnabled()` 在每
 * 一轮里会被调很多次，那些地方一行都不该打。
 */
export function logPushStartup(log: Logger): void {
  const missing = missingVapidVars();
  if (missing.length === 3) {
    log.info(LOG_SCOPE, '推送未配置，已禁用（缺 VAPID 密钥）');
    return;
  }
  if (missing.length > 0) {
    log.warn(LOG_SCOPE, '推送未启用：VAPID 配置不完整', {
      missing: missing.join(','),
    });
    return;
  }
  const enabled = resolveEnabledEvents(log);
  log.info(LOG_SCOPE, '推送已启用', {
    events: [...enabled].join(','),
  });
}
