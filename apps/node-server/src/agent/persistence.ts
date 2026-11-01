/**
 * 框架要的四样宿主能力，全部交给官方包 `@runko/persist-kysely`：[账本](../../../../docs/terms.md)、
 * [裁决表](../../../../docs/terms.md)、[待发队列](../../../../docs/terms.md)、[归属仲裁机制](../../../../docs/terms.md)。
 *
 * **它吃的就是本应用那个 Kysely 实例**——框架的表与本应用的表在同一个库、同一个连接里，
 * 建表也在同一条命令里（`db/migrate.ts`）。这正是「宿主自己有库，框架的表跟着进去」的样子。
 *
 * 想知道框架的表长什么样，看 `@runko/persist-kysely` 的 `schema.sql`。本应用只在两处直接
 * 读它们（会话列表的两个计数，见 `runko-tables.ts`），其余一律走接口。
 */
import type { Arbitration, NodeRegistry, Persistence } from '@runko/agent';
import {
  DEFAULT_TAKEOVER_MS,
  kyselyPersistence,
  leaseArbitration,
  nodeRegistry,
} from '@runko/persist-kysely';

import type { Db } from '../db/instance.js';
import { flavor } from '../db/instance.js';

export function createChatPersistence(db: Db): Persistence {
  return kyselyPersistence(db, { flavor });
}

/**
 * 读一个毫秒数的环境变量。**空串与写错的值一律当没配**：k8s / compose 里「声明了但没给值」
 * 很常见，那会把心跳配成 0（每毫秒两条查询），或者把接管阈值配成 0 让构造直接抛——
 * 报错还指着一个用户根本没设过的数字。
 */
export function readMs(
  name: string,
  env: NodeJS.ProcessEnv,
): number | undefined {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export interface ChatArbitrationOptions {
  /**
   * 这个进程的名字。多副本时要填本副本的可达地址（别的副本据此把请求转过来），
   * 单进程就用缺省的 `local`。
   *
   * **每个进程必须唯一**：租约把「挂在自己名下、心跳早于本进程启动」的那些认成上一辈子
   * 的残留，启动时直接收拾掉——重名会让后起来的那个把前一个正在跑的轮抢走。
   */
  holder?: string;
}

/**
 * 这个进程的名字：配了 `RUNKO_NODE_URL`（多副本时本副本的可达地址）就用它，否则 `local`。
 * 租约的 `holder` 与[交权](../../../../docs/terms.md)里的节点地址必须是同一个值——接手节点靠它认出
 * 「这份对话预留给我」。
 */
export function resolveNodeName(env: NodeJS.ProcessEnv = process.env): string {
  const nodeUrl = env.RUNKO_NODE_URL?.trim();
  return nodeUrl !== undefined && nodeUrl !== '' ? nodeUrl : 'local';
}

/**
 * [发布序号](../../../../docs/terms.md)（`RUNKO_RELEASE_SEQ`）：发布流水线每次发布递增，回滚也递增。
 * 交权时只挑序号不比自己小的节点接手。不配或写错一律当 0。
 */
export function readReleaseSeq(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.RUNKO_RELEASE_SEQ?.trim());
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

/** [节点登记表](../../../../docs/terms.md)：与租约表在同一个库里（`agent_nodes`）。 */
export function createChatNodeRegistry(db: Db): NodeRegistry {
  return nodeRegistry(db, { flavor });
}

export function createChatArbitration(
  db: Db,
  opts: ChatArbitrationOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Arbitration {
  const holder = opts.holder ?? resolveNodeName(env);
  // 心跳与接管阈值可调：验证环境要把时间轴压扁（缺省 5 秒 / 60 秒，一个场景要等一分钟）。
  // 不配就用框架的缺省值。
  const heartbeatMs = readMs('RUNKO_HEARTBEAT_MS', env);
  const takeoverMs = readMs('RUNKO_TAKEOVER_MS', env);
  return leaseArbitration(db, {
    flavor,
    holder,
    ...(heartbeatMs !== undefined ? { heartbeatMs } : {}),
    ...(takeoverMs !== undefined ? { takeoverMs } : {}),
  });
}

/**
 * 与 `createChatArbitration` 用的同一个接管阈值：显式配了 `RUNKO_TAKEOVER_MS` 就用那个，
 * 没配就退到框架缺省值。[集群控制台](../../../../docs/terms.md)判「疑似失联」要用同一个
 * 数字——两处各算各的，会出现控制台说「正常」而接管其实已经发生（或反过来）的分裂。
 */
export function resolveTakeoverMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return readMs('RUNKO_TAKEOVER_MS', env) ?? DEFAULT_TAKEOVER_MS;
}
