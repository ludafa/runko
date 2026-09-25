import './lib/zod-error-map';
import './lib/api';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import React from 'react';
import ReactDOM from 'react-dom/client';

import { installPushNavigationBridge } from './features/notifications/sw-bridge';
import { routeTree } from './routeTree.gen';

const router = createRouter({ routeTree });

/**
 * 目前只有[集群控制台](../../../docs/terms.md)一个页面在用 TanStack Query（轮询
 * `refetchInterval: 2000`，见 `features/console/use-console.ts`）——其余数据请求都是
 * 手写 `fetch`（`features/chat/api.ts`、`features/notifications/api.ts`）。这里只放
 * 一个最省事的默认 `QueryClient`，不需要跨页面共享的缓存策略。
 */
const queryClient = new QueryClient();

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

// 点通知回到对应会话（docs/ingress/tech/push-notification.md §3.2）：Service Worker
// focus 了这个窗口之后会 postMessage 过来，这里接住并跳转。
//
// 走 `router.history.push` 而不是 `router.navigate({ to })`：`to` 的类型是"所有
// 已知路由"的联合，而这里的 url 是运行时从消息里读到的字符串——用 history 这条口
// 既能触发路由匹配，又不必为了迁就类型写一次断言。
installPushNavigationBridge((url) => {
  router.history.push(url);
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
