/**
 * 会话对象那几条只有 Cloudflare 才有的路：对象被平台重启后靠 alarm 叫醒、自己收尾；
 * 以及这台服务端按绑定与配置报出的能力开关。
 */
import { abortAllDurableObjects, runDurableObjectAlarm } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import { capabilitiesOf } from '../src/app.js';
import type { Env } from '../src/env.js';
import {
  createConversation,
  detail,
  listed,
  replay,
  send,
  signUp,
  textOf,
  waitIdle,
} from './helpers.js';

describe('对象被重启之后', () => {
  it('没有任何请求，alarm 叫醒新实例：补上「已中断」，排着的消息接着跑，列表状态跟着回写', async () => {
    const cookie = await signUp('evict');
    const id = await createConversation(cookie, 'evict');
    expect(await send(cookie, id, 'y'.repeat(2_000))).toBe('started');
    expect(await send(cookie, id, 'after eviction')).toBe('queued');
    expect((await detail(cookie, id)).turnInProgress).toBe(true);

    // 模拟部署或平台迁移：实例当场丢掉，存储留着。（`evictDurableObject` 是体面回收，
    // 会等演示模型那些定时器走完——这一轮就跑完了，测不到中断。）
    await abortAllDurableObjects();
    const stub = env.CONVERSATION.get(env.CONVERSATION.idFromName(id));
    // 起轮时设的定时唤醒：不等它真到点，直接让它跑。
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await waitIdle(cookie, id);
    const messages = await replay(cookie, id);
    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(messages[1]?.metadata?.status).toBe('interrupted');
    expect(textOf(messages[2])).toBe('after eviction');
    expect(messages[3]?.metadata?.status).toBe('completed');

    await vi.waitFor(async () => {
      const row = await listed(cookie, id);
      expect(row?.turnInProgress).toBe(false);
      expect(row?.queuedMessages).toEqual([]);
    });
  });
});

describe('对象被重启之后（身后没有排队的消息）', () => {
  it('补上「已中断」后没有新的一轮，列表状态也回写成「没在跑」', async () => {
    const cookie = await signUp('evict-alone');
    const id = await createConversation(cookie, 'evict-alone');
    // 只有一个会话时列表直接问会话对象；两个以上才读 D1 里的列表状态副本，这里测的是后者。
    await createConversation(cookie, 'evict-alone-2');
    expect(await send(cookie, id, 'z'.repeat(2_000))).toBe('started');
    await vi.waitFor(async () => {
      expect((await listed(cookie, id))?.turnInProgress).toBe(true);
    });

    await abortAllDurableObjects();
    const stub = env.CONVERSATION.get(env.CONVERSATION.idFromName(id));
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await waitIdle(cookie, id);
    const messages = await replay(cookie, id);
    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(messages[1]?.metadata?.status).toBe('interrupted');
    await vi.waitFor(async () => {
      expect((await listed(cookie, id))?.turnInProgress).toBe(false);
    });
  });
});

describe('capabilitiesOf', () => {
  const sandbox = {} as NonNullable<Env['Sandbox']>;
  const githubApp = {
    GITHUB_APP_ID: '1',
    GITHUB_APP_SLUG: 'runko',
    GITHUB_APP_PRIVATE_KEY: 'key',
    GITHUB_CLIENT_ID: 'id',
    GITHUB_CLIENT_SECRET: 'secret',
  };

  function envWith(extra: Record<string, unknown>): Env {
    return { ...env, Sandbox: undefined, ...extra } as Env;
  }

  it('没有沙盒绑定：只有本地沙盒', () => {
    expect(capabilitiesOf(envWith(githubApp))).toEqual({
      providers: ['local'],
      defaultProvider: 'local',
      model: 'demo',
      clusterConsole: false,
    });
  });

  it('有沙盒绑定但没配 GitHub App：建不成云沙盒会话，所以不提供', () => {
    expect(capabilitiesOf(envWith({ Sandbox: sandbox })).providers).toEqual([
      'local',
    ]);
  });

  it('绑定与 GitHub App 都在：两档都有，缺省 Cloudflare 沙盒；SANDBOX_PROVIDER 可以改缺省', () => {
    const both = capabilitiesOf(envWith({ Sandbox: sandbox, ...githubApp }));
    expect(both.providers).toEqual(['cloudflare', 'local']);
    expect(both.defaultProvider).toBe('cloudflare');
    expect(
      capabilitiesOf(
        envWith({ Sandbox: sandbox, ...githubApp, SANDBOX_PROVIDER: 'local' }),
      ).defaultProvider,
    ).toBe('local');
  });

  it('CLOUDFLARE_SANDBOX=off 关掉云沙盒；配了模型就报 deepseek', () => {
    const off = capabilitiesOf(
      envWith({
        Sandbox: sandbox,
        ...githubApp,
        CLOUDFLARE_SANDBOX: 'off',
        DEEPSEEK_API_BASE_URL: 'https://api.example.com',
        DEEPSEEK_API_TOKEN: 'token',
      }),
    );
    expect(off.providers).toEqual(['local']);
    expect(off.model).toBe('deepseek');
  });
});
