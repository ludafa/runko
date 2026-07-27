/**
 * 推送通知在起轮链路上的接线（docs/tech/push-notification.md §4）——跑的是真
 * `launchTurn` + 真 core loop（模型/沙盒是假件），因为要验的两件事都只有在真链路上
 * 才成立：
 *
 * 1. **通知排在出队之前**——队列抑制（§5.3）读的是"这一轮结束时队列里还有没有货"，
 *    而 `startNextQueuedTurn` 的第一件事就是出队。顺序反了，最后一条排队消息起轮时
 *    队列刚好空了，就会误报一次「跑完了」。
 * 2. **通知抛错绝不影响一轮**（§9 不变量 1、2）。
 */
import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../../src/agent/store.js';
import {
  createConversation,
  enqueueMessage,
  getConversation,
  listQueuedMessages,
} from '../../src/agent/store.js';
import { launchTurn } from '../../src/agent/turn-launcher.js';
import type { ChatNotifier, TurnEndStatus } from '../../src/push/notifier.js';
import type { FakeSandboxManager } from '../helpers/fake-sandbox-manager.js';
import { createFakeSandboxManager } from '../helpers/fake-sandbox-manager.js';
import { stopOnlyModel } from '../helpers/mock-model.js';
import { silentLogger } from '../helpers/silent-logger.js';
import { createTestDb, seedUser } from '../helpers/test-db.js';

const USER_ID = 'user-1';

/** 等这一轮彻底跑完——收尾的可观测信号是会话行的 `agentSessionId` 被写上。 */
async function waitForTurnToSettle(
  db: Db,
  conversationId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const row = getConversation(db, conversationId, USER_ID);
    if (row?.agentSessionId != null) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('turn did not settle in time');
}

describe('agent/turn-launcher：推送通知接线', () => {
  let db: Db;
  let sandboxManager: FakeSandboxManager;
  let conversationId: string;

  beforeEach(() => {
    vi.stubEnv('GITHUB_REPO', 'git@github.com:acme/demo.git');
    vi.stubEnv('GITHUB_PAT', 'test-pat');
    db = createTestDb();
    seedUser(db, USER_ID);
    sandboxManager = createFakeSandboxManager();
    conversationId = randomUUID();
    createConversation(db, {
      id: conversationId,
      userId: USER_ID,
      title: 'Session',
      repo: 'acme/demo',
      branchName: `nimbo/chat-${conversationId}`,
      sandboxName: `nimbo-chat-${conversationId}`,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function launch(notifier: ChatNotifier): Promise<unknown> {
    return launchTurn(
      {
        db,
        sandboxManager,
        resolveModel: () => stopOnlyModel('done'),
        notifier,
        logger: silentLogger,
      },
      { conversationId, userId: USER_ID, text: '干活' },
    );
  }

  it('一轮跑完，notifier 收到 status: completed', async () => {
    const seen: TurnEndStatus[] = [];
    const notifier: ChatNotifier = {
      approvalPending: () => {},
      questionPending: () => {},
      turnSettled: (input) => seen.push(input.status),
    };

    const outcome = await launch(notifier);
    expect(outcome).toEqual({ ok: true });
    await waitForTurnToSettle(db, conversationId);

    expect(seen).toEqual(['completed']);
  });

  it('通知排在出队之前：被调用的那一刻，排队消息还在队列里', async () => {
    // 队列里先放一条：这一轮收尾后 `startNextQueuedTurn` 会把它取走再起第二轮，
    // 所以 `turnSettled` 会被调**两次**——记全部，看的是第一次那个数。
    const queueLengths: number[] = [];
    const notifier: ChatNotifier = {
      approvalPending: () => {},
      questionPending: () => {},
      turnSettled: () => {
        queueLengths.push(
          listQueuedMessages(db, conversationId, silentLogger).length,
        );
      },
    };

    enqueueMessage(db, conversationId, { userId: USER_ID, text: '下一件事' });
    await launch(notifier);
    // 等到第二轮也收尾（`turnSettled` 出现两次）——否则可能只看到第一次就断言完了。
    for (let attempt = 0; attempt < 400 && queueLengths.length < 2; attempt++) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    // 第一次 = 1：通知发生在出队之前，notifier 因此能正确抑制这条「跑完了」。
    // 是 0 就意味着接线顺序反了（先出队后通知），用户会被误报一次。
    expect(queueLengths[0]).toBe(1);
    // 第二次 = 0：队列真空了，这一次才该发「跑完了」。
    expect(queueLengths[1]).toBe(0);
  });

  it('notifier 每个方法都抛错，一轮照常跑完并正常落库', async () => {
    const exploding: ChatNotifier = {
      approvalPending: () => {
        throw new Error('boom');
      },
      questionPending: () => {
        throw new Error('boom');
      },
      turnSettled: () => {
        throw new Error('boom');
      },
    };

    const outcome = await launch(exploding);
    expect(outcome).toEqual({ ok: true });
    await waitForTurnToSettle(db, conversationId);

    const row = getConversation(db, conversationId, USER_ID);
    expect(row?.agentSessionId).not.toBeNull();
    expect(row?.agentSessionTurn).toBe(1);
  });

  it('不注入 notifier 时一切照旧（缺席是合法配置）', async () => {
    const outcome = await launchTurn(
      {
        db,
        sandboxManager,
        resolveModel: () => stopOnlyModel('done'),
        logger: silentLogger,
      },
      { conversationId, userId: USER_ID, text: '干活' },
    );
    expect(outcome).toEqual({ ok: true });
    await waitForTurnToSettle(db, conversationId);
    expect(
      getConversation(db, conversationId, USER_ID)?.agentSessionId,
    ).not.toBeNull();
  });
});
