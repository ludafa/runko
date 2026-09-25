/**
 * 下线倒计时与「心跳几秒前」都要一个不受本机时钟偏差影响的「现在」（技术方案 §9）。
 *
 * 做法：每次拿到服务端时刻就记一个偏移量（`serverNow - Date.now()`），倒计时本身
 * 每秒在本地走一格，两次刷新之间的动画就靠这个偏移量换算，不必等下一次轮询才动一下。
 *
 * `Date.now()` 与 ref 读写都放在 effect / 定时器回调里，不在渲染函数体里直接调用
 * ——渲染函数要求纯粹、可重复执行，`react-hooks/purity` 这条规则就是防这个。
 */
import { useEffect, useRef, useState } from 'react';

const TICK_INTERVAL_MS = 1_000;

export function useServerClock(serverNowMs: number | undefined): number {
  const offsetRef = useRef(0);
  // 首次渲染前还没跑过 effect，先拿 `serverNowMs` 本身兜底（它是入参，不是一次
  // 新的 `Date.now()` 调用），比留一个恒为 0 的初始值更接近事实。
  const [now, setNow] = useState(() => serverNowMs ?? 0);

  useEffect(() => {
    if (serverNowMs === undefined) {
      return;
    }
    offsetRef.current = serverNowMs - Date.now();
    setNow(Date.now() + offsetRef.current);
  }, [serverNowMs]);

  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now() + offsetRef.current);
    }, TICK_INTERVAL_MS);
    return () => {
      clearInterval(id);
    };
  }, []);

  return now;
}
