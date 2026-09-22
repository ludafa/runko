/**
 * [直播流](../../../../../docs/terms.md)走哪条通道——**由用户在设置页选**，SSE 或 WebSocket。
 *
 * 两条通道并排留着是有意的（见 docs/ingress/features/ws-stream.md）：内容一模一样，差别在
 * 连接的形态。谁更合适要在真环境里对照着看，所以开关交给用户，不写死在构建里。
 *
 * **存在这台设备上**（`localStorage`），不跟着账号走：它是「这个浏览器怎么连服务端」的选择，
 * 换台机器重新选即可。存不进去（隐私模式、禁用站点数据）也不影响使用——回落到 SSE。
 *
 * 改了立刻生效：正在看的页面会重连一次，不用刷新（`subscribe` 就是为这件事留的）。
 */
import { useSyncExternalStore } from 'react';

export type ChatTransport = 'sse' | 'ws';

const STORAGE_KEY = 'runko:chat-transport';

/** 缺省 SSE：它是浏览器内建的那条路，断线重连由浏览器管，出问题的面更小。 */
const DEFAULT_TRANSPORT: ChatTransport = 'sse';

const listeners = new Set<() => void>();

function isTransport(value: string | null): value is ChatTransport {
  return value === 'sse' || value === 'ws';
}

export function getChatTransport(): ChatTransport {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isTransport(stored) ? stored : DEFAULT_TRANSPORT;
  } catch {
    // 隐私模式、站点数据被禁：读不到就用缺省，不该因此白屏。
    return DEFAULT_TRANSPORT;
  }
}

export function setChatTransport(transport: ChatTransport): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, transport);
  } catch {
    // 存不住就只在本次会话里生效——比抛错好。
  }
  for (const listener of [...listeners]) {
    listener();
  }
}

/** 订阅变化。`useSyncExternalStore` 要的就是这个形状。 */
export function subscribeChatTransport(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 读当前选择，并在它变化时重渲染。
 *
 * 用 `useSyncExternalStore` 而不是 `useState` + effect：这个值存在 React 之外
 * （`localStorage`），同一个页面里可能有好几处在读（设置页、聊天页）——它们必须同时
 * 翻，否则设置页已经显示 WebSocket，聊天页还连着 SSE。
 */
export function useChatTransport(): ChatTransport {
  return useSyncExternalStore(
    subscribeChatTransport,
    getChatTransport,
    // 服务端渲染没有 `window`，直接给缺省值。这个应用今天不做 SSR，留着是为了
    // `useSyncExternalStore` 在测试里跑 hydration 路径时不炸。
    () => DEFAULT_TRANSPORT,
  );
}
