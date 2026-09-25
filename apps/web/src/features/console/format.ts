/** 把毫秒差转成 `m:ss`——下线倒计时用（功能手册 §3.2，从 2:00 往下数）。 */
export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
}

/** 「心跳 N 秒前」。 */
export function formatSecondsAgo(pastMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - pastMs) / 1000));
  return `${String(seconds)} 秒前`;
}
