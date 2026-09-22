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

/** 迁移表自己的名字——跟 Kysely 的缺省一致，写出来是为了别处（旧库体检）能引用它。 */
export const MIGRATION_TABLE = 'kysely_migration';

export function appMigrationProvider(flavor: Flavor): MigrationProvider {
  const migrations: Record<string, Migration> = {
    '001_initial': createInitialMigration(flavor),
  };
  return {
    getMigrations: () => Promise.resolve(migrations),
  };
}
