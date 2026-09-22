/**
 * 本应用那三张表的建表语句。**只管自己的**：better-auth 的表由它自己的迁移接口建，
 * 框架那四张由 `@runko/persist-kysely` 的 `migrate()` 建，三段的顺序在 `migrate.ts`。
 *
 * 用 Kysely 的 `Migrator`：迁移写成一条条带名字的 `up`，跑过的名字记在 `kysely_migration`
 * 表里，同一条不会跑第二遍。**加列、改表一律新写一条**，不要改已经跑过的那条——库里
 * 已经建好的表不会因为你改了代码就跟着变。
 *
 * 两种库的差别只在列类型上（毫秒时间戳：SQLite 是 `integer`，Postgres 是 `bigint`），
 * 所以这里按 flavor 造迁移，而不是写两份。
 */
import type { Flavor } from '@runko/persist-kysely';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Migration, MigrationProvider } from 'kysely/migration';

import type { ChatDatabase } from './schema.js';

/** 毫秒时间戳的列类型。 */
function timestampType(flavor: Flavor): 'integer' | 'bigint' {
  return flavor === 'sqlite' ? 'integer' : 'bigint';
}

function createInitialMigration(flavor: Flavor): Migration {
  const ts = timestampType(flavor);
  return {
    async up(db: Kysely<ChatDatabase>): Promise<void> {
      await db.schema
        .createTable('conversations')
        .addColumn('id', 'varchar(255)', (col) => col.primaryKey())
        .addColumn('user_id', 'varchar(255)', (col) =>
          col.notNull().references('user.id'),
        )
        .addColumn('title', 'text', (col) => col.notNull())
        .addColumn('repo', 'text', (col) => col.notNull())
        .addColumn('branch_name', 'text', (col) => col.notNull())
        .addColumn('sandbox_name', 'text', (col) => col.notNull())
        .addColumn('provider', 'text', (col) => col.notNull())
        .addColumn('sandbox_id', 'text')
        .addColumn('status', 'text', (col) => col.notNull())
        .addColumn('last_active_at', ts, (col) => col.notNull())
        .addColumn('available_skills_json', 'text', (col) => col.notNull())
        .addColumn('created_at', ts, (col) => col.notNull())
        .execute();

      await db.schema
        .createIndex('conversations_user_id_idx')
        .on('conversations')
        .column('user_id')
        .execute();

      await db.schema
        .createTable('push_subscriptions')
        .addColumn('endpoint', 'varchar(255)', (col) => col.primaryKey())
        .addColumn('user_id', 'varchar(255)', (col) =>
          col.notNull().references('user.id').onDelete('cascade'),
        )
        .addColumn('p256dh', 'text', (col) => col.notNull())
        .addColumn('auth', 'text', (col) => col.notNull())
        .addColumn('user_agent', 'text')
        .addColumn('created_at', ts, (col) => col.notNull())
        .addColumn('last_sent_at', ts)
        .addColumn('last_error', 'text')
        .execute();

      await db.schema
        .createIndex('push_subscriptions_user_id_idx')
        .on('push_subscriptions')
        .column('user_id')
        .execute();

      // 主键三列一起：同一个会话里，**每个用户各自**对**每一条具体调用**的授权。
      await db.schema
        .createTable('conversation_grants')
        .addColumn('conversation_id', 'varchar(255)', (col) => col.notNull())
        .addColumn('user_id', 'varchar(255)', (col) => col.notNull())
        .addColumn('grant_key', 'varchar(255)', (col) => col.notNull())
        .addColumn('created_at', ts, (col) => col.notNull())
        .addPrimaryKeyConstraint('conversation_grants_pk', [
          'conversation_id',
          'user_id',
          'grant_key',
        ])
        .execute();
    },
  };
}

/**
 * 第二条：本地沙盒进场带来的两处改动。
 *
 * - 本地沙盒没有仓库与分支，`repo`/`branch_name` 改成可空。SQLite 改不了列约束，只能
 *   照它的官方办法来：建新表、搬数据、换名字。
 * - 新表 `local_workspaces`：本地沙盒每轮收尾存一份文件快照。
 */
function createLocalSandboxMigration(flavor: Flavor): Migration {
  const ts = timestampType(flavor);
  return {
    async up(db: Kysely<ChatDatabase>): Promise<void> {
      if (flavor === 'sqlite') {
        await db.schema
          .createTable('conversations_new')
          .addColumn('id', 'varchar(255)', (col) => col.primaryKey())
          .addColumn('user_id', 'varchar(255)', (col) => col.notNull())
          .addColumn('title', 'text', (col) => col.notNull())
          .addColumn('repo', 'text')
          .addColumn('branch_name', 'text')
          .addColumn('sandbox_name', 'text', (col) => col.notNull())
          .addColumn('provider', 'text', (col) => col.notNull())
          .addColumn('sandbox_id', 'text')
          .addColumn('status', 'text', (col) => col.notNull())
          .addColumn('last_active_at', ts, (col) => col.notNull())
          .addColumn('available_skills_json', 'text', (col) => col.notNull())
          .addColumn('created_at', ts, (col) => col.notNull())
          .execute();
        await sql`INSERT INTO conversations_new SELECT id, user_id, title, repo, branch_name, sandbox_name, provider, sandbox_id, status, last_active_at, available_skills_json, created_at FROM conversations`.execute(
          db,
        );
        await db.schema.dropTable('conversations').execute();
        await sql`ALTER TABLE conversations_new RENAME TO conversations`.execute(
          db,
        );
        await db.schema
          .createIndex('conversations_user_id_idx')
          .on('conversations')
          .column('user_id')
          .execute();
      } else {
        await db.schema
          .alterTable('conversations')
          .alterColumn('repo', (col) => col.dropNotNull())
          .execute();
        await db.schema
          .alterTable('conversations')
          .alterColumn('branch_name', (col) => col.dropNotNull())
          .execute();
      }

      await db.schema
        .createTable('local_workspaces')
        .addColumn('sandbox_name', 'varchar(255)', (col) => col.primaryKey())
        .addColumn('version', 'integer', (col) => col.notNull())
        .addColumn('snapshot', 'text', (col) => col.notNull())
        .addColumn('updated_at', ts, (col) => col.notNull())
        .execute();
    },
  };
}

/** 第三条：[在场](../../../../docs/terms.md)从进程内存挪进库，多副本才读得到。 */
function createPresenceMigration(flavor: Flavor): Migration {
  const ts = timestampType(flavor);
  return {
    async up(db: Kysely<ChatDatabase>): Promise<void> {
      await db.schema
        .createTable('chat_presence')
        .addColumn('user_id', 'varchar(255)', (col) => col.notNull())
        .addColumn('conversation_id', 'varchar(255)', (col) => col.notNull())
        .addColumn('expires_at', ts, (col) => col.notNull())
        .addPrimaryKeyConstraint('chat_presence_pk', [
          'user_id',
          'conversation_id',
        ])
        .execute();
    },
  };
}

/** 迁移表自己的名字——跟 Kysely 的缺省一致，写出来是为了别处（旧库体检）能引用它。 */
export const MIGRATION_TABLE = 'kysely_migration';

export function appMigrationProvider(flavor: Flavor): MigrationProvider {
  const migrations: Record<string, Migration> = {
    '001_initial': createInitialMigration(flavor),
    '002_local_sandbox': createLocalSandboxMigration(flavor),
    '003_presence': createPresenceMigration(flavor),
  };
  return {
    getMigrations: () => Promise.resolve(migrations),
  };
}
