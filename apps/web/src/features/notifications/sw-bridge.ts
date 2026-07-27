/**
 * Service Worker → 页面的那一条消息通道（docs/tech/push-notification.md §3.2）。
 *
 * 用户点通知时，SW 优先 `focus()` 已开着的窗口再 `postMessage` 一条
 * `{type:'push-navigate', url}`，由这里接住、交给路由跳转。**不用 `openWindow`
 * 直接开新页**：整页重载会断开 SSE 连接、重建已渲染的时间线，而点通知恰恰常常
 * 发生在一轮进行中。
 */

const MESSAGE_TYPE = 'push-navigate';

/**
 * SW 的消息是 `unknown`（`MessageEvent.data` 本就没有类型保证），用结构守卫收窄
 * ——不写断言，也不信任对面一定发对了形状。
 */
function readNavigateUrl(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  if (!('type' in data) || data.type !== MESSAGE_TYPE) return undefined;
  if (!('url' in data)) return undefined;
  const { url } = data;
  if (typeof url !== 'string') return undefined;
  // 只接受站内相对路径（SW 那侧已经挡过一次，这里是第二道——两侧各自成立，
  // 不依赖对面做过检查）。
  return url.startsWith('/') && !url.startsWith('//') ? url : undefined;
}

/**
 * 装上通道。返回解绑函数（`main.tsx` 是应用生命周期，实际不会解，但不返回一个
 * 就没法在测试里收干净）。
 *
 * 浏览器不支持 Service Worker 时静默什么都不做——推送本身也用不了，不是错误。
 */
export function installPushNavigationBridge(
  navigate: (url: string) => void,
): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return () => {
      /* 不支持，无需解绑 */
    };
  }
  const onMessage = (event: MessageEvent): void => {
    const url = readNavigateUrl(event.data);
    if (url !== undefined) navigate(url);
  };
  navigator.serviceWorker.addEventListener('message', onMessage);
  return () => {
    navigator.serviceWorker.removeEventListener('message', onMessage);
  };
}
