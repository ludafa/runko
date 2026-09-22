/**
 * 旧版库的守门：表结构换过了，旧库不该被新代码当成自己的库接着用。
 *
 * 不加这道闸的后果是**静默**的：建表语句是「表不存在才建」，旧库里同名的表照样在，
 * 于是新代码在旧表上跑，缺哪一列要到某次查询才炸。
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { assertNotLegacy } from '../../src/db/instance.js';

describe('旧版库守门', () => {
  it('库里有旧版的迁移记录表 → 抛错，并告诉人怎么办', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec('CREATE TABLE __drizzle_migrations (id integer primary key)');

    expect(() => {
      assertNotLegacy(sqlite, 'data.db');
    }).toThrow(/data\.db 是旧版本的数据库/);
  });

  it('空库、以及本版本自己的库 → 放行', () => {
    const empty = new Database(':memory:');
    expect(() => {
      assertNotLegacy(empty, 'data.db');
    }).not.toThrow();

    const current = new Database(':memory:');
    current.exec('CREATE TABLE kysely_migration (name text primary key)');
    expect(() => {
      assertNotLegacy(current, 'data.db');
    }).not.toThrow();
  });
});
