/**
 * 跟浏览器推送栈打交道的**唯一**一处（docs/app/push-notification/tech.md §7）：
 * 权限、注册 Service Worker、订阅/退订、把订阅上报给服务端。
 *
 * 把它们收在一个文件里，是为了让 React 那一侧（`use-push-toggle.ts`）只面对
 * 「几个返回 Promise 的函数」，不必同时应付 `ServiceWorkerRegistration`、
 * `PushManager`、`Notification` 三套浏览器 API 的边界情况。
 */
import { postSubscription, postUnsubscribe } from './api';

const SERVICE_WORKER_URL = '/sw.js';

/**
 * 这台设备能不能收网页推送。
 *
 * **注意 iOS**：iPhone / iPad 的 Safari 里 `PushManager` 只在「已添加到主屏幕并
 * 从图标打开」时才存在。本项目不做 PWA 独立应用（2026-07-27 定），所以 iOS 上
 * 这里恒为 false，铃铛显示为「这台设备不支持」。
 */
export function isPushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** 粗略判断是不是 iOS（含把自己报成 Mac 的 iPadOS），只用于给一句更有用的提示文案。 */
export function looksLikeIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
}

export function currentPermission(): NotificationPermission {
  return Notification.permission;
}

export async function ensureServiceWorker(): Promise<ServiceWorkerRegistration> {
  // `register` 对同一个 URL 是幂等的（已注册就返回既有的），不必先查再注册。
  await navigator.serviceWorker.register(SERVICE_WORKER_URL);
  // 等它真正激活——刚 register 完 `pushManager.subscribe` 可能还用不了。
  return navigator.serviceWorker.ready;
}

function bufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * 返回类型写成 `Uint8Array<ArrayBuffer>` 而不是裸 `Uint8Array`：后者默认参数是
 * `ArrayBufferLike`（含 `SharedArrayBuffer`），不满足 `applicationServerKey` 要的
 * `BufferSource`。把类型在源头写准，就不必在调用点补一次断言。
 */
function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    '=',
  );
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * 把浏览器的 `PushSubscription` 拆成服务端要的三个字符串。
 *
 * 走 `getKey()` + 自己 base64url 编码，而不是 `subscription.toJSON()`：后者的类型
 * 是 `PushSubscriptionJSON`，`endpoint` 和 `keys` 全是可选的，用它就得在业务代码里
 * 补一串非空断言。`getKey()` 的返回类型是 `ArrayBuffer | null`，一个 if 就收窄干净。
 */
function describeSubscription(
  subscription: PushSubscription,
): { endpoint: string; p256dh: string; auth: string } | undefined {
  const p256dh = subscription.getKey('p256dh');
  const auth = subscription.getKey('auth');
  if (p256dh === null || auth === null) return undefined;
  return {
    endpoint: subscription.endpoint,
    p256dh: bufferToBase64Url(p256dh),
    auth: bufferToBase64Url(auth),
  };
}

/** 把一条订阅登记到服务端。返回 false = 这条订阅缺加密密钥（异常情况），调用方应把它当作"没订上"。 */
export async function syncSubscription(
  subscription: PushSubscription,
): Promise<boolean> {
  const described = describeSubscription(subscription);
  if (described === undefined) return false;
  await postSubscription({
    ...described,
    ...(typeof navigator === 'undefined' ?
      {}
    : { userAgent: navigator.userAgent.slice(0, 512) }),
  });
  return true;
}

export async function getExistingSubscription(
  registration: ServiceWorkerRegistration,
): Promise<PushSubscription | null> {
  return registration.pushManager.getSubscription();
}

/** 请求权限并订阅。调用前应确保 `isPushSupported()`。 */
export async function subscribe(
  registration: ServiceWorkerRegistration,
  vapidPublicKey: string,
): Promise<PushSubscription> {
  return registration.pushManager.subscribe({
    // 这是一句对浏览器的**承诺**：每收到一条推送都会弹一条可见通知。违背它
    // Chrome 会替我们弹「此站点在后台更新了内容」，Firefox 会记配额甚至吊销订阅
    // ——这正是「该不该打扰」的判断放在服务端而不是 SW 里的原因（技术方案 §5.2）。
    userVisibleOnly: true,
    applicationServerKey: base64UrlToBytes(vapidPublicKey),
  });
}

/** 退订：先从浏览器撤，再告诉服务端删行。任一步失败都不影响另一步。 */
export async function unsubscribe(
  subscription: PushSubscription,
): Promise<void> {
  const { endpoint } = subscription;
  try {
    await subscription.unsubscribe();
  } finally {
    await postUnsubscribe(endpoint);
  }
}
