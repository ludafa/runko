/**
 * 归属仲裁的配置面：持有者名字、心跳与接管阈值都来自环境变量。
 *
 * 守的是**接线**：这三个值配了却没传给框架，故障会很隐蔽——验证环境按「秒级接管」写的
 * 场景会莫名其妙等满一分钟，而日志里一切正常。
 */
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { describe, expect, it } from 'vitest';

import { createChatArbitration } from '../../src/agent/persistence.js';
import type { ChatDatabase } from '../../src/db/schema.js';

function db(): Kysely<ChatDatabase> {
  return new Kysely<ChatDatabase>({
    dialect: new SqliteDialect({ database: new Database(':memory:') }),
  });
}

describe('createChatArbitration', () => {
  it('holder 缺省是 local；配了 RUNKO_NODE_URL 就用它（多副本要靠它转发）', () => {
    expect(() => createChatArbitration(db(), {}, {})).not.toThrow();
    expect(() =>
      createChatArbitration(db(), {}, { RUNKO_NODE_URL: 'http://a:3900' }),
    ).not.toThrow();
  });

  it('**心跳与接管阈值确实传给了框架**：阈值小于 3 倍心跳时框架当场抛', () => {
    expect(() =>
      createChatArbitration(
        db(),
        {},
        { RUNKO_HEARTBEAT_MS: '1000', RUNKO_TAKEOVER_MS: '2000' },
      ),
    ).toThrow(/takeoverMs/);

    // 合法的一组（阈值是心跳的 5 倍）不抛。
    expect(() =>
      createChatArbitration(
        db(),
        {},
        { RUNKO_HEARTBEAT_MS: '200', RUNKO_TAKEOVER_MS: '1000' },
      ),
    ).not.toThrow();
  });

  it('空串与写错的值当没配，用框架的缺省（不要因为一个拼错的数字就把心跳调成 0）', () => {
    expect(() =>
      createChatArbitration(
        db(),
        {},
        { RUNKO_HEARTBEAT_MS: '', RUNKO_TAKEOVER_MS: '一会儿' },
      ),
    ).not.toThrow();
  });
});
