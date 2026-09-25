/**
 * [运维容器](../../../../docs/terms.md)跟 Docker 引擎说话的最小客户端（`src/ops/docker.ts`）。
 * 设计见 docs/host/node/tech/cluster-console.md §7.2。
 *
 * 用一个临时 unix socket 上的假 HTTP 服务器顶替真的 `docker.sock`——不装 dockerode、
 * 不需要真 Docker daemon。socket 文件放 `os.tmpdir()`，每个用例起停一遍，测完删掉。
 */
import { randomBytes } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createDockerClient,
  DockerApiError,
  resolveOwnComposeProject,
} from '../../src/ops/docker.js';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

let socketPath: string;
let server: http.Server | undefined;

function startServer(handler: Handler): Promise<void> {
  return new Promise((resolve, reject) => {
    server = http.createServer(handler);
    server.on('error', reject);
    server.listen(socketPath, resolve);
  });
}

beforeEach(() => {
  // macOS 的 `sun_path` 上限是 104 字节，`os.tmpdir()` 自己就占了大半，文件名
  // 必须尽量短（不能用完整 UUID，会超限报 EINVAL）。
  socketPath = join(tmpdir(), `ro-${randomBytes(4).toString('hex')}.sock`);
});

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
    server = undefined;
  }
  if (existsSync(socketPath)) {
    unlinkSync(socketPath);
  }
});

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

describe('ops/docker: listContainers 的 filters 与 label 解析', () => {
  it('filters 带上 project + service label，label 里的序号被解析成数字', async () => {
    let capturedUrl: string | undefined;
    await startServer((req, res) => {
      capturedUrl = req.url;
      sendJson(res, 200, [
        {
          Id: 'a'.repeat(64),
          State: 'running',
          Labels: { 'com.docker.compose.container-number': '2' },
        },
        {
          // 没有序号 label：解析成 null，不该抛错。
          Id: 'b'.repeat(64),
          State: 'exited',
        },
      ]);
    });

    const client = createDockerClient({
      project: 'runko-cluster',
      service: 'node',
      socketPath,
    });
    const containers = await client.listContainers();

    expect(capturedUrl).toContain('/containers/json?all=1&filters=');
    const parsedUrl = new URL(`http://x${capturedUrl}`);
    const filters: unknown = JSON.parse(
      parsedUrl.searchParams.get('filters') ?? '{}',
    );
    expect(filters).toEqual({
      label: [
        'com.docker.compose.project=runko-cluster',
        'com.docker.compose.service=node',
      ],
    });

    expect(containers).toEqual([
      { id: 'a'.repeat(64), state: 'running', index: 2 },
      { id: 'b'.repeat(64), state: 'exited', index: null },
    ]);
  });

  it('label 的值非数字时也解析成 null', async () => {
    await startServer((_req, res) => {
      sendJson(res, 200, [
        {
          Id: 'c'.repeat(64),
          State: 'running',
          Labels: { 'com.docker.compose.container-number': 'not-a-number' },
        },
      ]);
    });
    const client = createDockerClient({
      project: 'p',
      service: 'node',
      socketPath,
    });
    const containers = await client.listContainers();
    expect(containers[0]?.index).toBeNull();
  });

  it('非 200 抛 DockerApiError', async () => {
    await startServer((_req, res) => {
      sendJson(res, 500, { message: 'daemon error' });
    });
    const client = createDockerClient({
      project: 'p',
      service: 'node',
      socketPath,
    });
    await expect(client.listContainers()).rejects.toBeInstanceOf(
      DockerApiError,
    );
  });
});

describe('ops/docker: stopContainer 的 t 参数与状态分支', () => {
  it('t 参数等于传入的 timeoutS', async () => {
    let capturedUrl: string | undefined;
    let capturedMethod: string | undefined;
    await startServer((req, res) => {
      capturedUrl = req.url;
      capturedMethod = req.method;
      res.writeHead(204);
      res.end();
    });
    const client = createDockerClient({
      project: 'p',
      service: 'node',
      socketPath,
    });
    await client.stopContainer('container-1', 120);
    expect(capturedMethod).toBe('POST');
    expect(capturedUrl).toBe('/containers/container-1/stop?t=120');
  });

  it('204（已停下）算成功', async () => {
    await startServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    const client = createDockerClient({
      project: 'p',
      service: 'node',
      socketPath,
    });
    await expect(
      client.stopContainer('container-1', 120),
    ).resolves.toBeUndefined();
  });

  it('304（本来就没在跑）也算成功', async () => {
    await startServer((_req, res) => {
      res.writeHead(304);
      res.end();
    });
    const client = createDockerClient({
      project: 'p',
      service: 'node',
      socketPath,
    });
    await expect(
      client.stopContainer('container-1', 120),
    ).resolves.toBeUndefined();
  });

  it('404（容器不存在）抛 DockerApiError', async () => {
    await startServer((_req, res) => {
      sendJson(res, 404, { message: 'no such container' });
    });
    const client = createDockerClient({
      project: 'p',
      service: 'node',
      socketPath,
    });
    await expect(
      client.stopContainer('container-1', 120),
    ).rejects.toBeInstanceOf(DockerApiError);
  });
});

describe('ops/docker: startContainer', () => {
  it('204/304 成功，其余抛 DockerApiError', async () => {
    let capturedUrl: string | undefined;
    await startServer((req, res) => {
      capturedUrl = req.url;
      res.writeHead(204);
      res.end();
    });
    const client = createDockerClient({
      project: 'p',
      service: 'node',
      socketPath,
    });
    await client.startContainer('container-1');
    expect(capturedUrl).toBe('/containers/container-1/start');
  });

  it('非 204/304 抛 DockerApiError', async () => {
    await startServer((_req, res) => {
      sendJson(res, 500, { message: 'boom' });
    });
    const client = createDockerClient({
      project: 'p',
      service: 'node',
      socketPath,
    });
    await expect(client.startContainer('container-1')).rejects.toBeInstanceOf(
      DockerApiError,
    );
  });
});

describe('ops/docker: resolveOwnComposeProject', () => {
  it('取 label com.docker.compose.project', async () => {
    let capturedUrl: string | undefined;
    await startServer((req, res) => {
      capturedUrl = req.url;
      sendJson(res, 200, {
        Config: { Labels: { 'com.docker.compose.project': 'runko-cluster' } },
      });
    });
    const project = await resolveOwnComposeProject('myhostname', socketPath);
    expect(project).toBe('runko-cluster');
    expect(capturedUrl).toBe('/containers/myhostname/json');
  });

  it('缺 label 抛错（提示改用 RUNKO_OPS_PROJECT）', async () => {
    await startServer((_req, res) => {
      sendJson(res, 200, { Config: { Labels: {} } });
    });
    await expect(
      resolveOwnComposeProject('myhostname', socketPath),
    ).rejects.toThrow(/RUNKO_OPS_PROJECT/);
  });

  it('Labels 整个缺失（null）同样当作缺 label', async () => {
    await startServer((_req, res) => {
      sendJson(res, 200, { Config: { Labels: null } });
    });
    await expect(
      resolveOwnComposeProject('myhostname', socketPath),
    ).rejects.toThrow(/com.docker.compose.project/);
  });

  it('非 200 抛 DockerApiError', async () => {
    await startServer((_req, res) => {
      sendJson(res, 404, { message: 'no such container' });
    });
    await expect(
      resolveOwnComposeProject('myhostname', socketPath),
    ).rejects.toBeInstanceOf(DockerApiError);
  });
});
