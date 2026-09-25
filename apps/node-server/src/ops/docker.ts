/**
 * [运维容器](../../../../docs/terms.md)跟 Docker 引擎说话的最小客户端。
 * 设计见 docs/host/node/tech/cluster-console.md §7.2：不引 `dockerode`，
 * 三个接口用 Node 自带的 `node:http` 走 `docker.sock` 就够。
 *
 * 只做三件事：按 label 列容器、`stop`、`start`。别的 Docker 能力一概不碰——
 * 这就是「运维容器只认 node 服务的容器」这条安全边界（§7.4）在代码里的样子：
 * 客户端本身不提供「按任意 id 操作」以外的接口，调不出圈。
 */
import * as http from 'node:http';

import { z } from 'zod';

/** 没显式配置时的 Docker daemon socket 路径，`index.ts` 的缺省值。 */
export const DEFAULT_DOCKER_SOCKET_PATH = '/var/run/docker.sock';

/**
 * Docker 用 `running` 表示容器活着；`stop`/`start` 的语义都围着这个状态转。
 * `app.ts` 推导「在线/下线中」时判的就是它，故单独导出，两处不能各写一份字面量。
 */
export const DOCKER_STATE_RUNNING = 'running';

export class DockerApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'DockerApiError';
  }
}

export interface DockerContainerSummary {
  /** 完整容器 id（64 位 hex）。 */
  id: string;
  /** Docker 的容器状态字，例如 `running`/`exited`/`restarting`。 */
  state: string;
  /** compose 打的副本序号（label `com.docker.compose.container-number`）；缺失或非数字时为 `null`。 */
  index: number | null;
}

/**
 * 三个操作，接口单独导出是为了测试时能注入假实现（`app.ts` 靠依赖注入拿到它）。
 */
export interface DockerClient {
  /** 列出配置的 compose project + service 下的全部容器，含已退出的（`all=1`）。 */
  listContainers(): Promise<DockerContainerSummary[]>;
  /** `docker stop -t <timeoutS>`：阻塞到容器停下或超时强杀，见 §7.2 表格。 */
  stopContainer(id: string, timeoutS: number): Promise<void>;
  /** `docker start`。 */
  startContainer(id: string): Promise<void>;
}

export interface DockerClientOptions {
  /** label `com.docker.compose.project` 的值，用来把容器列表锁定在这一套集群里。 */
  project: string;
  /** label `com.docker.compose.service` 的值（集群 compose 里是 `node`）。 */
  service: string;
  /** 缺省 {@link DEFAULT_DOCKER_SOCKET_PATH}。 */
  socketPath?: string;
}

const dockerContainerSchema = z.object({
  Id: z.string(),
  State: z.string(),
  Labels: z.record(z.string(), z.string()).optional(),
});

const dockerContainersSchema = z.array(dockerContainerSchema);

function parseContainerIndex(
  labels: Record<string, string> | undefined,
): number | null {
  const raw = labels?.['com.docker.compose.container-number'];
  if (raw === undefined) {
    return null;
  }
  const value = Number(raw);
  return Number.isInteger(value) ? value : null;
}

interface DockerHttpResponse {
  statusCode: number;
  body: string;
}

/**
 * 走 unix socket 发一个请求。`timeoutMs` 只是失败兜底——`stop` 本身会阻塞到
 * `timeoutS` 秒后 Docker 自己 SIGKILL，这里的超时要比它更宽松，防的是
 * daemon 彻底没反应（socket 挂了之类）那种更坏的情况。
 */
function requestDocker(
  socketPath: string,
  method: string,
  path: string,
  timeoutMs = 10_000,
): Promise<DockerHttpResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath, method, path, headers: { accept: 'application/json' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(
        new Error(
          `docker request timed out after ${String(timeoutMs)}ms: ${method} ${path}`,
        ),
      );
    });
    req.end();
  });
}

const dockerInspectSchema = z.object({
  Config: z.object({
    Labels: z.record(z.string(), z.string()).nullable().optional(),
  }),
});

/**
 * 问 Docker「我自己这个容器属于哪个 compose 项目」（label `com.docker.compose.project`）。
 *
 * **项目名不能写死**：集群端到端测试用 `-p runko-cluster-e2e` 另起一套，写死成
 * `runko-cluster` 的话，那一套里的运维容器列出、甚至停掉的会是开发者手上正在跑的那套集群。
 * 容器里的主机名缺省就是容器 id 的前 12 位，Docker 的 inspect 接口认它。
 */
export async function resolveOwnComposeProject(
  containerHostname: string,
  socketPath: string = DEFAULT_DOCKER_SOCKET_PATH,
): Promise<string> {
  const { statusCode, body } = await requestDocker(
    socketPath,
    'GET',
    `/containers/${encodeURIComponent(containerHostname)}/json`,
  );
  if (statusCode !== 200) {
    throw new DockerApiError(
      statusCode,
      `failed to inspect own container ${containerHostname}: ${body}`,
    );
  }
  const project = dockerInspectSchema.parse(JSON.parse(body)).Config.Labels?.[
    'com.docker.compose.project'
  ];
  if (project === undefined || project === '') {
    throw new Error(
      `container ${containerHostname} has no com.docker.compose.project label; set RUNKO_OPS_PROJECT explicitly`,
    );
  }
  return project;
}

export function createDockerClient(options: DockerClientOptions): DockerClient {
  const socketPath = options.socketPath ?? DEFAULT_DOCKER_SOCKET_PATH;

  return {
    async listContainers(): Promise<DockerContainerSummary[]> {
      const filters = JSON.stringify({
        label: [
          `com.docker.compose.project=${options.project}`,
          `com.docker.compose.service=${options.service}`,
        ],
      });
      const path = `/containers/json?all=1&filters=${encodeURIComponent(filters)}`;
      const { statusCode, body } = await requestDocker(socketPath, 'GET', path);
      if (statusCode !== 200) {
        throw new DockerApiError(
          statusCode,
          `failed to list containers: ${body}`,
        );
      }
      const containers = dockerContainersSchema.parse(JSON.parse(body));
      return containers.map((container) => ({
        id: container.Id,
        state: container.State,
        index: parseContainerIndex(container.Labels),
      }));
    },

    async stopContainer(id: string, timeoutS: number): Promise<void> {
      const path = `/containers/${encodeURIComponent(id)}/stop?t=${String(timeoutS)}`;
      // 多留 30 秒余量：Docker 自己到点会 SIGKILL，这个超时只兜「daemon 完全没反应」。
      const { statusCode, body } = await requestDocker(
        socketPath,
        'POST',
        path,
        (timeoutS + 30) * 1000,
      );
      // 204 = 已停下；304 = 本来就没在跑，两者都算成功（`docker stop` 本身也这么处理）。
      if (statusCode !== 204 && statusCode !== 304) {
        throw new DockerApiError(
          statusCode,
          `failed to stop container ${id}: ${body}`,
        );
      }
    },

    async startContainer(id: string): Promise<void> {
      const path = `/containers/${encodeURIComponent(id)}/start`;
      const { statusCode, body } = await requestDocker(
        socketPath,
        'POST',
        path,
      );
      if (statusCode !== 204 && statusCode !== 304) {
        throw new DockerApiError(
          statusCode,
          `failed to start container ${id}: ${body}`,
        );
      }
    },
  };
}
