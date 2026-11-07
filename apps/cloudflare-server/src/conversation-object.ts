/**
 * 会话对象：一个会话一个 Durable Object（docs/host/cloudflare/tech/chat-on-cloudflare.md §4）。
 *
 * `@runko/agent` 的运行时就跑在这里：账本、待发队列、裁决表在对象自带的 SQLite 里，
 * [本地沙盒](../../../docs/terms.md)的快照也在。会话表、授权表在 D1（跨会话的东西）。
 *
 * 只有同一个 Worker 拿得到这个对象的引用，所以这里**不再验身份**：每个方法的调用方都是
 * Worker 里已经验过登录、查过归属的路由。方法的第一个参数都是会话 id——对象名就是它，
 * 但对象自己拿不到自己的名字，只能由调用方带进来；建会话和发消息时记进对象存储，
 * 重启后没人调用也知道该回写哪一行列表状态。
 */
import type {
  ConversationActivity,
  DecisionRecord,
  EnqueueResult,
  QueuedInput,
  SubmittedDecision,
  TurnInput,
} from '@runko/agent';
import type { RunkoUIMessage } from '@runko/core';
import type { DurableObjectRuntime } from '@runko/durable-object';
import {
  createDurableObjectRuntime,
  framesToStream,
} from '@runko/durable-object';
import { kyselyPersistence } from '@runko/persist-kysely';
import { defineAgent } from '@runko/sdk';
import type { GithubApp } from '@runko-chat/shared/agent/github-app';
import { createGithubApp } from '@runko-chat/shared/agent/github-app';
import { createLocalProvider } from '@runko-chat/shared/agent/local-sandbox';
import { resolveModel } from '@runko-chat/shared/agent/model';
import type {
  SandboxManager,
  SandboxProviderRegistry,
} from '@runko-chat/shared/agent/sandbox-manager';
import {
  createSandboxManager,
  resolveIdleTimeoutMs,
} from '@runko-chat/shared/agent/sandbox-manager';
import {
  createChatTurnAssembly,
  mergeHooks,
} from '@runko-chat/shared/agent/turn-assembly';
import type { Db } from '@runko-chat/shared/db/schema';
import type { EnvLike } from '@runko-chat/shared/env';
import type { Logger } from '@runko-chat/shared/logger';
import { createLogger } from '@runko-chat/shared/logger';
import type {
  ConversationLiveState,
  ProvisionInput,
  ProvisionResult,
} from '@runko-chat/shared/routes/chat';
import {
  provisionWithSandboxManager,
  readRuntimeLiveState,
} from '@runko-chat/shared/routes/chat';
import { DurableObject } from 'cloudflare:workers';

import { authFor, getGithubUserToken } from './auth.js';
import { chatDb } from './db/instance.js';
import { writeLiveState } from './db/live-state.js';
import type { Env } from './env.js';
import { cloudflareSandboxEnabled, textEnv } from './env.js';
import type { CloudflareProviderDeps } from './sandbox/cloudflare-provider.js';
import {
  createCloudflareProvider,
  prewarmCloudflareSandbox,
} from './sandbox/cloudflare-provider.js';
import {
  durableObjectSnapshotStore,
  migrateSnapshotStore,
} from './sandbox/snapshot-store.js';

const LOG_SCOPE = 'conversation-object';

/** 永远会被 `prepareTurn` 覆盖，不会被解析成模型（同 Node 版 `agent/runtime.ts`）。 */
const PLACEHOLDER_MODEL = 'runko/overridden-per-turn';

/**
 * 本地沙盒快照的大小上限。会话对象的内存上限是 128 MB，内存文件系统、它的 JSON、
 * 运行时本身都在里面，快照得留出大半余量。超了就提示用户换 Cloudflare 沙盒。
 */
const MAX_LOCAL_SNAPSHOT_BYTES = 32 * 1024 * 1024;

/** 一轮收尾后复查「真停了没有」的节奏，见 `#syncWhenReleased`。 */
const RELEASE_CHECK_MS = 25;
const RELEASE_CHECKS = 40;

/** 对象存储里记会话 id 的键，见 `#remember`。 */
const CONVERSATION_ID_KEY = 'conversationId';

/** 拿得到对外地址就用它，拿不到时 better-auth 的服务端调用（取 GitHub 令牌）也不需要回调地址。 */
const INTERNAL_ORIGIN = 'http://conversation-object.internal';

export class ConversationObject extends DurableObject<Env> {
  readonly #host: DurableObjectRuntime;
  readonly #db: Db;
  readonly #sandboxManager: SandboxManager;
  readonly #log: Logger;
  readonly #sandbox: CloudflareProviderDeps | undefined;
  readonly #decisions: ReturnType<typeof kyselyPersistence>['decisions'];
  /** 这个会话的沙盒名与档位（预热用），第一次用到时从 D1 读一次。 */
  #meta:
    Promise<{ provider: string; sandboxName: string } | undefined> | undefined;
  #conversationId: string | undefined;
  /** 回写列表状态的串行化：同一时刻只跑一次，期间又变了就跑完再补一次。 */
  #syncing = false;
  #syncAgain = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const text: EnvLike = textEnv(env);
    this.#log = createLogger();
    this.#db = chatDb(env.DB);
    const idleTimeoutMs = resolveIdleTimeoutMs(text);

    migrateSnapshotStore(ctx.storage);
    const providers: SandboxProviderRegistry = {
      local: createLocalProvider({
        snapshots: durableObjectSnapshotStore(ctx.storage),
        maxSnapshotBytes: MAX_LOCAL_SNAPSHOT_BYTES,
        logger: this.#log,
      }),
    };
    if (cloudflareSandboxEnabled(env) && env.Sandbox !== undefined) {
      this.#sandbox = { namespace: env.Sandbox, sleepAfterMs: idleTimeoutMs };
      providers.cloudflare = createCloudflareProvider(this.#sandbox);
    }
    this.#sandboxManager = createSandboxManager(providers, {
      idleTimeoutMs,
      logger: this.#log,
    });

    const githubApp: GithubApp = createGithubApp({
      env: text,
      getUserToken: (userId) =>
        getGithubUserToken(
          authFor(env, env.SERVER_URL?.trim() || INTERNAL_ORIGIN),
          userId,
        ),
    });

    const assembly = createChatTurnAssembly({
      db: this.#db,
      sandboxManager: this.#sandboxManager,
      resolveModel: () => resolveModel(text),
      githubApp,
      logger: this.#log,
      env: text,
    });

    // 列表要的那三样状态，在它们变化的时刻回写 D1。
    const sync = (event: { conversationId: string }): void => {
      this.#scheduleSync(event.conversationId);
    };

    this.#host = createDurableObjectRuntime(ctx, {
      agent: defineAgent({ model: PLACEHOLDER_MODEL }),
      logger: this.#log,
      prepareTurn: assembly.prepareTurn,
      hooks: mergeHooks(assembly.hooks, {
        onTurnStart: sync,
        onTurnSettled: (event) => {
          void this.#syncWhenReleased(event.conversationId);
        },
        onApprovalPending: sync,
        onQuestionPending: sync,
      }),
    });
    this.#decisions = kyselyPersistence(this.#host.db, {
      flavor: 'sqlite',
    }).decisions;
    void this.#syncAfterRecovery();
  }

  get #runtime() {
    return this.#host.runtime;
  }

  // ---- 会话里的动作：一一对应共用路由的 `ConversationRuntime` ----

  async enqueue(
    conversationId: string,
    input: TurnInput,
    opts?: { intent?: 'queue' | 'steer' },
  ): Promise<EnqueueResult> {
    this.#remember(conversationId);
    const result = await this.#runtime.enqueue(conversationId, input, opts);
    this.#scheduleSync(conversationId);
    return result;
  }

  async abort(conversationId: string): Promise<boolean> {
    const aborted = await this.#runtime.abort(conversationId);
    this.#scheduleSync(conversationId);
    return aborted;
  }

  async removeQueued(
    conversationId: string,
    id: string,
  ): Promise<{ removed: boolean; queue: QueuedInput[] }> {
    const result = await this.#runtime.removeQueued(conversationId, id);
    this.#scheduleSync(conversationId);
    return result;
  }

  async clearQueue(conversationId: string): Promise<QueuedInput[]> {
    const queue = await this.#runtime.clearQueue(conversationId);
    this.#scheduleSync(conversationId);
    return queue;
  }

  listQueue(conversationId: string): Promise<QueuedInput[]> {
    return this.#runtime.listQueue(conversationId);
  }

  getActivity(conversationId: string): Promise<ConversationActivity> {
    return this.#runtime.getActivity(conversationId);
  }

  readLedger(
    conversationId: string,
    opts?: { afterSeq?: number },
  ): Promise<{ seq: number; message: RunkoUIMessage }[]> {
    return this.#runtime.readLedger(conversationId, opts);
  }

  /**
   * 直播流。RPC 传不了 `AsyncIterable` 与 `AbortSignal`，所以编成字节流交出去；调用方 cancel
   * 这条流，就是这里的订阅收线。顺手把云沙盒叫醒（见 `prewarmCloudflareSandbox`）。
   */
  subscribe(
    conversationId: string,
    after?: number,
  ): ReadableStream<Uint8Array> {
    void this.#prewarm(conversationId);
    return framesToStream((signal) =>
      this.#runtime.subscribe(conversationId, {
        ...(after !== undefined ? { after } : {}),
        signal,
      }),
    );
  }

  async submitDecision(
    conversationId: string,
    callId: string,
    decision: SubmittedDecision,
  ): Promise<boolean> {
    const resolved = await this.#runtime.submitDecision(
      conversationId,
      callId,
      decision,
    );
    this.#scheduleSync(conversationId);
    return resolved;
  }

  async submitAnswer(
    conversationId: string,
    callId: string,
    answer: string,
    opts?: { decidedBy?: string },
  ): Promise<boolean> {
    const resolved = await this.#runtime.submitAnswer(
      conversationId,
      callId,
      answer,
      opts,
    );
    this.#scheduleSync(conversationId);
    return resolved;
  }

  // ---- 会话后端的其余几样 ----

  listPendingDecisions(conversationId: string): Promise<DecisionRecord[]> {
    return this.#decisions.listPending(conversationId);
  }

  async liveState(conversationId: string): Promise<ConversationLiveState> {
    const pending = await this.#decisions.listPending(conversationId);
    return readRuntimeLiveState(this.#runtime, conversationId, pending.length);
  }

  async provision(input: ProvisionInput): Promise<ProvisionResult> {
    this.#remember(input.conversationId);
    await this.#host.ready;
    const result = await provisionWithSandboxManager(
      this.#sandboxManager,
      input,
      this.#log,
    );
    this.#meta = Promise.resolve({
      provider: input.provider,
      sandboxName: input.sandboxName,
    });
    return result;
  }

  extendSandboxLifetime(conversationId: string): Promise<void> {
    return this.#sandboxManager.ensureLifetime(conversationId);
  }

  override async alarm(): Promise<void> {
    await this.#host.alarm();
  }

  // ---- 内部 ----

  #prewarm(conversationId: string): Promise<void> {
    const sandbox = this.#sandbox;
    if (sandbox === undefined) {
      return Promise.resolve();
    }
    this.#meta ??= this.#db
      .selectFrom('conversations')
      .select(['provider', 'sandbox_name'])
      .where('id', '=', conversationId)
      .executeTakeFirst()
      .then((row) =>
        row === undefined ? undefined : (
          { provider: row.provider, sandboxName: row.sandbox_name }
        ),
      );
    return this.#meta
      .then(async (meta) => {
        if (meta?.provider === 'cloudflare') {
          await prewarmCloudflareSandbox(sandbox, meta.sandboxName);
        }
      })
      .catch((error: unknown) => {
        this.#meta = undefined;
        this.#log.warn(LOG_SCOPE, 'sandbox prewarm failed', {
          conversationId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  #remember(conversationId: string): void {
    if (this.#conversationId === conversationId) {
      return;
    }
    this.#conversationId = conversationId;
    void this.ctx.storage
      .put(CONVERSATION_ID_KEY, conversationId)
      .catch((error: unknown) => {
        this.#log.warn(LOG_SCOPE, 'could not remember the conversation id', {
          conversationId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  /**
   * 每次构造都回写一次列表状态：`ready` 里的 `recover()` 给没收尾的轮补「已中断」时不走
   * 任何钩子，身后没有排队的消息就不会再起轮，列表会一直停在「在跑」。
   */
  async #syncAfterRecovery(): Promise<void> {
    try {
      await this.#host.ready;
      // 只认上一辈子记下的：刚建的会话，`provision` 跑的时候会话表里还没有这一行。
      const stored = await this.ctx.storage.get<string>(CONVERSATION_ID_KEY);
      if (stored !== undefined) {
        this.#conversationId ??= stored;
        this.#scheduleSync(stored);
      }
    } catch (error) {
      this.#log.warn(LOG_SCOPE, 'live state write-back after start failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 一轮收尾后的回写。正常收尾（这一轮之后可以接着起下一轮）时，`onTurnSettled` 在框架里排在
   * 「看队列、放手」之前（宿主要据收尾那一刻队列里还有没有货决定推不推通知），那一刻问
   * `getActivity` 还是「在跑」。所以隔一小会儿复查，看到真停了再回写；一直在跑说明下一轮已经
   * 接上了，那一轮收尾时会再来一遍。其余收尾路径通知时已经放手，第一次复查就停。
   */
  async #syncWhenReleased(conversationId: string): Promise<void> {
    for (let attempt = 0; attempt < RELEASE_CHECKS; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, RELEASE_CHECK_MS));
      try {
        const activity = await this.#runtime.getActivity(conversationId);
        if (!activity.active) {
          break;
        }
      } catch {
        break;
      }
    }
    this.#scheduleSync(conversationId);
  }

  #scheduleSync(conversationId: string): void {
    if (this.#syncing) {
      this.#syncAgain = true;
      return;
    }
    this.#syncing = true;
    void (async () => {
      try {
        do {
          this.#syncAgain = false;
          const live = await this.liveState(conversationId);
          await writeLiveState(this.#db, conversationId, live);
        } while (this.#syncAgain);
      } catch (error) {
        // 回写失败只影响列表上那几个角标，下一次状态变化会再写；不该让会话里的动作失败。
        this.#log.warn(LOG_SCOPE, 'live state write-back failed', {
          conversationId,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.#syncing = false;
      }
    })();
  }
}
