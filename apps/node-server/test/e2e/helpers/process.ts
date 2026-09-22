/**
 * 起停一个真的 node-server 子进程——多副本 / 挂起恢复这两组 e2e 测试的地基。
 *
 * 为什么非要真进程不可：进程崩溃（`kill -9`）、被冻住又活过来（`SIGSTOP`/`SIGCONT`）、
 * 两个连接池各自独立，这些只有跨进程才有；同一个进程里起两个 runtime 实例测不出来
 * （见 `multi-replica.e2e.test.ts` 文件头的说明）。
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { sleep } from './wait.js';

/** `apps/node-server/src/index.ts`——用 tsx 直接跑源码，不用先 build 这个 app 自己。 */
const ENTRY = fileURLToPath(new URL('../../../src/index.ts', import.meta.url));

/** 每个副本最多留多少行输出——只为失败时诊断，不需要全量。 */
const MAX_LOG_LINES = 400;

export interface Replica {
  readonly name: string;
  readonly url: string;
  readonly child: ChildProcess;
  /** stdout + stderr 按到达顺序合并，最近 `MAX_LOG_LINES` 行——测试失败时整段打印用。 */
  readonly logLines: string[];
}

export interface StartReplicaOptions {
  readonly name: string;
  readonly port: number;
  readonly env: Readonly<Record<string, string>>;
  /** 等 `/health` 变绿的上限，默认 30 秒——真进程要建库、起 HTTP server，比单测慢得多。 */
  readonly healthTimeoutMs?: number;
}

function recordLine(
  replica: Replica,
  stream: 'out' | 'err',
  chunk: Buffer,
): void {
  for (const line of chunk.toString('utf8').split('\n')) {
    if (line.length === 0) {
      continue;
    }
    replica.logLines.push(`[${replica.name}:${stream}] ${line}`);
  }
  if (replica.logLines.length > MAX_LOG_LINES) {
    replica.logLines.splice(0, replica.logLines.length - MAX_LOG_LINES);
  }
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) {
        return;
      }
    } catch {
      // 端口还没监听，继续等。
    }
    if (Date.now() > deadline) {
      throw new Error(
        `replica at ${url} did not become healthy within ${String(timeoutMs)}ms`,
      );
    }
    await sleep(100);
  }
}

/** 起一个副本，等它 `/health` 返回 200 才算就绪。`SERVER_PORT` 由这里统一补上，调用方不用重复传。 */
export async function startReplica(
  opts: StartReplicaOptions,
): Promise<Replica> {
  const url = `http://127.0.0.1:${String(opts.port)}`;
  const child = spawn(process.execPath, ['--import', 'tsx', ENTRY], {
    env: { ...process.env, ...opts.env, SERVER_PORT: String(opts.port) },
    // stdin 不需要；stdout/stderr 都收起来——node-server 的结构化日志走 stdout，
    // 未捕获异常的堆栈走 stderr，失败时两个都要看得见（见 `dumpReplicaLog`）。
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const replica: Replica = { name: opts.name, url, child, logLines: [] };
  child.stdout?.on('data', (chunk: Buffer) => {
    recordLine(replica, 'out', chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    recordLine(replica, 'err', chunk);
  });
  await waitForHealth(url, opts.healthTimeoutMs ?? 30_000);
  return replica;
}

/** `kill -9` / `SIGSTOP` / `SIGCONT`——只有真进程才有这些，用来模拟「崩溃」与「活着但没在跑」。 */
export function signalReplica(replica: Replica, signal: NodeJS.Signals): void {
  replica.child.kill(signal);
}

/** 强杀并等进程真的退出，避免后续断言在一个还没死透的进程上跑出假象。 */
export async function killReplica(
  replica: Replica,
  timeoutMs = 10_000,
): Promise<void> {
  replica.child.kill('SIGKILL');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (replica.child.exitCode !== null || replica.child.signalCode !== null) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `replica ${replica.name} did not exit within ${String(timeoutMs)}ms after SIGKILL`,
      );
    }
    await sleep(50);
  }
}

/** 打印一个副本最近的输出——测试失败时用，定位「到底是哪一步炸的」。 */
export function dumpReplicaLog(replica: Replica): void {
  console.error(`\n---- ${replica.name} (${replica.url}) recent output ----`);
  console.error(
    replica.logLines.length > 0 ?
      replica.logLines.join('\n')
    : '(no output captured)',
  );
}

export function dumpReplicaLogs(replicas: readonly Replica[]): void {
  for (const replica of replicas) {
    dumpReplicaLog(replica);
  }
}

/**
 * 一个测试文件内，所有起过的副本的登记表——`afterAll` 统一收尾用，避免每个用例自己记账。
 *
 * `killAll` 对每个副本都先 `SIGCONT` 再 `SIGKILL`：被 `SIGSTOP` 冻住的进程只认
 * `SIGKILL`/`SIGCONT` 这两个信号，直接发 `SIGKILL` 在大多数系统上也能杀掉，但先解冻更稳妥，
 * 让「进程确实退出」这件事不必依赖某个平台对「杀一个冻住的进程」的具体实现细节。
 */
export function createReplicaRegistry(): {
  start(opts: StartReplicaOptions): Promise<Replica>;
  all(): readonly Replica[];
  killAll(): void;
} {
  const replicas: Replica[] = [];
  return {
    async start(opts) {
      const replica = await startReplica(opts);
      replicas.push(replica);
      return replica;
    },
    all: () => replicas,
    killAll: () => {
      for (const replica of replicas) {
        replica.child.kill('SIGCONT');
        replica.child.kill('SIGKILL');
      }
    },
  };
}
