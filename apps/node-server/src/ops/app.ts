/**
 * [运维容器](../../../../docs/terms.md)的三个接口。设计见
 * docs/host/node/tech/cluster-console.md §7。
 *
 * 依赖（Docker 客户端、时钟、令牌、超时）全部注入，`createOpsApp` 本身不读
 * 环境变量——那是 `index.ts` 的事，这里只管把依赖拼成一个 Hono app，方便
 * 测试时塞假的 `DockerClient` 与固定时钟。
 */
import { Hono } from 'hono';

import type { Logger } from '../logger.js';
import { logger as defaultLogger } from '../logger.js';
import type { DockerClient, DockerContainerSummary } from './docker.js';
import { DOCKER_STATE_RUNNING } from './docker.js';
import type { OpsNode, OpsNodeState } from './schema.js';

const LOG_SCOPE = 'ops';

/**
 * `stop` 期间 Docker 照样报 `running`（§7.3），下线中这个状态它自己不记。
 * `TERMINAL_STATES` 是「容器已经不在跑」的判据——命中就说明下线彻底完成，
 * 顺手把下线表里的这一条也清掉。
 */
const TERMINAL_STATES = new Set(['exited', 'dead', 'created']);

export interface OpsAppDeps {
  docker: DockerClient;
  /**
   * 内部令牌；`index.ts` 保证非空传进来——没配令牌就该在启动那一刻拒绝，
   * 不该跑到每个请求才发现。
   */
  token: string;
  /** `docker stop -t` 的秒数，缺省 120（§3.1）。 */
  stopTimeoutS?: number;
  /** 拼进节点 `url` 字段的端口，缺省 3900（`RUNKO_NODE_URL` 的默认端口）。 */
  nodePort?: number;
  /** 供测试注入固定时钟，缺省 `Date.now`。 */
  now?: () => number;
  logger?: Logger;
}

/**
 * 判「下线中」这个状态记在哪：容器 id → 强杀时刻（毫秒）。只在内存里，
 * 运维容器自己重启这张表就丢（§7.3 的已知限制，功能手册已如实写明）。
 */
function deriveNodeState(
  dockerState: string,
  offlineDeadline: number | undefined,
): { state: OpsNodeState; offlineDeadline: number | null } {
  if (dockerState === DOCKER_STATE_RUNNING) {
    if (offlineDeadline !== undefined) {
      return { state: 'going_offline', offlineDeadline };
    }
    return { state: 'online', offlineDeadline: null };
  }
  if (TERMINAL_STATES.has(dockerState)) {
    return { state: 'offline', offlineDeadline: null };
  }
  // restarting / paused 等：状态字原样透出去，控制台自己决定怎么显示。
  return { state: 'unknown', offlineDeadline: null };
}

export function createOpsApp(deps: OpsAppDeps): Hono {
  const app = new Hono();
  const log = deps.logger ?? defaultLogger;
  const stopTimeoutS = deps.stopTimeoutS ?? 120;
  const nodePort = deps.nodePort ?? 3900;
  const now = deps.now ?? Date.now;

  const offlineDeadlines = new Map<string, number>();

  /**
   * `docker.sock` 挂进来的容器等于整台机器的管理员（§7.4）。健康检查不鉴权
   * ——跟 `app.ts` 的 `/health` 同一个理由，编排系统探活不该被迫带内部令牌
   * ——其余全部路由都要 Bearer 令牌，注册顺序上放在它前面。
   */
  app.get('/health', (c) => c.json({ ok: true }));

  app.use('*', async (c, next) => {
    const expected = `Bearer ${deps.token}`;
    if (c.req.header('authorization') !== expected) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  });

  function toNodeView(container: DockerContainerSummary): OpsNode {
    const shortId = container.id.slice(0, 12);
    const { state, offlineDeadline } = deriveNodeState(
      container.state,
      offlineDeadlines.get(container.id),
    );
    if (state === 'offline') {
      offlineDeadlines.delete(container.id);
    }
    return {
      id: container.id,
      shortId,
      index: container.index,
      url: `http://${shortId}:${String(nodePort)}`,
      state,
      dockerState: container.state,
      offlineDeadline,
    };
  }

  /**
   * `{id}` 只认列表里出现过的容器（可以是完整 id 或前 12 位）——这是
   * 「不能拿它去停 Postgres」这条安全边界在代码里的样子（§7.1）。
   */
  async function resolveContainer(
    requestedId: string,
  ): Promise<DockerContainerSummary | undefined> {
    const containers = await deps.docker.listContainers();
    return containers.find(
      (container) =>
        container.id === requestedId ||
        container.id.slice(0, 12) === requestedId,
    );
  }

  app.get('/nodes', async (c) => {
    const containers = await deps.docker.listContainers();
    return c.json(containers.map(toNodeView), 200);
  });

  app.post('/nodes/:id/offline', async (c) => {
    const requestedId = c.req.param('id');
    const container = await resolveContainer(requestedId);
    if (container === undefined) {
      return c.json({ error: 'unknown node id' }, 404);
    }

    // **幂等**：已经在下线中的，原样返回原来的强杀时刻。再发一次 stop 会把倒计时
    // 从头算，控制台上连点两下就等于给节点续了命。
    const pending = offlineDeadlines.get(container.id);
    if (pending !== undefined) {
      return c.json({ ok: true as const, offlineDeadline: pending }, 202);
    }

    const offlineDeadline = now() + stopTimeoutS * 1000;
    offlineDeadlines.set(container.id, offlineDeadline);

    // **不等它**：`docker stop` 本身会阻塞到容器停下或 `stopTimeoutS` 秒后
    // 被强杀，等它就是把 202 变成一个要挂 2 分钟的请求。失败只记日志、并把
    // 下线表那一项撤掉——不撤的话控制台会一直显示「下线中」。
    void deps.docker
      .stopContainer(container.id, stopTimeoutS)
      .catch((error: unknown) => {
        offlineDeadlines.delete(container.id);
        log.error(LOG_SCOPE, 'docker stop failed', {
          id: container.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });

    log.info(LOG_SCOPE, 'node offline requested', {
      id: container.id,
      stopTimeoutS,
      offlineDeadline,
    });
    return c.json({ ok: true as const, offlineDeadline }, 202);
  });

  app.post('/nodes/:id/online', async (c) => {
    const requestedId = c.req.param('id');
    const container = await resolveContainer(requestedId);
    if (container === undefined) {
      return c.json({ error: 'unknown node id' }, 404);
    }

    // 主动清掉下线表：不然运维容器若在下线期间重启过、又恰好没被 GET /nodes
    // 扫过一遍，这条记录会让刚重新上线的容器在下一次 GET 里显示成「下线中」。
    offlineDeadlines.delete(container.id);

    void deps.docker.startContainer(container.id).catch((error: unknown) => {
      log.error(LOG_SCOPE, 'docker start failed', {
        id: container.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    log.info(LOG_SCOPE, 'node online requested', { id: container.id });
    return c.json({ ok: true as const }, 202);
  });

  return app;
}
