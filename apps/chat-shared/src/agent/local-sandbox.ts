/**
 * [本地沙盒](../../../../docs/terms.md)——不需要任何云账号的那一档 provider。
 *
 * 文件放在进程内存里（`MemoryFS`），命令交给纯 TS 实现的 bash（`@runko/just-bash`）。
 * 没有 git、没有网络，所以建会话时不拉仓库、不开分支。它是为了**零配置能把交互走一遍**：
 * 让人看到工具卡片、审批、提问、挂起与恢复，而不是卡在「请先配置云沙盒 key」。
 *
 * ## 文件存哪
 *
 * 内存里的东西进程一死就没了，所以**每轮收尾存一份快照**。存哪由宿主给（`LocalSnapshotStore`）：
 * Node 版存进共享库的 `local_workspaces` 表；Cloudflare 版存进会话对象自己的 SQLite（同一张表的
 * 形状，见 `kyselySnapshotStore`）。下一轮从缓存拿；缓存没有（重启了、或者这一轮落在别的副本上）
 * 就从存储里恢复。
 *
 * 快照带版本号，取的时候比一下：A 跑完第一轮、B 接手跑了第二轮，再回到 A 时，A 手里那份
 * 已经过期——比版本号就能发现，重新读一次库，而不是拿旧文件接着干。
 */
import type { RunkoExec, RunkoFS } from '@runko/core';
import { justBash } from '@runko/just-bash';
import type { MemoryFSSnapshot } from '@runko/virtual-fs';
import { MemoryFS } from '@runko/virtual-fs';
import type { Kysely } from 'kysely';

import type { LocalWorkspacesTable } from '../db/schema.js';
import type { Logger } from '../logger.js';
import { logger as defaultLogger } from '../logger.js';
import type {
  CreateSandboxParams,
  ProvisionedSandbox,
  ResumeResult,
  SandboxProvider,
} from './sandbox-manager.js';

const LOG_SCOPE = 'local-sandbox';

/** 新会话里预置的示例项目——有东西可读、可改、可删，命令才演示得起来。 */
const SEED_FILES: Record<string, string> = {
  '/README.md': [
    '# 示例项目',
    '',
    '这是本地沙盒里预置的一个小项目，用来试手。它跑在服务端进程的内存里：',
    '没有 git，也连不了网。',
    '',
    '试试对 agent 说：',
    '',
    '- `run: ls -la`',
    '- `run: cat src/index.js`',
    '- `run: rm -rf dist`（危险命令，会弹审批卡片）',
    '- `ask: 这个项目是做什么的？`（会弹提问卡片）',
    '',
  ].join('\n'),
  '/package.json': `${JSON.stringify(
    { name: 'demo-project', version: '1.0.0', main: 'src/index.js' },
    null,
    2,
  )}\n`,
  '/src/index.js': [
    "const greeting = 'hello from the local sandbox';",
    '',
    'console.log(greeting);',
    '',
  ].join('\n'),
  '/dist/bundle.js': "console.log('built artifact');\n",
  '/notes.txt': '随手记：这个文件可以改、可以删。\n',
  '/.agents/skills/demo/SKILL.md': [
    '---',
    'name: demo',
    'description: 演示用的 skill，说明这个示例项目怎么改',
    '---',
    '',
    '# demo',
    '',
    '改这个项目时：先读 README.md，再动 src/ 下的文件。',
    '',
  ].join('\n'),
};

function seedWorkspace(): MemoryFS {
  const fs = new MemoryFS();
  for (const [path, content] of Object.entries(SEED_FILES)) {
    void fs.writeFile(path, content);
  }
  return fs;
}

// ---------------------------------------------------------------------------
// 快照的存取
// ---------------------------------------------------------------------------

interface StoredSnapshot {
  version: number;
  snapshot: MemoryFSSnapshot;
}

/**
 * 库里那一行 → 快照。**解析不出来就当没有**（记一行 warn，会话退回一个全新的示例项目）：
 * 一个坏掉的快照不该让会话再也打不开。
 */
function isSnapshot(value: unknown): value is MemoryFSSnapshot {
  return (
    typeof value === 'object' &&
    value !== null &&
    'files' in value &&
    'dirs' in value &&
    typeof value.files === 'object' &&
    value.files !== null &&
    Array.isArray(value.dirs) &&
    value.dirs.every((dir) => typeof dir === 'string')
  );
}

function parseSnapshot(raw: string): MemoryFSSnapshot | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return isSnapshot(parsed) ? parsed : undefined;
}

/** 快照存哪：读出库里那一行的原文、写回一份新的。解析与版本比较在本文件里，存储只管字节。 */
export interface LocalSnapshotStore {
  read(
    sandboxName: string,
  ): Promise<{ version: number; snapshot: string } | undefined>;
  write(sandboxName: string, version: number, snapshot: string): Promise<void>;
}

/** 快照那张表。有它的任何 Kysely 实例都行：Node 版的共享库，或会话对象自己的 SQLite。 */
export interface SnapshotTables {
  local_workspaces: LocalWorkspacesTable;
}

export function kyselySnapshotStore<DB extends SnapshotTables>(
  host: Kysely<DB>,
): LocalSnapshotStore {
  // `Kysely<DB>` 在 DB 上不变（invariant），「宿主的库里有这张表」这层子类型关系传不过去；
  // `DB extends SnapshotTables` 已经保证了表在，这里只查这一张，收窄是安全的。
  const db = host as unknown as Kysely<SnapshotTables>;
  return {
    async read(sandboxName) {
      const row = await db
        .selectFrom('local_workspaces')
        .select(['version', 'snapshot'])
        .where('sandbox_name', '=', sandboxName)
        .executeTakeFirst();
      return row === undefined ? undefined : (
          { version: Number(row.version), snapshot: row.snapshot }
        );
    },
    async write(sandboxName, version, snapshot) {
      const payload = {
        sandbox_name: sandboxName,
        version,
        snapshot,
        updated_at: Date.now(),
      };
      await db
        .insertInto('local_workspaces')
        .values(payload)
        .onConflict((oc) =>
          oc.column('sandbox_name').doUpdateSet({
            version: payload.version,
            snapshot: payload.snapshot,
            updated_at: payload.updated_at,
          }),
        )
        .execute();
    },
  };
}

async function readSnapshot(
  store: LocalSnapshotStore,
  sandboxName: string,
  log: Logger,
): Promise<StoredSnapshot | undefined> {
  const row = await store.read(sandboxName);
  if (row === undefined) {
    return undefined;
  }
  const snapshot = parseSnapshot(row.snapshot);
  if (snapshot === undefined) {
    log.warn(
      LOG_SCOPE,
      'stored workspace snapshot is unreadable, starting fresh',
      {
        sandboxName,
      },
    );
    return undefined;
  }
  return { version: row.version, snapshot };
}

/**
 * 快照超过 `maxSnapshotBytes` 时抛它：这一轮的改动没进快照。进程（会话对象）还在时，下一轮
 * 照样用内存里那份、改动都在；进程一重启，就回到上一份存下来的快照。
 */
export class LocalWorkspaceTooLargeError extends Error {
  constructor(
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(
      `本地沙盒的文件太大了（约 ${String(Math.ceil(bytes / 1024 / 1024))} MB，上限 ` +
        `${String(Math.floor(limit / 1024 / 1024))} MB），这一轮的改动没存进快照，重启后会丢。` +
        '大项目请新建一个用云沙盒的会话。',
    );
    this.name = 'LocalWorkspaceTooLargeError';
  }
}

// ---------------------------------------------------------------------------
// provider
// ---------------------------------------------------------------------------

interface CachedWorkspace {
  fs: MemoryFS;
  exec: RunkoExec;
  /** 手上这份是库里的第几版。库里更新了就说明别的副本跑过一轮，缓存作废。 */
  version: number;
}

/**
 * 快照存哪：给 `db`（有 `local_workspaces` 表的 Kysely 实例）就用它，给 `snapshots` 就用自定义的存储。
 */
export type LocalProviderDeps<DB extends SnapshotTables = SnapshotTables> = (
  | { db: Kysely<DB>; snapshots?: undefined }
  | { snapshots: LocalSnapshotStore; db?: undefined }
) & {
  logger?: Logger;
  /**
   * 快照最多多大（字节，按 JSON 长度算）。不给 = 不限。Cloudflare 版要给：会话对象的内存上限是
   * 128 MB，文件全在内存里，快照还要再序列化一份。
   */
  maxSnapshotBytes?: number;
};

export function createLocalProvider<DB extends SnapshotTables>(
  deps: LocalProviderDeps<DB>,
): SandboxProvider {
  const log = deps.logger ?? defaultLogger;
  const store: LocalSnapshotStore =
    deps.snapshots === undefined ?
      kyselySnapshotStore(deps.db)
    : deps.snapshots;
  const cache = new Map<string, CachedWorkspace>();

  const provision = (
    sandboxName: string,
    entry: CachedWorkspace,
  ): ProvisionedSandbox => {
    cache.set(sandboxName, entry);
    const workspace: RunkoFS & RunkoExec = {
      readFile: (path) => entry.fs.readFile(path),
      writeFile: (path, data) => entry.fs.writeFile(path, data),
      rm: (path, opts) => entry.fs.rm(path, opts),
      mkdir: (path) => entry.fs.mkdir(path),
      readdir: (path) => entry.fs.readdir(path),
      stat: (path) => entry.fs.stat(path),
      glob: (pattern) => entry.fs.glob(pattern),
      exec: (req, opts) => entry.exec.exec(req, opts),
      describe: () => entry.exec.describe?.() ?? '',
      defaultApproval: entry.exec.defaultApproval,
    };
    return {
      // 本地沙盒没有厂商生命周期，`keepAlive` 这一面永远用不到，补一个空实现让形状对齐。
      workspace: { ...workspace, keepAlive: () => Promise.resolve() },
      resumeToken: sandboxName,
      ensureLifetime: () => Promise.resolve(),
      persist: async () => {
        const next = entry.version + 1;
        const snapshot = JSON.stringify(entry.fs.snapshot());
        if (
          deps.maxSnapshotBytes !== undefined &&
          snapshot.length > deps.maxSnapshotBytes
        ) {
          throw new LocalWorkspaceTooLargeError(
            snapshot.length,
            deps.maxSnapshotBytes,
          );
        }
        await store.write(sandboxName, next, snapshot);
        entry.version = next;
      },
    };
  };

  const fromSnapshot = (stored: StoredSnapshot): CachedWorkspace => {
    const fs = new MemoryFS();
    fs.restore(stored.snapshot);
    return { fs, exec: justBash(fs), version: stored.version };
  };

  return {
    id: 'local',
    usesGit: false,

    create(params: CreateSandboxParams): Promise<ProvisionedSandbox> {
      const fs = seedWorkspace();
      const entry: CachedWorkspace = { fs, exec: justBash(fs), version: 0 };
      log.info(LOG_SCOPE, 'created local workspace', {
        sandboxName: params.name,
      });
      return Promise.resolve(provision(params.name, entry));
    },

    async resume(resumeToken: string): Promise<ResumeResult> {
      const stored = await readSnapshot(store, resumeToken, log);
      const cached = cache.get(resumeToken);
      if (stored === undefined) {
        // 库里没有快照：要么是这个会话从没跑完过一轮，要么快照坏了。手上还有缓存就接着用。
        return cached === undefined ?
            { kind: 'unavailable' }
          : { kind: 'ok', sandbox: provision(resumeToken, cached) };
      }
      if (cached !== undefined && cached.version >= stored.version) {
        return { kind: 'ok', sandbox: provision(resumeToken, cached) };
      }
      return {
        kind: 'ok',
        sandbox: provision(resumeToken, fromSnapshot(stored)),
      };
    },

    /** 本地沙盒不会「没了」：文件要么在内存里，要么在库里，两处都没有就当新会话重建。 */
    isGone(): boolean {
      return false;
    },
  };
}
