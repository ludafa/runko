/**
 * 节点侧调用[运维容器](../../../../docs/terms.md)的客户端。设计见
 * docs/host/node/tech/cluster-console.md §7.1、§8。
 *
 * `resolveOpsIdentity` 是总开关：没配 `RUNKO_OPS_URL`（或没配 `RUNKO_OPS_TOKEN`）就返回
 * `undefined`——这就是「不可控」，`routes/console.ts` 据此把 `controllable` 置为 false，
 * 不必先造一个真客户端再去打一个不存在的地址。
 *
 * 响应经 `ops/schema.ts` 的 zod schema 校验——这是「类型边界」的另一头：网络那头的 JSON
 * 与本地读回的 JSON 一样，先经 zod 收窄成精确类型再用，不做断言。
 */
import type { z } from 'zod';

import type {
  OpsNodesResponse,
  OpsOfflineResponse,
  OpsOnlineResponse,
} from '../ops/schema.js';
import {
  OpsErrorSchema,
  OpsNodesResponseSchema,
  OpsOfflineResponseSchema,
  OpsOnlineResponseSchema,
} from '../ops/schema.js';

const DEFAULT_TIMEOUT_MS = 3_000;

export interface OpsIdentity {
  /** 运维容器的地址，例如 `http://ops:3950`。 */
  url: string;
  /** 内部令牌，与运维容器的 `RUNKO_OPS_TOKEN` 是同一个值。 */
  token: string;
  /** 单次请求的超时（毫秒），缺省 {@link DEFAULT_TIMEOUT_MS}。 */
  timeoutMs?: number;
}

/**
 * 从环境变量读运维容器的身份。**`RUNKO_OPS_URL` 与 `RUNKO_OPS_TOKEN` 缺一不可**——
 * 只配了地址没配令牌，请求打过去也只会拿到 401，不如直接当没配。
 */
export function resolveOpsIdentity(
  env: NodeJS.ProcessEnv = process.env,
): OpsIdentity | undefined {
  const url = env.RUNKO_OPS_URL?.trim();
  const token = env.RUNKO_OPS_TOKEN?.trim();
  if (url === undefined || url === '' || token === undefined || token === '') {
    return undefined;
  }
  const timeoutMs = Number(env.RUNKO_OPS_TIMEOUT_MS?.trim());
  return {
    url,
    token,
    ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
  };
}

/**
 * 打不到、打通了但形状不对、打通了但对方说不行——三种失败各自要的处置不一样
 * （`routes/console.ts`：`http` 且 404 时原样透传 404，其余一律退化成「不可控」）。
 */
export type OpsClientError =
  | { kind: 'unreachable'; message: string }
  | { kind: 'invalid_response'; message: string }
  | { kind: 'http'; status: number; message: string };

export type OpsClientResult<T> =
  { ok: true; data: T } | { ok: false; error: OpsClientError };

export interface OpsClient {
  listNodes(): Promise<OpsClientResult<OpsNodesResponse>>;
  offline(id: string): Promise<OpsClientResult<OpsOfflineResponse>>;
  online(id: string): Promise<OpsClientResult<OpsOnlineResponse>>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeOpsErrorBody(body: unknown, status: number): string {
  const parsed = OpsErrorSchema.safeParse(body);
  return parsed.success ? parsed.data.error : `ops responded ${String(status)}`;
}

async function callOps<T>(
  identity: OpsIdentity,
  method: 'GET' | 'POST',
  path: string,
  schema: z.ZodType<T>,
): Promise<OpsClientResult<T>> {
  const timeoutMs = identity.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = new AbortController();
  const timer = setTimeout(() => {
    timeout.abort();
  }, timeoutMs);

  let response: Response;
  try {
    response = await fetch(new URL(path, identity.url), {
      method,
      headers: { authorization: `Bearer ${identity.token}` },
      signal: timeout.signal,
    });
  } catch (error) {
    return {
      ok: false,
      error: {
        kind: 'unreachable',
        message:
          timeout.signal.aborted ?
            `ops request timed out after ${String(timeoutMs)}ms: ${method} ${path}`
          : describeError(error),
      },
    };
  } finally {
    clearTimeout(timer);
  }

  // `response.json()` 的类型是 `any`，落进 `unknown` 变量就关住了，往下只经 zod 收窄。
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return {
      ok: false,
      error: {
        kind: 'invalid_response',
        message: `ops response (status ${String(response.status)}) was not valid JSON: ${describeError(error)}`,
      },
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      error: {
        kind: 'http',
        status: response.status,
        message: describeOpsErrorBody(body, response.status),
      },
    };
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        kind: 'invalid_response',
        message: `ops response failed schema validation: ${parsed.error.message}`,
      },
    };
  }
  return { ok: true, data: parsed.data };
}

export function createOpsClient(identity: OpsIdentity): OpsClient {
  return {
    listNodes: () => callOps(identity, 'GET', '/nodes', OpsNodesResponseSchema),
    offline: (id) =>
      callOps(
        identity,
        'POST',
        `/nodes/${encodeURIComponent(id)}/offline`,
        OpsOfflineResponseSchema,
      ),
    online: (id) =>
      callOps(
        identity,
        'POST',
        `/nodes/${encodeURIComponent(id)}/online`,
        OpsOnlineResponseSchema,
      ),
  };
}
