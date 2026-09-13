/**
 * demo 的日志出口：**零依赖的单行文本 logger**，写 stdout。
 *
 * `@runko/agent` 刻意不写 console（库不替宿主决定日志去哪），缺省静音；宿主注入一个 `Logger` 才打得出来。
 * 这个 demo 注入的就是它，注入点有三处：runtime、租约版仲裁、HTTP 层（含转发）。
 *
 * **一行的形状是固定的**，而且以 ISO 时间开头——多副本验证环境要把几个副本的日志按时间合并成一条
 * 时间线（`scripts/lab-logs.ts`），靠的就是这一点：
 *
 * ```
 * 2026-09-13T06:30:57.530Z  replica-a   WARN   lease         took over a stale lease  conversationId=c1 staleForMs=5120
 * ```
 *
 * 为什么是文本不是 JSON：这份日志首先是给人读的（排障时 `tail -f`、在编辑器里翻）。字段仍是 `k=v`，
 * 要机器处理时按两个空格切列即可。
 */
import type { LogFields, Logger } from "@runko/agent";

export type LogLevel = "debug" | "info" | "warn" | "error";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** 认得出来的级别原样返回；`silent` 表示一行都不打；认不出来（含没配）返回 `undefined`，由调用方给缺省值。 */
export function parseLogLevel(raw: string | undefined): LogLevel | "silent" | undefined {
  const value = raw?.trim().toLowerCase();
  if (value === "debug" || value === "info" || value === "warn" || value === "error" || value === "silent") {
    return value;
  }
  return undefined;
}

export interface LogLine {
  at: Date;
  /** 谁打的：副本名，或者测试进程自己（`test`）。 */
  node: string;
  /** 级别列。副本用四个日志级别；测试的步骤行用 `STEP`。 */
  level: string;
  scope: string;
  message: string;
  fields?: LogFields | undefined;
}

/** 字段值里有空白、引号或等号时加引号，否则原样——一眼能读，也切得开。 */
function formatValue(value: string | number | boolean): string {
  const text = String(value);
  return /[\s"=]/.test(text) || text === "" ? JSON.stringify(text) : text;
}

export function formatLogLine(line: LogLine): string {
  const fields = Object.entries(line.fields ?? {})
    .flatMap(([key, value]) => (value === undefined ? [] : [`${key}=${formatValue(value)}`]))
    .join(" ");
  const columns = [
    line.at.toISOString(),
    line.node.padEnd(10),
    line.level.toUpperCase().padEnd(5),
    line.scope.padEnd(12),
    line.message,
  ];
  return fields === "" ? columns.join("  ") : `${columns.join("  ")}  ${fields}`;
}

export interface TextLoggerOptions {
  node: string;
  level: LogLevel | "silent";
  /** 一行写到哪。缺省 stdout；测试注入一个收集数组的函数。 */
  write?: (line: string) => void;
  now?: () => Date;
}

export function createTextLogger(opts: TextLoggerOptions): Logger {
  const write = opts.write ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const now = opts.now ?? ((): Date => new Date());
  const threshold = opts.level === "silent" ? Number.POSITIVE_INFINITY : RANK[opts.level];
  const at =
    (level: LogLevel) =>
    (scope: string, message: string, fields?: LogFields): void => {
      if (RANK[level] < threshold) {return;}
      write(formatLogLine({ at: now(), node: opts.node, level, scope, message, fields }));
    };
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

/** 一行都不打的 logger——没注入时用它，行为与框架缺省的 `noopLogger` 一致。 */
export const silentLogger: Logger = createTextLogger({ node: "", level: "silent", write: () => undefined });
