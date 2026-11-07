/**
 * 零依赖分级日志：分级、单行结构化、可注入 sink，几个纯函数就够，不引第三方日志库。
 *
 * 两个服务端共用：Node 版写 `process.stdout`；Workers 里没有它，退到 `console.log`
 * （Workers 的日志面板收的就是 console 输出）。
 *
 * 用法：`agent/`、`routes/` 等调用方经 `createLogger()` 拿一个 `Logger`，或直接
 * 用默认单例 `logger`（未显式注入时的兜底——现有调用方不传 logger 也能跑）。
 * 测试要断言具体输出时，用 `createLogger({ sink })` 注入一个收集数组的假
 * sink，不用碰 `process.stdout`。
 */

import { processEnv } from './env.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * 结构化字段的值类型——覆盖日志实际会塞的形状（原语 + 简单容器），
 * 精确到调用方无需断言：`undefined` 是允许的（可选字段"没算出来"就不必特意
 * 拆出两种调用签名，`JSON.stringify` 本就会丢弃 `undefined` 的键）。
 */
export type LogFieldValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly LogFieldValue[]
  | { readonly [key: string]: LogFieldValue };

export type LogFields = Record<string, LogFieldValue>;

/** 一行日志的最终落点——默认写 `process.stdout`，测试注入收集数组。 */
export type LogSink = (line: string) => void;

export interface Logger {
  debug(scope: string, message: string, fields?: LogFields): void;
  info(scope: string, message: string, fields?: LogFields): void;
  warn(scope: string, message: string, fields?: LogFields): void;
  error(scope: string, message: string, fields?: LogFields): void;
}

export interface CreateLoggerOptions {
  /** 缺省时读 `LOG_LEVEL` 环境变量（大小写不敏感），非法/缺失值兜底 `'info'`。 */
  level?: LogLevel;
  /** 缺省写 `process.stdout`——注入自定义 sink 是测试收集输出的唯一正规途径。 */
  sink?: LogSink;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function isLogLevel(value: string): value is LogLevel {
  return (
    value === 'debug' ||
    value === 'info' ||
    value === 'warn' ||
    value === 'error'
  );
}

function resolveLevelFromEnv(): LogLevel {
  const raw = processEnv().LOG_LEVEL?.trim().toLowerCase();
  if (raw !== undefined && isLogLevel(raw)) {
    return raw;
  }
  return 'info';
}

/** Workers 的 `navigator.userAgent` 固定是这个值；那里的 `process.stdout` 即使有也不进日志面板。 */
const WORKERS_USER_AGENT = 'Cloudflare-Workers';

function defaultSink(line: string): void {
  const inWorkers =
    typeof navigator !== 'undefined' &&
    navigator.userAgent === WORKERS_USER_AGENT;
  if (
    !inWorkers &&
    typeof process !== 'undefined' &&
    typeof process.stdout?.write === 'function'
  ) {
    process.stdout.write(`${line}\n`);
    return;
  }
  console.log(line);
}

/**
 * 长字符串截断助手——预览用（工具输入/输出、用户消息摘要等），不是安全
 * 截断（不处理多字节/代理对边界，日志预览没有这个精度要求）。超出部分只
 * 报个数，不整体丢弃，方便定位"到底截了多少"。
 */
export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}…(+${String(value.length - maxLength)})`;
}

/**
 * 一行日志长什么样。**单独导出**，是因为[多副本验证环境](../../../docs/terms.md)的测试要写
 * 自己的步骤行，再跟各容器的日志**按时间合并成一条时间线**——两边的行格式必须一模一样，
 * 否则合并出来的时间线读不成。
 */
export function formatLogLine(line: {
  at: Date;
  /** 哪个副本打的；合并时间线时靠它分辨来源。测试自己的步骤行写 `test`。 */
  node?: string;
  level: string;
  scope: string;
  message: string;
  fields?: LogFields;
}): string {
  const hasFields =
    line.fields !== undefined && Object.keys(line.fields).length > 0;
  const suffix = hasFields ? ` ${JSON.stringify(line.fields)}` : '';
  const node =
    line.node !== undefined && line.node !== '' ? `${line.node} ` : '';
  return `${line.at.toISOString()} ${node}${line.level.toUpperCase()} [${line.scope}] ${line.message}${suffix}`;
}

function formatLine(
  level: LogLevel,
  scope: string,
  message: string,
  fields?: LogFields,
): string {
  return formatLogLine({
    at: new Date(),
    node: processEnv().RUNKO_NODE_URL === undefined ? '' : nodeName(),
    level,
    scope,
    message,
    ...(fields !== undefined ? { fields } : {}),
  });
}

/** 多副本时日志里带上副本名（从可达地址取主机名），单进程时不带。 */
function nodeName(): string {
  const url = processEnv().RUNKO_NODE_URL?.trim() ?? '';
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * `opts.level`/`opts.sink` 都在创建时定死（不是每次调用重新读一遍
 * `LOG_LEVEL`）——同一个 logger 实例的行为在其生命周期内保持稳定，这也是
 * 为什么默认单例 `logger`（本文件底部）能被安全地到处复用。
 */
export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  const threshold = LEVEL_RANK[opts.level ?? resolveLevelFromEnv()];
  const sink = opts.sink ?? defaultSink;

  function log(
    level: LogLevel,
    scope: string,
    message: string,
    fields?: LogFields,
  ): void {
    if (LEVEL_RANK[level] < threshold) {
      return;
    }
    sink(formatLine(level, scope, message, fields));
  }

  return {
    debug: (scope, message, fields) => {
      log('debug', scope, message, fields);
    },
    info: (scope, message, fields) => {
      log('info', scope, message, fields);
    },
    warn: (scope, message, fields) => {
      log('warn', scope, message, fields);
    },
    error: (scope, message, fields) => {
      log('error', scope, message, fields);
    },
  };
}

/** 默认单例——`StartTurnParams.logger` 等可选注入点缺省用它，写 `stdout`。 */
export const logger: Logger = createLogger();
