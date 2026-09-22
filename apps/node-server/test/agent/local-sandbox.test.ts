/**
 * [本地沙盒](../../../../docs/terms.md)：文件在进程内存里，所以**每轮收尾存一份快照进库**。
 *
 * 这里守的就是那份快照：存得下、换个进程读得回、别的副本改过之后自己手上那份要作废。
 * 不守的话故障是静默的——用户回来发现自己上一轮写的文件没了，而日志里什么都没有。
 */
import { describe, expect, it } from 'vitest';

import { createLocalProvider } from '../../src/agent/local-sandbox.js';
import type {
  CreateSandboxParams,
  SandboxProvider,
} from '../../src/agent/sandbox-manager.js';
import type { Db } from '../../src/db/instance.js';
import { silentLogger } from '../helpers/silent-logger.js';
import { createTestDb } from '../helpers/test-db.js';

const SANDBOX = 'runko-chat-conv-1';

const CREATE_PARAMS: CreateSandboxParams = {
  name: SANDBOX,
  cloneUrl: '',
  githubPat: '',
  timeoutMs: 60_000,
  keepAlive: { idleTimeoutMs: 60_000 },
};

function provider(db: Db): SandboxProvider {
  return createLocalProvider({ db, logger: silentLogger });
}

async function readFile(
  sandbox: { workspace: { readFile: (path: string) => Promise<Uint8Array> } },
  path: string,
): Promise<string> {
  return new TextDecoder().decode(await sandbox.workspace.readFile(path));
}

describe('本地沙盒', () => {
  it('新建的沙盒里有示例项目，bash 跑得动', async () => {
    const db = await createTestDb();
    const sandbox = await provider(db).create(CREATE_PARAMS);

    expect(await readFile(sandbox, '/README.md')).toContain('示例项目');
    const result = await sandbox.workspace.exec({
      command: 'ls /src',
      signal: new AbortController().signal,
    });
    expect(result.stdout).toContain('index.js');
  });

  it('**不需要 git 与网络**：这一档声明 usesGit=false，建盒时就不会去拉仓库', async () => {
    const db = await createTestDb();
    expect(provider(db).usesGit).toBe(false);
  });

  it('存一份快照，另一个进程恢复出来的是同样的文件', async () => {
    const db = await createTestDb();

    const first = provider(db);
    const created = await first.create(CREATE_PARAMS);
    await created.workspace.writeFile('/notes.txt', '第一轮写的');
    await created.persist?.();

    // 另一个进程：新的 provider 实例，进程内缓存是空的，只能从库里恢复。
    const second = provider(db);
    const resumed = await second.resume(SANDBOX, { idleTimeoutMs: 60_000 });
    expect(resumed.kind).toBe('ok');
    if (resumed.kind !== 'ok') {
      return;
    }
    expect(await readFile(resumed.sandbox, '/notes.txt')).toBe('第一轮写的');
  });

  it('**别的副本跑过一轮之后，自己手上那份缓存作废**', async () => {
    const db = await createTestDb();

    const a = provider(db);
    const createdByA = await a.create(CREATE_PARAMS);
    await createdByA.workspace.writeFile('/notes.txt', 'A 写的');
    await createdByA.persist?.();

    // B 接手，改了文件并存了快照——库里的版本因此比 A 手上那份新。
    const b = provider(db);
    const resumedByB = await b.resume(SANDBOX, { idleTimeoutMs: 60_000 });
    expect(resumedByB.kind).toBe('ok');
    if (resumedByB.kind !== 'ok') {
      return;
    }
    await resumedByB.sandbox.workspace.writeFile('/notes.txt', 'B 写的');
    await resumedByB.sandbox.persist?.();

    // 回到 A：它手上还缓存着自己那份旧的，必须重新去库里读。
    const backToA = await a.resume(SANDBOX, { idleTimeoutMs: 60_000 });
    expect(backToA.kind).toBe('ok');
    if (backToA.kind !== 'ok') {
      return;
    }
    expect(await readFile(backToA.sandbox, '/notes.txt')).toBe('B 写的');
  });

  it('库里没有快照、进程里也没有缓存 → unavailable（交给调用方重建）', async () => {
    const db = await createTestDb();
    const resumed = await provider(db).resume('runko-chat-从没见过', {
      idleTimeoutMs: 60_000,
    });
    expect(resumed.kind).toBe('unavailable');
  });

  it('快照坏了 → 当作没有，不抛（会话退回一个全新的示例项目）', async () => {
    const db = await createTestDb();
    await db
      .insertInto('local_workspaces')
      .values({
        sandbox_name: SANDBOX,
        version: 3,
        snapshot: '{ 这不是 JSON',
        updated_at: Date.now(),
      })
      .execute();

    const resumed = await provider(db).resume(SANDBOX, {
      idleTimeoutMs: 60_000,
    });
    expect(resumed.kind).toBe('unavailable');
  });
});
