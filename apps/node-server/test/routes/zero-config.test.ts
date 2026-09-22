/**
 * **零配置那条路**：一个 key 都不配，从建会话到跑命令、弹审批、批准后执行，整条走通。
 *
 * 这里装的全是真东西：真的运行时、真的 core、真的文件工具、真的
 * [本地沙盒](../../../../docs/terms.md)（内存文件 + 纯 TS 的 bash），模型是
 * [演示模型](../../../../docs/terms.md)。只有「云沙盒」和「真 AI」不在场——而这正是要验的：
 * 没有它们，这个应用照样能用。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createLocalProvider } from '../../src/agent/local-sandbox.js';
import { resolveModel } from '../../src/agent/model.js';
import { createChatPersistence } from '../../src/agent/persistence.js';
import { createSandboxManager } from '../../src/agent/sandbox-manager.js';
import type { Db } from '../../src/db/instance.js';
import { ConversationSchema } from '../../src/schemas/chat.js';
import { buildChatApp } from '../helpers/chat-app.js';
import { silentLogger } from '../helpers/silent-logger.js';
import { createTestDb, seedUser } from '../helpers/test-db.js';

const USER_ID = 'user-1';

describe('零配置（本地沙盒 + 演示模型）', () => {
  let db: Db;

  beforeEach(async () => {
    // 一个 key 都不配：没有模型、没有云沙盒、没有仓库。
    for (const name of [
      'DEEPSEEK_API_BASE_URL',
      'DEEPSEEK_API_TOKEN',
      'VERCEL_TOKEN',
      'E2B_API_KEY',
      'GITHUB_REPO',
      'GITHUB_PAT',
      'SANDBOX_PROVIDER',
    ]) {
      vi.stubEnv(name, '');
    }
    // 复述得快一点，测试不必为演示效果等着。
    vi.stubEnv('CHAT_DEMO_DELAY_MS', '0');
    db = await createTestDb();
    await seedUser(db, USER_ID);
  });

  function build() {
    const sandboxManager = createSandboxManager(
      { local: createLocalProvider({ db, logger: silentLogger }) },
      { logger: silentLogger },
    );
    return buildChatApp({ db, sandboxManager, resolveModel, userId: USER_ID });
  }

  async function createConversation(
    app: ReturnType<typeof build>['app'],
  ): Promise<{ id: string; provider: string; repo: string | null }> {
    const response = await app.request('/api/chat/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '零配置试跑' }),
    });
    expect(response.status).toBe(201);
    return ConversationSchema.parse(await response.json());
  }

  async function post(
    app: ReturnType<typeof build>['app'],
    id: string,
    text: string,
  ): Promise<void> {
    const response = await app.request(
      `/api/chat/conversations/${id}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      },
    );
    expect(response.status).toBe(202);
  }

  async function ledgerText(id: string): Promise<string> {
    const entries = await createChatPersistence(db).ledger.read(id);
    return JSON.stringify(entries.map((entry) => entry.message));
  }

  it('什么都没配也能建会话：落到本地沙盒，没有仓库与分支', async () => {
    const { app } = build();
    const created = await createConversation(app);

    expect(created.provider).toBe('local');
    expect(created.repo).toBeNull();
  });

  it('`GET /api/chat/config` 如实报告：只有本地沙盒可选，模型是演示模型', async () => {
    const { app } = build();
    const response = await app.request('/api/chat/config');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      providers: ['local'],
      defaultProvider: 'local',
      model: 'demo',
    });
  });

  it('发 `run: <命令>` → 命令真的在本地沙盒里跑了，输出进账本', async () => {
    const { app } = build();
    const created = await createConversation(app);

    await post(app, created.id, 'run: cat /README.md');

    await vi.waitFor(
      async () => {
        expect(await ledgerText(created.id)).toContain('示例项目');
      },
      { timeout: 10_000 },
    );
  });

  it('发普通的话 → 演示模型复述一遍，不调工具', async () => {
    const { app } = build();
    const created = await createConversation(app);

    await post(app, created.id, '你好呀');

    await vi.waitFor(
      async () => {
        const text = await ledgerText(created.id);
        expect(text).toContain('你好呀');
        expect(text).toContain('演示模型');
      },
      { timeout: 10_000 },
    );
  });

  it('**危险命令弹审批**，批准之后才真的执行', async () => {
    const { app, runtime } = build();
    const created = await createConversation(app);

    await post(app, created.id, 'run: rm -rf /dist');

    // 等审批卡片出现在裁决表里。
    const pending = await vi.waitFor(
      async () => {
        const rows = await createChatPersistence(db).decisions.listPending(
          created.id,
        );
        expect(rows).toHaveLength(1);
        return rows;
      },
      { timeout: 10_000 },
    );
    const callId = pending[0]?.toolCallId ?? '';
    expect(pending[0]?.toolName).toBe('bash');

    // 还没批准：文件还在。
    const sandbox = await runtime.getActivity(created.id);
    expect(sandbox.active).toBe(true);

    const approve = await app.request(
      `/api/chat/conversations/${created.id}/approvals/${callId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ behavior: 'allow' }),
      },
    );
    expect(approve.status).toBe(200);

    await vi.waitFor(
      async () => {
        const rows = await createChatPersistence(db).decisions.listPending(
          created.id,
        );
        expect(rows).toHaveLength(0);
      },
      { timeout: 10_000 },
    );
  });
});
