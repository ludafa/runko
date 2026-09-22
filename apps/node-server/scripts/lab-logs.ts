/**
 * **把[多副本验证环境](../../../docs/terms.md)的日志存到本地**，并按时间合并成一条时间线。
 *
 * 两个用处：
 *
 * - `test:lab` 每个场景结束都调一次 `collectLabLogs`（测试中途失败或被 Ctrl+C 也留得下「到上一个场景为止」的日志）；
 * - 手动起的那套环境：`pnpm --filter @runko-demo/persist-demo lab:logs` 存一份。
 *
 * 目录是 `apps/persist-demo/logs/lab-<时间>/`（不进 git），`logs/lab-latest` 指向最近一次：
 *
 * | 文件 | 内容 |
 * |---|---|
 * | `<服务名>.log` | `docker compose logs` 的原样输出（被 kill 又拉起的是同一个容器，前后两段都在） |
 * | `test.log` | 测试进程自己写的步骤（只有 `test:lab` 才有） |
 * | `timeline.log` | 三个副本 + `test.log`，按每行开头的 ISO 时间排好 |
 *
 * 为什么副本写 stdout、这里再收，而不是挂卷让副本直接写文件：见技术方案 §11.6。
 */
import { execFile } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** `apps/persist-demo/logs` */
export const LOGS_ROOT = fileURLToPath(new URL('../logs', import.meta.url));
/** 手动环境用的 compose 文件与项目名（`lab:up` 起的那套）。 */
export const DEFAULT_COMPOSE_FILE = fileURLToPath(
  new URL('../docker/compose.yml', import.meta.url),
);
export const DEFAULT_PROJECT = 'runko-chat-lab';

/** 进时间线的服务：三个副本。Postgres 与 nginx 的日志格式不是我们的，单独存文件但不合并。 */
const TIMELINE_SERVICES = ['replica-a', 'replica-b', 'replica-c'] as const;

/** 新建一个本次运行的日志目录，并把 `lab-latest` 指过去。 */
export function createLogDir(
  root: string = LOGS_ROOT,
  now: Date = new Date(),
): string {
  // 文件名里不放冒号：2026-09-13T06-30-52
  const stamp = now.toISOString().slice(0, 19).replaceAll(':', '-');
  const dir = join(root, `lab-${stamp}`);
  mkdirSync(dir, { recursive: true });
  const latest = join(root, 'lab-latest');
  // 旧的 `lab-latest` 是指向目录的软链接：`rmSync` 会把它当目录拒删，只能 `unlink`。
  // 万一有人手动建了个同名的真目录，就别动它，也不建链接。
  const existing = lstatSync(latest, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink() === true) {
    unlinkSync(latest);
  }
  if (existing === undefined || existing.isSymbolicLink()) {
    symlinkSync(basename(dir), latest);
  }
  return dir;
}

export interface CollectOptions {
  dir: string;
  project?: string;
  composeFile?: string;
  /** 跑 `docker compose` 时带的环境变量（`test:lab` 用它指定独立端口）。 */
  env?: NodeJS.ProcessEnv;
}

/** 把每个服务的日志写成 `<服务名>.log`，再合并出 `timeline.log`。 */
export async function collectLabLogs(opts: CollectOptions): Promise<void> {
  const compose = async (...args: string[]): Promise<string> => {
    const { stdout } = await run(
      'docker',
      [
        'compose',
        '-p',
        opts.project ?? DEFAULT_PROJECT,
        '-f',
        opts.composeFile ?? DEFAULT_COMPOSE_FILE,
        ...args,
      ],
      { env: opts.env ?? process.env, maxBuffer: 256 * 1024 * 1024 },
    );
    return stdout;
  };

  const services = (await compose('config', '--services'))
    .split('\n')
    .filter((name) => name !== '');
  const texts = new Map<string, string>();
  for (const service of services) {
    // 已经删掉的容器没有日志可取，跳过它而不是让整次收集失败。
    const text = await compose(
      'logs',
      '--no-color',
      '--no-log-prefix',
      service,
    ).catch(() => undefined);
    if (text === undefined) {
      continue;
    }
    texts.set(service, text);
    writeFileSync(join(opts.dir, `${service}.log`), text);
  }

  const sources = TIMELINE_SERVICES.flatMap((service) => {
    const text = texts.get(service);
    return text === undefined ? [] : [text];
  });
  const testLog = join(opts.dir, 'test.log');
  if (existsSync(testLog)) {
    sources.push(readFileSync(testLog, 'utf8'));
  }
  writeFileSync(join(opts.dir, 'timeline.log'), mergeTimeline(sources));
}

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/;

/**
 * 把几份日志按时间合并。**每行开头是 ISO 时间的算一条**；不是的行（报错的调用栈、第三方的输出）
 * 跟着上一条走，不单独排序——否则一段调用栈会被拆散到时间线各处。
 *
 * 排序是稳定的：同一毫秒的两条保持它们在各自来源里的先后，来源之间按传入顺序。
 */
export function mergeTimeline(sources: readonly string[]): string {
  const entries: { stamp: string; order: number; lines: string[] }[] = [];
  let order = 0;
  for (const source of sources) {
    let current: { stamp: string; order: number; lines: string[] } | undefined;
    for (const line of source.split('\n')) {
      if (line === '') {
        continue;
      }
      const stamp = STAMP.exec(line)?.[0];
      if (stamp !== undefined) {
        current = { stamp, order: order++, lines: [line] };
        entries.push(current);
      } else if (current !== undefined) {
        current.lines.push(`    ${line}`);
      }
      // 一份日志开头就没有时间戳的行（进程起来之前的输出）没法放进时间线，留在它自己的 <服务名>.log 里。
    }
  }
  entries.sort((a, b) =>
    a.stamp === b.stamp ? a.order - b.order
    : a.stamp < b.stamp ? -1
    : 1,
  );
  return (
    entries.map((entry) => entry.lines.join('\n')).join('\n') +
    (entries.length > 0 ? '\n' : '')
  );
}

// 直接运行（`lab:logs`）时：给手动起的那套环境存一份。
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const dir = createLogDir();
  await collectLabLogs({ dir });
  console.log(
    `日志已存到 ${dir}（时间线：${join(dirname(dir), 'lab-latest', 'timeline.log')}）`,
  );
}
