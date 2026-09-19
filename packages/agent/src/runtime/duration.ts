/**
 * 配置里的时长：数字就是毫秒，字符串带单位（`"300ms"` / `"30s"` / `"5m"` / `"1h"`）。
 *
 * 模板字面量类型让写错单位在编译期就报；负数、`NaN`、`"1e3s"` 这类编译器拦不住的，
 * `durationToMs` 在运行期抛——配置错了应该起不来，而不是悄悄按默认跑。
 */
export type Duration = number | `${number}ms` | `${number}s` | `${number}m` | `${number}h`;

const UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;

/**
 * `setTimeout` 能等的上限（2³¹−1 毫秒，约 24.8 天）。超过它，Node 会把延时改成 1 毫秒——配了
 * 「基本不挂起」反而变成「立刻挂起」。所以超过就报错，而不是悄悄截断。
 */
export const MAX_DURATION_MS = 2_147_483_647;

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/;

function isUnit(value: string): value is keyof typeof UNIT_MS {
  return value in UNIT_MS;
}

/** 换算成毫秒。`name` 只用于报错文案，指出是哪个配置项写错了。 */
export function durationToMs(value: Duration, name: string): number {
  const ms = toMs(value, name);
  if (ms > MAX_DURATION_MS) {
    throw new RangeError(`${name} is too long: timers cannot wait more than ${String(MAX_DURATION_MS)} ms (about 24.8 days).`);
  }
  return ms;
}

function toMs(value: Duration, name: string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative number of milliseconds, got ${String(value)}.`);
    }
    return value;
  }
  const match = DURATION_PATTERN.exec(value);
  const amount = match?.[1];
  const unit = match?.[2];
  if (amount === undefined || unit === undefined || !isUnit(unit)) {
    throw new RangeError(`${name} must look like "300ms", "30s", "5m" or "1h", got "${value}".`);
  }
  return Number(amount) * UNIT_MS[unit];
}
