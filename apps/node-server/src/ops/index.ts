/**
 * [运维容器](../../../../docs/terms.md)的入口。设计见
 * docs/host/node/tech/cluster-console.md §7；compose 里的 `ops` 服务跑的就是
 * `dist/ops/index.js`（同一个镜像，只是换了 `command`）。
 */
import { hostname } from 'node:os';

import { serve } from '@hono/node-server';

import { logger } from '../logger.js';
import { createOpsApp } from './app.js';
import {
  createDockerClient,
  DEFAULT_DOCKER_SOCKET_PATH,
  resolveOwnComposeProject,
} from './docker.js';

const LOG_SCOPE = 'ops';

/**
 * 没配令牌就直接拒绝启动，而不是等第一个请求才 401——挂着 `docker.sock` 的
 * 容器等于整台机器的管理员（§7.4），不该有「先跑起来、令牌以后再补」这种状态。
 */
const token = process.env.RUNKO_OPS_TOKEN?.trim();
if (token === undefined || token === '') {
  throw new Error(
    'RUNKO_OPS_TOKEN is required to start the ops service (docs/host/node/tech/cluster-console.md §7.4)',
  );
}

const socketPath =
  process.env.RUNKO_OPS_DOCKER_SOCKET?.trim() || DEFAULT_DOCKER_SOCKET_PATH;
// 不配就问 Docker 自己属于哪个 compose 项目——同一台机器上可能同时跑着好几套集群
// （开发者自己的 + 端到端测试的），写死一个名字会操作到别人那套。
const project =
  process.env.RUNKO_OPS_PROJECT?.trim() ||
  (await resolveOwnComposeProject(hostname(), socketPath));
const service = process.env.RUNKO_OPS_SERVICE?.trim() || 'node';
const port = Number(process.env.RUNKO_OPS_PORT ?? 3950);
const stopTimeoutS = Number(process.env.RUNKO_OPS_STOP_TIMEOUT_S ?? 120);

const docker = createDockerClient({ project, service, socketPath });

const app = createOpsApp({ docker, token, stopTimeoutS, logger });

const server = serve({ fetch: app.fetch, port }, (info) => {
  logger.info(LOG_SCOPE, 'ops service started', {
    port: info.port,
    project,
    service,
    stopTimeoutS,
  });
});

// 与 `docker.sock` 打交道没有需要等待收尾的状态（不像节点那边要让轮跑完），
// 收到信号直接关服务器、退出即可。
process.on('SIGTERM', () => {
  logger.info(LOG_SCOPE, 'shutdown requested', { signal: 'SIGTERM' });
  server.close(() => {
    process.exit(0);
  });
});
