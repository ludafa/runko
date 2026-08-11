/**
 * 启动时的[崩溃恢复](../../../../docs/terms.md)（docs/agent/graceful-shutdown/tech.md §5）——
 * [优雅关闭](../../../../docs/terms.md)的第二道防线，覆盖 `kill -9`/OOM/断电这些
 * 「进程没机会执行任何代码」的情形。
 */
import { randomUUID } from 'node:crypto';

import type { NimboChunk, NimboUIMessage } from '@nimbo/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { recoverOrphanedTurns } from '../../src/agent/crash-recovery.js';
import type { Db } from '../../src/agent/store.js';
import {
  appendConversationEvent,
  createConversation,
  listConversationEvents,
} from '../../src/agent/store.js';
import { chunkEnvelopeSchema } from '../../src/schemas/chat.js';
import { silentLogger } from '../helpers/silent-logger.js';
import { createTestDb, seedUser } from '../helpers/test-db.js';

const SHUTDOWN_MESSAGE = 'The server shut down while this turn was running.';

/**
 * 把一行 `kind = 'chunk'` 还原成它代表的 `NimboChunk`——过真 schema，与
 * `routes/chat.ts` 的 `rowToReplayFrame` 同一姿态（`JSON.parse` 的 any 不落进具名变量）。
 */
function parseChunk(row: { seq: number; payloadJson: string }): NimboChunk {
  return chunkEnvelopeSchema.parse({
    seq: row.seq,
    chunk: JSON.parse(row.payloadJson),
  }).chunk;
}

describe('agent/crash-recovery', () => {
  let db: Db;
  let conversationId: string;

  beforeEach(() => {
    db = createTestDb();
    seedUser(db, 'user-1');
    conversationId = randomUUID();
    createConversation(db, {
      id: conversationId,
      userId: 'user-1',
      title: 'Session',
      repo: 'acme/demo',
      branchName: `nimbo/chat-${conversationId}`,
      sandboxName: `nimbo-chat-${conversationId}`,
    });
  });

  /** 一条半截 chunk 行：崩溃时账本就停在这种行上。 */
  function appendChunkRow(seq: number, chunk: NimboChunk): void {
    appendConversationEvent(db, {
      conversationId,
      seq,
      kind: 'chunk',
      payloadJson: JSON.stringify(chunk),
    });
  }

  function appendMessageRow(seq: number, message: NimboUIMessage): void {
    appendConversationEvent(db, {
      conversationId,
      seq,
      kind: 'message',
      payloadJson: JSON.stringify(message),
    });
  }

  it('以 chunk 收尾的会话被判为孤儿轮，补上一条 interrupted 收尾（不删原有 chunk 行）', () => {
    appendMessageRow(1, {
      id: 'm1',
      role: 'user',
      parts: [{ type: 'text', text: '干活' }],
    });
    appendChunkRow(2, { type: 'start' });
    appendChunkRow(3, { type: 'text-start', id: 't1' });

    const result = recoverOrphanedTurns(db, silentLogger);
    expect(result).toEqual({ scanned: 1, recovered: 1 });

    const rows = listConversationEvents(db, conversationId);
    // 原有三行一条不少（那些 chunk 是这一轮唯一的内容记录，删了界面就空了）。
    expect(rows).toHaveLength(4);
    expect(rows.slice(0, 3).map((row) => row.seq)).toEqual([1, 2, 3]);

    const added = rows.at(-1);
    expect(added).toBeDefined();
    if (added === undefined) return;
    expect(added.kind).toBe('chunk');
    expect(added.seq).toBe(4);
    const chunk = parseChunk(added);
    expect(chunk.type).toBe('message-metadata');
    expect(
      chunk.type === 'message-metadata' ? chunk.messageMetadata : undefined,
    ).toMatchObject({
      status: 'interrupted',
      error: { code: 'aborted', message: SHUTDOWN_MESSAGE },
    });
  });

  it('幂等：补过一次之后再跑不会重复追加', () => {
    appendChunkRow(1, { type: 'start' });

    expect(recoverOrphanedTurns(db, silentLogger).recovered).toBe(1);
    expect(recoverOrphanedTurns(db, silentLogger).recovered).toBe(0);
    expect(recoverOrphanedTurns(db, silentLogger).recovered).toBe(0);

    expect(listConversationEvents(db, conversationId)).toHaveLength(2);
  });

  it('优雅收尾过的会话（以 message 行收尾）不被碰', () => {
    appendMessageRow(1, {
      id: 'm1',
      role: 'user',
      parts: [{ type: 'text', text: '干活' }],
    });
    appendMessageRow(2, {
      id: 'm2',
      role: 'assistant',
      parts: [{ type: 'text', text: '干完了', state: 'done' }],
      metadata: { status: 'completed' },
    });

    expect(recoverOrphanedTurns(db, silentLogger)).toEqual({
      scanned: 1,
      recovered: 0,
    });
    expect(listConversationEvents(db, conversationId)).toHaveLength(2);
  });

  // `driveTurn` 的 catch 分支（provider 抛错）也会留下「以 chunk 收尾」的账本，但那条
  // chunk 是一条 `status: 'failed'` 的收尾 metadata——这一轮**已经有交代了**，再补一条
  // 「服务重启中断」就成了撒谎。
  it('已失败收尾的会话不被当成孤儿轮（最后那条 chunk 是 failed metadata）', () => {
    appendChunkRow(1, { type: 'start' });
    appendChunkRow(2, {
      type: 'message-metadata',
      messageMetadata: {
        usage: {},
        status: 'failed',
        error: { code: 'provider_error', message: 'boom' },
      },
    });

    expect(recoverOrphanedTurns(db, silentLogger).recovered).toBe(0);
    expect(listConversationEvents(db, conversationId)).toHaveLength(2);
  });

  it('空会话（从没发过消息）不被碰', () => {
    expect(recoverOrphanedTurns(db, silentLogger)).toEqual({
      scanned: 1,
      recovered: 0,
    });
    expect(listConversationEvents(db, conversationId)).toEqual([]);
  });

  it('多个会话各自判断：只有孤儿的那个被补', () => {
    const healthyId = randomUUID();
    createConversation(db, {
      id: healthyId,
      userId: 'user-1',
      title: 'Healthy',
      repo: 'acme/demo',
      branchName: `nimbo/chat-${healthyId}`,
      sandboxName: `nimbo-chat-${healthyId}`,
    });
    appendConversationEvent(db, {
      conversationId: healthyId,
      seq: 1,
      kind: 'message',
      payloadJson: JSON.stringify({
        id: 'm1',
        role: 'assistant',
        parts: [],
        metadata: { status: 'completed' },
      }),
    });
    appendChunkRow(1, { type: 'start' });

    expect(recoverOrphanedTurns(db, silentLogger)).toEqual({
      scanned: 2,
      recovered: 1,
    });
    expect(listConversationEvents(db, healthyId)).toHaveLength(1);
    expect(listConversationEvents(db, conversationId)).toHaveLength(2);
  });
});
