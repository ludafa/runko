/**
 * [集群控制台](../../../../../docs/terms.md) API 客户端。设计见
 * docs/host/node/tech/cluster-console.md §8、§9。
 *
 * 手写 `fetch` + 复用 `src/gen/zod` 生成的 schema 校验，**不直接用 `src/gen/clients`
 * 那层包装**：kubb 的 fetch 客户端（`@kubb/plugin-client/clients/fetch`）从不检查
 * `response.ok`，非 2xx 响应会被当成成功解析——这个控制台恰恰要分辨 409（没配运维
 * 容器，按钮该置灰）与 404（未知节点），所以不能用它。与 `features/chat/api.ts`、
 * `features/notifications/api.ts` 同一个姿态；类型与校验规则仍然全部来自生成产物，
 * 不重复手写一份。
 */
import type { z } from 'zod';

import {
  apiErrorSchema,
  consoleOfflineAckSchema,
  consoleOnlineAckSchema,
  consoleOverviewSchema,
} from '../../gen/zod';

export type ConsoleOverview = z.infer<typeof consoleOverviewSchema>;
export type ConsoleNode = ConsoleOverview['nodes'][number];
export type ConsoleConversation = ConsoleOverview['conversations'][number];
export type ConsoleOfflineAck = z.infer<typeof consoleOfflineAckSchema>;
export type ConsoleOnlineAck = z.infer<typeof consoleOnlineAckSchema>;

export class ConsoleApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(
      message.length > 0 ?
        message
      : `集群控制台接口失败（HTTP ${String(status)}）`,
    );
    this.name = 'ConsoleApiError';
    this.status = status;
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    const parsed = apiErrorSchema.safeParse(body);
    return parsed.success ? parsed.data.error : '';
  } catch {
    return '';
  }
}

async function requestJson(input: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(input, { credentials: 'include', ...init });
  if (!response.ok) {
    throw new ConsoleApiError(
      response.status,
      await readErrorMessage(response),
    );
  }
  const body: unknown = await response.json();
  return body;
}

export async function fetchConsoleOverview(
  signal?: AbortSignal,
): Promise<ConsoleOverview> {
  const json = await requestJson('/api/console/overview', {
    method: 'GET',
    signal,
  });
  return consoleOverviewSchema.parse(json);
}

export async function postNodeOffline(
  id: string,
  signal?: AbortSignal,
): Promise<ConsoleOfflineAck> {
  const json = await requestJson(
    `/api/console/nodes/${encodeURIComponent(id)}/offline`,
    { method: 'POST', signal },
  );
  return consoleOfflineAckSchema.parse(json);
}

export async function postNodeOnline(
  id: string,
  signal?: AbortSignal,
): Promise<ConsoleOnlineAck> {
  const json = await requestJson(
    `/api/console/nodes/${encodeURIComponent(id)}/online`,
    { method: 'POST', signal },
  );
  return consoleOnlineAckSchema.parse(json);
}
