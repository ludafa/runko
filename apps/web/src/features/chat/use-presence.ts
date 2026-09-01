/**
 * [在场](../../../../docs/terms.md)上报（docs/tech/push-notification.md §5.2）。
 *
 * 判据三条，缺一不可：**页面可见**（没被切到后台标签页）、**窗口聚焦**（不是在
 * 另一个应用里）、**路由停在这条会话**（这个 hook 挂在会话页上，所以第三条天然
 * 成立）。三条都满足才算"人在看"，服务端此时不推送本会话的通知。
 *
 * 「第二个显示器上开着但没聚焦」被判为**不在看**是有意的：漏一条审批比多弹一条
 * 通知糟糕得多，所以判据往"多弹"的方向偏。
 *
 * 一切失败都吞掉——心跳是尽力而为的，报不上去最坏是多收一条通知。
 */
import { useEffect } from 'react';

import { postPresence } from './api';

/** 心跳周期。服务端 TTL 是 45 秒（两倍多一点），容得下一次丢包。 */
const HEARTBEAT_MS = 20_000;

function isFocused(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

export function usePresence(conversationId: string): void {
  useEffect(() => {
    const controller = new AbortController();
    /** 上一次报出去的值——只在变化时补报，别把每次 focus/blur 都变成一发请求。 */
    let lastReported: boolean | undefined = undefined;

    function report(focused: boolean, keepalive = false): void {
      lastReported = focused;
      void postPresence(conversationId, focused, {
        ...(keepalive ? { keepalive: true } : { signal: controller.signal }),
      }).catch(() => {
        // 尽力而为：报不上去就算了，下一次心跳自然重试。也刻意不回滚
        // `lastReported`——否则一次网络抖动会让后续每个 focus 事件都重发一遍。
      });
    }

    function reportIfChanged(): void {
      const focused = isFocused();
      if (focused !== lastReported) {
        report(focused);
      }
    }

    // 进来先报一次当前状态（通常是 true）。
    report(isFocused());

    // 在场期间持续续期。不在场时不发——服务端那条记录会自己过期，没必要每 20 秒
    // 告诉它一遍"我还是没在看"。
    const timer = window.setInterval(() => {
      if (isFocused()) {
        report(true);
      }
    }, HEARTBEAT_MS);

    document.addEventListener('visibilitychange', reportIfChanged);
    window.addEventListener('focus', reportIfChanged);
    window.addEventListener('blur', reportIfChanged);

    /**
     * 关标签页/刷新时那一次必须发出去，所以走 `keepalive`（普通 fetch 会随页面
     * 一起被取消）。不用 `sendBeacon`：它没法带 `credentials: 'include'`，跨源
     * 部署下就没有登录态了。
     */
    function onPageHide(): void {
      report(false, true);
    }
    window.addEventListener('pagehide', onPageHide);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', reportIfChanged);
      window.removeEventListener('focus', reportIfChanged);
      window.removeEventListener('blur', reportIfChanged);
      window.removeEventListener('pagehide', onPageHide);
      // 离开这条会话（切到别的会话、退到列表页）：立刻销掉在场，否则接下来 45
      // 秒内这条会话的通知会被误抑制。用 keepalive 是因为上面的 controller 马上
      // 就要 abort 了，这一发不能跟着被取消。
      report(false, true);
      controller.abort();
    };
  }, [conversationId]);
}
