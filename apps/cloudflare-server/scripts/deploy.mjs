#!/usr/bin/env node
/**
 * 一条命令部署 chat 应用 Cloudflare 版（docs/host/cloudflare/tech/chat-on-cloudflare.md §9）。
 *
 *   pnpm cf:deploy              # 真部署（仓库根目录）
 *   pnpm cf:deploy --dry-run    # 只做本地那几步，远程的只打印
 *
 * 在本包目录里要写 `pnpm run deploy`：`pnpm deploy` 是 pnpm 自带的另一个命令。
 *
 * 步骤：查登录与 Docker → 建 D1（已有就跳过，id 写回 wrangler.jsonc）→ 远程跑 D1 迁移
 * → 构建依赖与前端（同源，不写死接口地址）→ `wrangler deploy`。没设过 `BETTER_AUTH_SECRET`
 * 就生成一个随机值，随这次部署一起上传，第一个版本上线时就带着它。
 *
 * 每一步都可以重跑：D1 已有就不建，迁移只跑没跑过的，密钥已有就不动。
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const REPO_ROOT = path.resolve(APP_DIR, '../..');
const WRANGLER_CONFIG = path.join(APP_DIR, 'wrangler.jsonc');
const WRANGLER_BIN = path.join(APP_DIR, 'node_modules/.bin/wrangler');

/** 与 wrangler.jsonc 里 `d1_databases[0].database_name` 一致。 */
const DATABASE_NAME = 'runko-chat';
/** 找 `database_id` 与写回它用同一个模式，配置怎么排版都对得上。 */
const DATABASE_ID_PATTERN = /("database_id":\s*")([^"]*)(")/;
/** 仓库里的占位 id：看到它就说明还没建过库。 */
const PLACEHOLDER_ID = '00000000-0000-0000-0000-000000000000';

const dryRun = process.argv.includes('--dry-run');

function log(message) {
  console.log(`\n▸ ${message}`);
}

/** 跑一条命令，输出直接给终端。 */
function run(command, args, opts = {}) {
  execFileSync(command, args, {
    cwd: opts.cwd ?? APP_DIR,
    stdio:
      opts.input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'],
    env: { ...process.env, ...opts.env },
    ...(opts.input === undefined ? {} : { input: opts.input }),
  });
}

/** 跑一条命令，把标准输出收回来。 */
function capture(command, args) {
  return execFileSync(command, args, {
    cwd: APP_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

/** 远程那几步：`--dry-run` 时只打印。 */
function runRemote(command, args, opts) {
  if (dryRun) {
    console.log(`  [dry-run] ${[path.basename(command), ...args].join(' ')}`);
    return;
  }
  run(command, args, opts);
}

function wrangler(args, opts) {
  run(WRANGLER_BIN, args, opts);
}

function fail(message) {
  console.error(`\n✘ ${message}`);
  process.exit(1);
}

function preflight() {
  if (!existsSync(WRANGLER_BIN)) {
    fail('找不到 wrangler。先在仓库根目录跑 `pnpm install`。');
  }
  if (dryRun) {
    return;
  }
  try {
    capture(WRANGLER_BIN, ['whoami']);
  } catch {
    fail(
      '还没登录 Cloudflare。先跑 `pnpm --filter @runko-chat/cloudflare-server exec wrangler login`。',
    );
  }
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
  } catch {
    fail(
      'Docker 没在跑。部署要用本机 Docker 构建沙盒镜像，先把 Docker 启动起来。',
    );
  }
}

/** 找到或建好 D1，把 id 写回 wrangler.jsonc。 */
function ensureDatabase() {
  const config = readFileSync(WRANGLER_CONFIG, 'utf8');
  const current = DATABASE_ID_PATTERN.exec(config)?.[2];
  if (current === undefined) {
    fail('wrangler.jsonc 里找不到 d1_databases 的 database_id。');
  }
  if (dryRun) {
    const state =
      current === PLACEHOLDER_ID ? '还是占位值，真部署时会建库' : (
        `现在是 ${current}`
      );
    console.log(
      `  [dry-run] 查找或新建 D1「${DATABASE_NAME}」，id 写回 wrangler.jsonc（${state}）`,
    );
    return;
  }
  const find = () =>
    JSON.parse(capture(WRANGLER_BIN, ['d1', 'list', '--json'])).find(
      (db) => db.name === DATABASE_NAME,
    );
  let database = find();
  if (database === undefined) {
    // id 由下面统一写回，不让 wrangler 自己改配置（它会再追加一个绑定）。
    wrangler(['d1', 'create', DATABASE_NAME, '--update-config=false']);
    database = find();
  }
  if (database === undefined) {
    fail(`建完 D1 之后还是列不出「${DATABASE_NAME}」，请到控制台看一眼。`);
  }
  if (database.uuid !== current) {
    writeFileSync(
      WRANGLER_CONFIG,
      config.replace(DATABASE_ID_PATTERN, `$1${database.uuid}$3`),
    );
    console.log(
      `  wrangler.jsonc 的 database_id 已写成 ${database.uuid}（记得提交这处改动）`,
    );
  } else {
    console.log(`  D1 已存在：${database.uuid}`);
  }
}

/** 构建依赖（发布包与共用层）和前端。前端与接口同源，所以不写死接口地址（`SERVER_URL` 置空）。 */
function buildFrontend() {
  run(
    'pnpm',
    [
      '--filter',
      '@runko-chat/cloudflare-server^...',
      '--filter',
      '@runko-chat/web^...',
      'build',
    ],
    { cwd: REPO_ROOT },
  );
  run('pnpm', ['--filter', '@runko-chat/web', 'build'], {
    cwd: REPO_ROOT,
    env: { SERVER_URL: '' },
  });
}

/** 这个 Worker 上已经设过的密钥名。Worker 还没部署过时一个都没有。 */
function existingSecretNames() {
  try {
    const out = execFileSync(
      WRANGLER_BIN,
      ['secret', 'list', '--format', 'json'],
      { cwd: APP_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return JSON.parse(out).map((secret) => secret.name);
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    // Worker 还不存在：wrangler 4.112 报 `Worker "<名字>" not found.`（接口原始错误码是 10007）。
    // 别的错（网络、权限）不能当成「没有密钥」：那样会生成新密钥、顶掉旧的，所有人都得重新登录。
    if (/Worker "[^"]+"[^\n]* not found|\b10007\b/.test(output)) {
      return [];
    }
    console.error(output);
    fail(
      '查不到这个 Worker 已有的密钥，先停下，免得把 BETTER_AUTH_SECRET 换掉。',
    );
  }
}

/**
 * 没设过 `BETTER_AUTH_SECRET` 就生成一个，写进临时文件交给 `wrangler deploy --secrets-file`。
 * 返回要追加给 `wrangler deploy` 的参数和收尾函数；已经设过就什么都不加。
 */
function authSecretArgs() {
  if (dryRun) {
    console.log(
      '  [dry-run] 没有 BETTER_AUTH_SECRET 就生成一个随机值，随部署一起上传',
    );
    return { args: [], cleanup: () => {} };
  }
  if (existingSecretNames().includes('BETTER_AUTH_SECRET')) {
    console.log('  BETTER_AUTH_SECRET 已经设过，不动它');
    return { args: [], cleanup: () => {} };
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'runko-deploy-'));
  const file = path.join(dir, 'secrets.json');
  writeFileSync(
    file,
    JSON.stringify({
      BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
    }),
    { mode: 0o600 },
  );
  console.log('  生成了新的 BETTER_AUTH_SECRET，随这次部署一起上传');
  return {
    args: ['--secrets-file', file],
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

preflight();

log('D1 数据库');
ensureDatabase();

log('D1 迁移（远程）');
runRemote(WRANGLER_BIN, [
  'd1',
  'migrations',
  'apply',
  DATABASE_NAME,
  '--remote',
]);

log('构建依赖与前端');
buildFrontend();

log('登录密钥');
const secret = authSecretArgs();
// Ctrl-C 同时打到 wrangler 和本进程。没有处理函数时本进程当场退出、下面的 finally 不跑，
// 临时密钥文件就留在磁盘上；注册了它，就等 wrangler 退出、finally 删完文件再走。
const onSignal = () => {
  secret.cleanup();
  process.exit(130);
};
process.once('SIGINT', onSignal);
process.once('SIGTERM', onSignal);

log(dryRun ? '打包 Worker（不上传）' : '部署 Worker、会话对象与沙盒镜像');
try {
  if (dryRun) {
    wrangler(['deploy', '--dry-run', '--outdir', path.join(APP_DIR, 'dist')]);
  } else {
    wrangler(['deploy', ...secret.args]);
  }
} finally {
  secret.cleanup();
}

log(
  dryRun ?
    '预演完成：上面标了 [dry-run] 的几步在真部署时才会执行。'
  : '部署完成。',
);
