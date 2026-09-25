/**
 * [运维容器](../../../../docs/terms.md)的三个接口（`src/ops/app.ts`）。设计见
 * docs/host/node/tech/cluster-console.md §7；施工验收见 docs/host/node/plans/cluster-console.md O3。
 *
 * 用一个内存里的假 `DockerClient` 驱动——不碰真的 docker.sock（`docker.ts` 的
 * unix socket 客户端另有 `test/ops/docker.test.ts` 覆盖）。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { createOpsApp } from '../../src/ops/app.js';
import type {
  DockerClient,
  DockerContainerSummary,
} from '../../src/ops/docker.js';
import type { OpsNode } from '../../src/ops/schema.js';
import { silentLogger } from '../helpers/silent-logger.js';

const TOKEN = 'ops-secret-token';
const NOW = 1_700_000_000_000;
const STOP_TIMEOUT_S = 120;

const NODE_A_ID =
  'a1a2a3a4a5a6a7a8a9b0b1b2b3b4b5b6b7b8b9c0c1c2c3c4c5c6c7c8c9d0d1d2';
const NODE_A_SHORT = NODE_A_ID.slice(0, 12);

/** 内存里的假 Docker：状态与 stop/start 调用都记在这里，供断言用。 */
class FakeDockerClient implements DockerClient {
  containers: DockerContainerSummary[] = [];
  stopCalls: { id: string; timeoutS: number }[] = [];
  startCalls: string[] = [];
  /** 注入失败：某次 `stopContainer`/`startContainer` 该不该 reject。 */
  stopShouldFail = false;
  startShouldFail = false;

  listContainers(): Promise<DockerContainerSummary[]> {
    return Promise.resolve(this.containers);
  }

  stopContainer(id: string, timeoutS: number): Promise<void> {
    this.stopCalls.push({ id, timeoutS });
    if (this.stopShouldFail) {
      return Promise.reject(new Error('docker stop failed'));
    }
    return Promise.resolve();
  }

  startContainer(id: string): Promise<void> {
    this.startCalls.push(id);
    if (this.startShouldFail) {
      return Promise.reject(new Error('docker start failed'));
    }
    return Promise.resolve();
  }
}

/** 等一轮微任务：`app.ts` 里 `void deps.docker.stop/startContainer(...).catch(...)` 不等它，
 * 测试要断言失败分支时得先放行这些排好队的 promise。 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function buildApp(docker: FakeDockerClient) {
  return createOpsApp({
    docker,
    token: TOKEN,
    stopTimeoutS: STOP_TIMEOUT_S,
    now: () => NOW,
    logger: silentLogger,
  });
}

async function getNodes(
  app: ReturnType<typeof buildApp>,
  headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` },
): Promise<{ status: number; body: OpsNode[] }> {
  const res = await app.request('http://ops/nodes', { headers });
  return { status: res.status, body: (await res.json()) as OpsNode[] };
}

describe('ops/app: 鉴权', () => {
  let docker: FakeDockerClient;

  beforeEach(() => {
    docker = new FakeDockerClient();
    docker.containers = [{ id: NODE_A_ID, state: 'running', index: 1 }];
  });

  it('/health 不带任何头也能过，不鉴权', async () => {
    const app = buildApp(docker);
    const res = await app.request('http://ops/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('无 Authorization 头 → 401', async () => {
    const app = buildApp(docker);
    const res = await app.request('http://ops/nodes');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('格式不对（缺 Bearer 前缀）→ 401', async () => {
    const app = buildApp(docker);
    const res = await app.request('http://ops/nodes', {
      headers: { authorization: TOKEN },
    });
    expect(res.status).toBe(401);
  });

  it('令牌错 → 401', async () => {
    const app = buildApp(docker);
    const res = await app.request('http://ops/nodes', {
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('大小写不同（bearer 小写）→ 401', async () => {
    const app = buildApp(docker);
    const res = await app.request('http://ops/nodes', {
      headers: { authorization: `bearer ${TOKEN}` },
    });
    expect(res.status).toBe(401);
  });

  it('令牌对 → 200', async () => {
    const app = buildApp(docker);
    const { status } = await getNodes(app);
    expect(status).toBe(200);
  });
});

describe('ops/app: {id} 匹配（完整 id / 前 12 位 / 其他子串）', () => {
  let docker: FakeDockerClient;

  beforeEach(() => {
    docker = new FakeDockerClient();
    docker.containers = [{ id: NODE_A_ID, state: 'running', index: 1 }];
  });

  it('完整 id 命中', async () => {
    const app = buildApp(docker);
    const res = await app.request(`http://ops/nodes/${NODE_A_ID}/offline`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(202);
  });

  it('前 12 位命中', async () => {
    const app = buildApp(docker);
    const res = await app.request(`http://ops/nodes/${NODE_A_SHORT}/offline`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(202);
  });

  it('其他子串（既非完整 id 也非前 12 位）→ 404', async () => {
    const app = buildApp(docker);
    const middleSlice = NODE_A_ID.slice(10, 22); // 长度一样，但不是前 12 位
    const res = await app.request(`http://ops/nodes/${middleSlice}/offline`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown node id' });
  });

  it('完全不存在的 id → 404（online 同理）', async () => {
    const app = buildApp(docker);
    const res = await app.request('http://ops/nodes/no-such-id/online', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('ops/app: GET /nodes 状态推导四象限', () => {
  let docker: FakeDockerClient;

  beforeEach(() => {
    docker = new FakeDockerClient();
  });

  it('running 且不在下线表 → online', async () => {
    docker.containers = [{ id: NODE_A_ID, state: 'running', index: 2 }];
    const app = buildApp(docker);
    const { body } = await getNodes(app);
    expect(body).toEqual([
      {
        id: NODE_A_ID,
        shortId: NODE_A_SHORT,
        index: 2,
        url: `http://${NODE_A_SHORT}:3900`,
        state: 'online',
        dockerState: 'running',
        offlineDeadline: null,
      },
    ]);
  });

  it('running 且在下线表 → going_offline，deadline = now + stopTimeoutS*1000', async () => {
    docker.containers = [{ id: NODE_A_ID, state: 'running', index: 2 }];
    const app = buildApp(docker);

    const offlineRes = await app.request(
      `http://ops/nodes/${NODE_A_ID}/offline`,
      { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(offlineRes.status).toBe(202);
    expect(await offlineRes.json()).toEqual({
      ok: true,
      offlineDeadline: NOW + STOP_TIMEOUT_S * 1000,
    });
    expect(docker.stopCalls).toEqual([
      { id: NODE_A_ID, timeoutS: STOP_TIMEOUT_S },
    ]);

    const { body } = await getNodes(app);
    expect(body[0]).toMatchObject({
      state: 'going_offline',
      offlineDeadline: NOW + STOP_TIMEOUT_S * 1000,
    });
  });

  it.each(['exited', 'dead', 'created'])(
    'docker 状态 %s → offline，且下线表被清',
    async (dockerState) => {
      docker.containers = [{ id: NODE_A_ID, state: 'running', index: 2 }];
      const app = buildApp(docker);
      await app.request(`http://ops/nodes/${NODE_A_ID}/offline`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
      });

      // 容器实际已经停了：下一次 GET /nodes 时 docker 报的状态已经变了。
      docker.containers = [{ id: NODE_A_ID, state: dockerState, index: 2 }];
      const { body } = await getNodes(app);
      expect(body[0]).toMatchObject({
        state: 'offline',
        offlineDeadline: null,
        dockerState,
      });

      // 下线表已清：即便 docker 状态又变回 running（比如重新上线），也不会残留
      // 上一轮的 offlineDeadline。
      docker.containers = [{ id: NODE_A_ID, state: 'running', index: 2 }];
      const { body: bodyAfter } = await getNodes(app);
      expect(bodyAfter[0]).toMatchObject({
        state: 'online',
        offlineDeadline: null,
      });
    },
  );

  it.each(['restarting', 'paused'])(
    '其他 docker 状态 %s → unknown，dockerState 原样透出',
    async (dockerState) => {
      docker.containers = [{ id: NODE_A_ID, state: dockerState, index: 2 }];
      const app = buildApp(docker);
      const { body } = await getNodes(app);
      expect(body[0]).toMatchObject({
        state: 'unknown',
        dockerState,
        offlineDeadline: null,
      });
    },
  );
});

describe('ops/app: POST offline 幂等', () => {
  it('重复下线返回原 deadline，不再调一次 stop', async () => {
    const docker = new FakeDockerClient();
    docker.containers = [{ id: NODE_A_ID, state: 'running', index: 1 }];
    const app = buildApp(docker);

    const first = await app.request(`http://ops/nodes/${NODE_A_ID}/offline`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const firstBody = (await first.json()) as { offlineDeadline: number };

    const second = await app.request(`http://ops/nodes/${NODE_A_ID}/offline`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const secondBody = (await second.json()) as { offlineDeadline: number };

    expect(second.status).toBe(202);
    expect(secondBody.offlineDeadline).toBe(firstBody.offlineDeadline);
    expect(docker.stopCalls).toHaveLength(1);
  });
});

describe('ops/app: stop 失败后状态回到 online', () => {
  it('docker stop reject → 下线表被撤，下一次 GET /nodes 显示 online', async () => {
    const docker = new FakeDockerClient();
    docker.containers = [{ id: NODE_A_ID, state: 'running', index: 1 }];
    docker.stopShouldFail = true;
    const app = buildApp(docker);

    const res = await app.request(`http://ops/nodes/${NODE_A_ID}/offline`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    // 202 本身不等失败——请求是后台跑的，响应先回。
    expect(res.status).toBe(202);

    await flushMicrotasks();

    const { body } = await getNodes(app);
    expect(body[0]).toMatchObject({ state: 'online', offlineDeadline: null });
  });
});

describe('ops/app: POST online', () => {
  it('清下线表并调 start；docker 状态原样带回，返回 202', async () => {
    const docker = new FakeDockerClient();
    docker.containers = [{ id: NODE_A_ID, state: 'running', index: 1 }];
    const app = buildApp(docker);

    await app.request(`http://ops/nodes/${NODE_A_ID}/offline`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    const res = await app.request(`http://ops/nodes/${NODE_A_ID}/online`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(docker.startCalls).toEqual([NODE_A_ID]);

    const { body } = await getNodes(app);
    expect(body[0]).toMatchObject({ state: 'online', offlineDeadline: null });
  });

  it('docker start 失败仍回 202（失败只记日志）', async () => {
    const docker = new FakeDockerClient();
    docker.containers = [{ id: NODE_A_ID, state: 'exited', index: 1 }];
    docker.startShouldFail = true;
    const app = buildApp(docker);

    const res = await app.request(`http://ops/nodes/${NODE_A_ID}/online`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(202);
    await flushMicrotasks();
  });
});
