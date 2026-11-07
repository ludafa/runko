import type { Db } from '@runko-chat/shared/db/schema';
import { Kysely } from 'kysely';

import { D1Dialect } from './d1-dialect.js';

/**
 * D1 上的 Kysely 实例。会话表、授权表、better-auth 的表都在这一个库里；框架的四张表
 * 不在这里，在每个会话对象自己的 SQLite 里。
 *
 * 每个 isolate 按 D1 绑定缓存一份：实例本身不连库，造一个很便宜，但没必要每个请求都造。
 */
const instances = new WeakMap<D1Database, Db>();

export function chatDb(d1: D1Database): Db {
  const cached = instances.get(d1);
  if (cached !== undefined) {
    return cached;
  }
  const db: Db = new Kysely({ dialect: new D1Dialect(d1) });
  instances.set(d1, db);
  return db;
}
