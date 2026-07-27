/**
 * `onTurnSettled` 交出的「这一轮是怎么结束的」（`TurnSettledInfo`，
 * docs/tech/push-notification.md §3.3、§4）。
 *
 * 这是运行内核为推送通知让出的**唯一**一处扩展——四个取值必须准，否则「跑完了」
 * 和「这一轮没跑完」会报反。
 */
import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../../src/agent/store.js';
import { createConversation } from '../../src/agent/store.js';
import type { TurnSettledInfo } from '../../src/agent/turn-runner.js';
import { startTurn } from '../../src/agent/turn-runner.js';
import { createControllableSession } from '../helpers/controllable-session.js';
import { silentLogger } from '../helpers/silent-logger.js';
import { createTestDb, seedUser } from '../helpers/test-db.js';

describe('turn-runner —— TurnSettledInfo', () => {
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

  /** 起一轮、等它收尾，返回 `onTurnSettled` 收到的那个 info。 */
  function runTurn(
    drive: (fake: ReturnType<typeof createControllableSession>) => void,
  ): Promise<TurnSettledInfo> {
    const fake = createControllableSession();
    return new Promise<TurnSettledInfo>((resolve) => {
      startTurn({
        db,
        conversationId,
        session: fake,
        text: 'hi',
        priorMessageCount: 0,
        logger: silentLogger,
        onTurnSettled: resolve,
      });
      drive(fake);
    });
  }

  it('正常收尾 + 最后一个 message-metadata 是 completed → completed', async () => {
    const settled = await runTurn((fake) => {
      fake.pushChunk({
        type: 'message-metadata',
        messageMetadata: { turn: 1, usage: {}, status: 'completed' },
      });
      fake.finish({ finalResponse: 'ok', usage: {} });
    });
    expect(settled).toEqual({ status: 'completed' });
  });

  it('优雅降级（core 自己报 failed）→ failed，不是 crashed', async () => {
    const settled = await runTurn((fake) => {
      fake.pushChunk({
        type: 'message-metadata',
        messageMetadata: {
          turn: 1,
          usage: {},
          status: 'failed',
          error: { code: 'provider_error', message: '模型挂了' },
        },
      });
      fake.finish({ finalResponse: 'ok', usage: {} });
    });
    expect(settled).toEqual({ status: 'failed' });
  });

  it('被停止 → interrupted', async () => {
    const settled = await runTurn((fake) => {
      fake.pushChunk({
        type: 'message-metadata',
        messageMetadata: { turn: 1, usage: {}, status: 'interrupted' },
      });
      fake.finish({ finalResponse: 'ok', usage: {} });
    });
    expect(settled).toEqual({ status: 'interrupted' });
  });

  it('一个 metadata 都没见到也算正常收尾（缺可选字段 ≠ 失败）', async () => {
    const settled = await runTurn((fake) => {
      fake.finish({ finalResponse: 'ok', usage: {} });
    });
    expect(settled).toEqual({ status: 'completed' });
  });

  it('generator 直接抛 → crashed（与 core 报的 failed 分开，排查方向不同）', async () => {
    const settled = await runTurn((fake) => {
      fake.fail(new Error('boom'));
    });
    expect(settled).toEqual({ status: 'crashed' });
  });

  it('取的是**最后**一个 metadata，不是第一个', async () => {
    const settled = await runTurn((fake) => {
      fake.pushChunk({
        type: 'message-metadata',
        messageMetadata: { turn: 1, usage: {}, status: 'completed' },
      });
      fake.pushChunk({
        type: 'message-metadata',
        messageMetadata: { turn: 1, usage: {}, status: 'interrupted' },
      });
      fake.finish({ finalResponse: 'ok', usage: {} });
    });
    expect(settled).toEqual({ status: 'interrupted' });
  });
});
