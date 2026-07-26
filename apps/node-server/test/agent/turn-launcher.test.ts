/**
 * 起轮装配打点（docs/tech/telemetry.md §2.4）的落库验证：`launchTurn` 逐段计时，
 * 经 `turn-runner.ts` 的 `onMilestone` 在这一轮**第一个 chunk 抵达时**写
 * `turn-prepare`、在**第一个可见 chunk** 抵达时写 `turn-first-output`。
 *
 * 这里跑的是真 `launchTurn` + 真 `buildSession` + 真 core loop（模型是
 * `mock-model.ts` 的假件、沙盒是 `fake-sandbox-manager.ts` 的内存假件），因为本功能
 * 最要命的不变量恰恰是**关联键对不对**：遥测按 `(nimbo 会话 id, turn)` 存，而这两个
 * 值在起轮装配阶段根本还不存在（首轮的会话 id 是 `createSession` 现场 mint 的）。
 * 只有让 core 真的跑一轮，才能断言写进去的那把键与 `session.toJSON()` 一致——用假
 * session 替掉这一段，等于把要验的东西验没了。
 */
import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../../src/agent/store.js';
import { createConversation, getConversation } from '../../src/agent/store.js';
import { launchTurn } from '../../src/agent/turn-launcher.js';
import type { TelemetryStore } from '../../src/telemetry.js';
import { createTelemetryStore } from '../../src/telemetry.js';
import type { FakeSandboxManager } from '../helpers/fake-sandbox-manager.js';
import { createFakeSandboxManager } from '../helpers/fake-sandbox-manager.js';
import { stopOnlyModel, toolCallThenStopModel } from '../helpers/mock-model.js';
import { createTestDb, seedUser } from '../helpers/test-db.js';

const USER_ID = 'user-1';

/** 载荷只有数字与一个枚举字符串（§2.4）——按需 parse，不建模成 schema：这是测试断言，不是生产解析。 */
function payloadOf(row: { payloadJson: string }): Record<string, unknown> {
  const parsed: unknown = JSON.parse(row.payloadJson);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`unexpected payload shape: ${row.payloadJson}`);
  }
  return { ...parsed };
}

/**
 * 等这一轮彻底跑完。`launchTurn` 只负责**启动**（不 await 这一轮），而落库发生在
 * 轮进行中，所以断言前必须让出事件循环直到轮收尾——收尾的可观测信号是会话行的
 * `agentSessionId` 被 `finalizeTurnPersistence` 写上。
 */
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

describe('agent/turn-launcher：起轮装配打点', () => {
  let db: Db;
  let sandboxManager: FakeSandboxManager;
  let telemetryStore: TelemetryStore;
  let conversationId: string;

  beforeEach(() => {
    vi.stubEnv('GITHUB_REPO', 'git@github.com:acme/demo.git');
    vi.stubEnv('GITHUB_PAT', 'test-pat');
    db = createTestDb();
    seedUser(db, USER_ID);
    sandboxManager = createFakeSandboxManager();
    telemetryStore = createTelemetryStore(':memory:');
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
    telemetryStore.close();
    vi.unstubAllEnvs();
  });

  it('writes turn-prepare + turn-first-output under (nimbo 会话 id, turn)，载荷含全部分段字段', async () => {
    sandboxManager.nextAcquireMode = 'create';

    const outcome = await launchTurn(
      {
        db,
        sandboxManager,
        resolveModel: () => stopOnlyModel('done'),
        telemetryStore,
      },
      { conversationId, userId: USER_ID, text: 'hi' },
    );
    expect(outcome).toEqual({ ok: true });
    await waitForTurnToSettle(db, conversationId);

    // 关联键：端点就是拿会话行上的 agentSessionId + turn 去查的（routes/chat.ts）。
    const row = getConversation(db, conversationId, USER_ID);
    expect(row?.agentSessionId).toBeTypeOf('string');
    const events = telemetryStore.list(row?.agentSessionId ?? '', 1);
    const byType = new Map(events.map((event) => [event.eventType, event]));

    const prepare = byType.get('turn-prepare');
    expect(prepare).toBeDefined();
    if (prepare === undefined) throw new Error('unreachable');
    const preparePayload = payloadOf(prepare);
    expect(Object.keys(preparePayload).sort()).toEqual([
      'acquireMode',
      'acquireMs',
      'buildSessionMs',
      'firstChunkMs',
      'launchMs',
      'loadStateMs',
      'touchMs',
    ]);
    // `acquireMode` 原样来自 `sandboxManager.acquire()` 的返回。
    expect(preparePayload.acquireMode).toBe('create');
    for (const key of [
      'acquireMs',
      'touchMs',
      'loadStateMs',
      'buildSessionMs',
      'launchMs',
      'firstChunkMs',
    ]) {
      expect(preparePayload[key], key).toBeTypeOf('number');
      expect(preparePayload[key] as number, key).toBeGreaterThanOrEqual(0);
    }

    const firstOutput = byType.get('turn-first-output');
    expect(firstOutput).toBeDefined();
    if (firstOutput === undefined) throw new Error('unreachable');
    expect(payloadOf(firstOutput).firstOutputMs).toBeTypeOf('number');
  });

  it('lands the same two events for a turn whose first visible output is a tool call, not text', async () => {
    const outcome = await launchTurn(
      {
        db,
        sandboxManager,
        resolveModel: () =>
          toolCallThenStopModel(
            'write-file',
            { path: '/notes.txt', content: 'hi' },
            'call_1',
            'wrote it',
          ),
        telemetryStore,
      },
      { conversationId, userId: USER_ID, text: 'write a file' },
    );
    expect(outcome).toEqual({ ok: true });
    await waitForTurnToSettle(db, conversationId);

    const row = getConversation(db, conversationId, USER_ID);
    const eventTypes = telemetryStore
      .list(row?.agentSessionId ?? '', 1)
      .map((event) => event.eventType);
    expect(eventTypes).toContain('turn-prepare');
    expect(eventTypes).toContain('turn-first-output');
  });

  it('drives the turn exactly the same with no telemetryStore injected (遥测缺席不是错误)', async () => {
    const outcome = await launchTurn(
      {
        db,
        sandboxManager,
        resolveModel: () => stopOnlyModel('done'),
      },
      { conversationId, userId: USER_ID, text: 'hi' },
    );
    expect(outcome).toEqual({ ok: true });
    await waitForTurnToSettle(db, conversationId);

    const row = getConversation(db, conversationId, USER_ID);
    expect(row?.agentSessionId).toBeTypeOf('string');
  });

  it('records nothing when the turn never starts (装配阶段就失败——沙盒挂了)', async () => {
    const failing: FakeSandboxManager = Object.assign(
      createFakeSandboxManager(),
      {
        acquire: () => Promise.reject(new Error('sandbox unavailable')),
      },
    );

    const outcome = await launchTurn(
      {
        db,
        sandboxManager: failing,
        resolveModel: () => stopOnlyModel('done'),
        telemetryStore,
      },
      { conversationId, userId: USER_ID, text: 'hi' },
    );

    expect(outcome).toEqual({
      ok: false,
      reason: 'error',
      message: 'sandbox unavailable',
    });
    // 关联键根本没产生过，自然一行也没有——这条路径的可观测性归日志与 500 响应。
    expect(telemetryStore.list(conversationId, 1)).toEqual([]);
  });
});
