/**
 * 生成 D1 的迁移文件（`migrations/NNNN_<名字>.sql`），交给 `wrangler d1 migrations apply`。
 *
 * 不手写第二份 DDL。在一个内存 SQLite 上：
 *
 * 1. 按编号重放 `migrations/` 里已有的文件——得到线上 D1 现在的样子；
 * 2. 再跑一遍 Node 版那三段建表里的前两段（better-auth 自己的表、chat 应用的 Kysely 迁移；
 *    框架的表不在 D1，在每个会话对象里），以及 Cloudflare 版独有的表的迁移（`CLOUDFLARE_MIGRATIONS`）；
 * 3. 第 2 步里真正改了库的语句（建表、改表、往迁移记录表里记一笔）就是这一次的增量，
 *    参数内联后写成下一个编号的文件。没有增量就不写。
 *
 * 迁移记录表（`kysely_migration`）也建在 D1 上：D1 不跑迁移器，但第 1 步重放之后，
 * 迁移器靠它知道哪几段已经跑过。
 *
 * `--check`：只看有没有增量，有就退出码 1（`pnpm test` 里跑）。`--name <名字>`：新文件的名字，
 * 缺省第一份叫 `init`，之后叫 `update`。
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { appMigrationProvider } from '@runko-chat/shared/db/migrations';
import type { ChatDatabase } from '@runko-chat/shared/db/schema';
import { getMigrations } from 'better-auth/db/migration';
import Database from 'better-sqlite3';
import type { CompiledQuery } from 'kysely';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';

import { authOptions } from '../src/auth-options.js';
import { CLOUDFLARE_MIGRATIONS } from '../src/db/live-state.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const FILE_PATTERN = /^(\d{4})_[\w-]+\.sql$/;

const HEADER = `-- 由 scripts/generate-d1-migrations.ts 生成，别手改：改表请改共用层的迁移或 better-auth 配置，再重新生成。
-- 已经发出去的迁移文件不能再改（D1 按文件名记哪些跑过），表有变化就生成下一个编号的文件。
`;

/** 读库、开关事务、迁移器自己加解锁的语句，都不是增量。 */
const NOT_A_CHANGE =
  /^\s*(select|with|pragma|begin|commit|rollback|savepoint|release)\b/i;
const LOCK_UPDATE = /^\s*update\s+"?kysely_migration_lock"?/i;

function existingFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => FILE_PATTERN.test(name))
    .sort();
}

/** 只认这几种参数：迁移器记的迁移名与时间戳是字符串，别的语句不带参数。 */
function literal(value: unknown): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (typeof value === 'string') {
    return `'${value.replaceAll("'", "''")}'`;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'boolean') {
    return value ? '1' : '0';
  }
  throw new TypeError(`迁移语句里有不认识的参数类型：${typeof value}`);
}

function inline(query: CompiledQuery): string {
  const params = query.parameters;
  const placeholders = query.sql.match(/\?/g)?.length ?? 0;
  if (placeholders !== params.length) {
    throw new Error(
      `占位符与参数个数对不上（${String(placeholders)} / ${String(params.length)}）：${query.sql}`,
    );
  }
  let index = 0;
  return query.sql.replace(/\?/g, () => literal(params[index++]));
}

async function pendingStatements(): Promise<string[]> {
  const sqlite = new Database(':memory:');
  for (const name of existingFiles()) {
    sqlite.exec(readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'));
  }

  const statements: string[] = [];
  const db = new Kysely<ChatDatabase>({
    dialect: new SqliteDialect({ database: sqlite }),
    log: (event) => {
      const { sql } = event.query;
      if (
        event.level === 'query' &&
        !NOT_A_CHANGE.test(sql) &&
        !LOCK_UPDATE.test(sql)
      ) {
        statements.push(inline(event.query));
      }
    },
  });
  try {
    const auth = await getMigrations(
      authOptions({ db, baseURL: 'http://localhost' }),
    );
    await auth.runMigrations();

    // 共用层的迁移与 Cloudflare 版自己的记在同一张迁移记录表里。两边各自往后编号，按名字排
    // 不一定是执行顺序，所以允许乱序。
    const app = appMigrationProvider('sqlite');
    const migrator = new Migrator({
      db,
      provider: {
        getMigrations: async () => ({
          ...(await app.getMigrations()),
          ...CLOUDFLARE_MIGRATIONS,
        }),
      },
      allowUnorderedMigrations: true,
    });
    const { error } = await migrator.migrateToLatest();
    if (error !== undefined) {
      throw error instanceof Error ? error : new Error(String(error));
    }

    return statements;
  } finally {
    await db.destroy();
  }
}

function nameArg(): string | undefined {
  const index = process.argv.indexOf('--name');
  return index === -1 ? undefined : process.argv[index + 1];
}

const statements = await pendingStatements();
const files = existingFiles();

if (process.argv.includes('--check')) {
  if (statements.length > 0) {
    console.error(
      `D1 迁移落后于当前的表定义，还差 ${String(statements.length)} 条语句：跑一次 ` +
        '`pnpm --filter @runko-chat/cloudflare-server generate:migrations` 再提交。',
    );
    process.exit(1);
  }
  console.log('D1 migrations up to date.');
} else if (statements.length === 0) {
  console.log('D1 migrations up to date, nothing to write.');
} else {
  const last = files.at(-1)?.slice(0, 4);
  const next = String(Number(last ?? '0') + 1).padStart(4, '0');
  const slug = nameArg() ?? (files.length === 0 ? 'init' : 'update');
  if (!/^[\w-]+$/.test(slug)) {
    throw new Error(`--name 只能用字母、数字、下划线、连字符：${slug}`);
  }
  const output = path.join(MIGRATIONS_DIR, `${next}_${slug}.sql`);
  writeFileSync(
    output,
    `${HEADER}\n${statements.map((statement) => `${statement};`).join('\n\n')}\n`,
  );
  console.log(`wrote ${output}`);
}
