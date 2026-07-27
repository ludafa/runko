import './lib/zod-error-map';
import './lib/api';

import { createRouter, RouterProvider } from '@tanstack/react-router';
import React from 'react';
import ReactDOM from 'react-dom/client';

import { installPushNavigationBridge } from './features/notifications/sw-bridge';
import { routeTree } from './routeTree.gen';

const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

// 点通知回到对应会话（docs/tech/push-notification.md §3.2）：Service Worker
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
    <RouterProvider router={router} />
  </React.StrictMode>,
);
