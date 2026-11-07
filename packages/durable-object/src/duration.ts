/**
 * 配置里的时长换算，与 `@runko/agent` 同一套写法（那边的换算函数不对外导出）：
 * 数字是毫秒，字符串带单位（`"300ms"` / `"30s"` / `"5m"` / `"1h"`）。写错了当场抛。
 */
import type { Duration } from "@runko/agent";

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

/** `name` 只用于报错文案，指出是哪个配置项写错了。 */
export function durationToMs(value: Duration, name: string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative number of milliseconds, got ${String(value)}.`);
    }
    return value;
  }
  const match = DURATION_PATTERN.exec(value);
  const unit = match?.[2] === undefined ? undefined : UNIT_MS[match[2]];
  if (match?.[1] === undefined || unit === undefined) {
    throw new RangeError(`${name} must look like "300ms", "30s", "5m" or "1h", got "${value}".`);
  }
  return Number(match[1]) * unit;
}
