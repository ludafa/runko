/**
 * 轮询等待——两个真进程之间的状态收敛（归属易主、轮跑完、账本落盘）没有事件可订阅，
 * 只能反复问、等它变成想要的样子。
 */

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * 反复跑 `check`，直到它回 `true`，或者等到 `timeoutMs` 放弃。
 *
 * `check` 抛错按「还没到」处理，不让它直接冲出来炸掉测试——被查的那个状态在两个真进程之间
 * 收敛的路上，短暂的网络抖动或者「对面还没起来」都可能让单次探测失败，重试才是正常路径。
 */
export async function waitFor(
  check: () => Promise<boolean> | boolean,
  timeoutMs = 20_000,
  label = '条件成立',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await Promise.resolve(check()).catch(() => false);
    if (ok) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`等「${label}」超时了（${String(timeoutMs)}ms）`);
    }
    await sleep(50);
  }
}
