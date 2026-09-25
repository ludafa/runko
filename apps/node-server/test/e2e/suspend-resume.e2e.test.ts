/**
 * **挂起与恢复的核心验收：两个真进程，共用一个库。**
 *
 * 副本 A 起一轮 → 模型要跑一条命令 / 问一句 → 等人审批或回答 → 等满内存窗口 → 挂起、放手
 * → **A 被 `kill -9`** → 人把答案发给副本 B → B 从账本与裁决表里接上，执行的正是 A 那一轮
 * 悬着的那次调用，然后跑完。
 *
 * 为什么非得两个进程：挂起的承诺是「人回来**在任意节点**接着干」。一个进程里怎么测，答案都
 * 还在同一块内存里，证明不了它真的只靠库。A 被 `kill -9` 就是把「靠内存」这条退路堵死。
 *
 * **与 `multi-replica.e2e.test.ts` 的一个关键差别**：这里不依赖归属仲裁的接管阈值——
 * 挂起时框架会主动放掉归属（`docs/logic/orchestration/tech/suspend-resume.md`），B 接手不用等
 * 任何超时。所以这份文件不受 `RUNKO_HEARTBEAT_MS`/`RUNKO_TAKEOVER_MS` 那个环境变量接线缺口
 * 影响（见 `helpers/env.ts`），四条场景都能在几秒到十几秒内跑完。
 *
 * 默认用 SQLite 共享文件跑；配了 `DATABASE_URL` 时改用真 Postgres（`helpers/env.ts` 的
 * `selectDb`）。
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, onTestFailed } from 'vitest';

import { signUp } from './helpers/auth.js';
import {
  createConversation,
  findToolPart,
  foldMessages,
  getActivity,
  parseStartTurnAck,
  postAnswer,
  postApproval,
  readLedger,
  retryWhileHolderUnreachable,
  sendMessage,
  waitForApprovalCallId,
  waitForSuspended,
  waitUntilCompleted,
  waitUntilInactive,
} from './helpers/chat-client.js';
import { replicaIdentityEnv, selectDb } from './helpers/env.js';
import type { Replica } from './helpers/process.js';
import {
  createReplicaRegistry,
  dumpReplicaLogs,
  killReplica,
} from './helpers/process.js';
import type { LedgerMessage } from './helpers/schemas.js';
import { waitFor } from './helpers/wait.js';

const registry = createReplicaRegistry();

const sqliteDir = mkdtempSync(join(tmpdir(), 'runko-suspend-'));
const db = selectDb(join(sqliteDir, 'demo.db'));

afterAll(() => {
  registry.killAll();
  rmSync(sqliteDir, { recursive: true, force: true });
});

let nextPort = 3941;

/** 一对副本：bash 全审（`CHAT_APPROVAL_MODE=all`），内存窗口按参数给。 */
async function startPair(memoryWindowMs: number): Promise<[Replica, Replica]> {
  const portA = nextPort++;
  const portB = nextPort++;
  const base = {
    ...db.env,
    CHAT_APPROVAL_MODE: 'all',
    CHAT_SUSPEND_MEMORY_WINDOW: String(memoryWindowMs),
  };
  const a = await registry.start({
    name: 'A',
    port: portA,
    env: { ...base, ...replicaIdentityEnv({ port: portA }) },
  });
  const b = await registry.start({
    name: 'B',
    port: portB,
    env: { ...base, ...replicaIdentityEnv({ port: portB }) },
  });
  return [a, b];
}

/**
 * 登录态只换一次——四个场景各自起新的一对副本，但共用同一个 SQLite 文件（`db`），
 * 所以在任意一对的 A 上换出来的 cookie，后面几对也认（同库同 secret）。
 */
let sharedCookie: string | undefined;

async function authedCookie(replica: Replica): Promise<string> {
  if (sharedCookie !== undefined) {
    return sharedCookie;
  }
  const user = await signUp(replica.url, {
    email: `suspend-resume-${randomUUID()}@example.com`,
    password: 'e2e-test-password-1',
    name: 'Suspend Resume Tester',
  });
  sharedCookie = user.cookie;
  return sharedCookie;
}

describe(`挂起与恢复 · 两个真进程 · ${db.label}`, () => {
  it('场景①（审批）：A 挂起后被 kill -9，人把「允许」发给 B，B 执行的正是账本里那条命令', async () => {
    onTestFailed(() => {
      dumpReplicaLogs(registry.all());
    });

    const [a, b] = await startPair(500);
    const cookie = await authedCookie(a);
    const id = await createConversation(a, cookie, '挂起 · 审批');

    expect(
      await parseStartTurnAck(
        await sendMessage(a, cookie, id, 'run: echo resumed-from-ledger'),
      ),
    ).toMatchObject({
      mode: 'started',
    });
    const { callId, message } = await waitForSuspended(a, cookie, id);

    // 挂起的三个承诺：调用原样留在账本末尾、归属放掉了、理由是窗口到点。
    expect(findToolPart(message, callId)).toMatchObject({
      state: 'approval-requested',
      input: { command: 'echo resumed-from-ledger' },
    });
    expect(message.metadata?.suspended?.reason).toBe('timeout');
    await waitUntilInactive(b, cookie, id, 10_000);

    // 堵死「靠内存」这条退路。
    await killReplica(a);

    // 答复打到 B：没有持有者 → B 自己答 → 写裁决表 → 推一把 → 恢复。
    const answered = await retryWhileHolderUnreachable(
      () => postApproval(b, cookie, id, callId, 'allow'),
      15_000,
    );
    expect(answered.status).toBe(200);

    const messages = await waitUntilCompleted(b, cookie, id, 20_000);

    // 那次调用在**原位**有了结果：同一个 id 的消息被改写，而不是在末尾多出一份。
    const resumed = messages.find((candidate) => candidate.id === message.id);
    const part = findToolPart(resumed, callId);
    expect(part).toMatchObject({
      state: 'output-available',
      input: { command: 'echo resumed-from-ledger' },
    });
    expect(JSON.stringify(part?.output)).toContain('resumed-from-ledger');
    expect(
      messages.filter((candidate) => candidate.id === message.id),
    ).toHaveLength(1);
    // 恢复那一轮没有用户消息：人没说话，只是答了一张卡片。
    expect(
      messages.filter((candidate) => candidate.role === 'user'),
    ).toHaveLength(1);
    // 成品消息落盘在放手之前，所以账本说「做完了」时归属可能还没放——等它放掉。
    await waitUntilInactive(b, cookie, id, 10_000);

    // 同一张卡片再答一次：那一行已经答过了。
    const again = await postApproval(b, cookie, id, callId, 'deny');
    expect(again.status).toBe(404);

    await killReplica(b);
  }, 90_000);

  it('场景②（ask-user）：A 挂起后被 kill -9，答案发给 B，B 把它当工具结果接着跑', async () => {
    onTestFailed(() => {
      dumpReplicaLogs(registry.all());
    });

    const [a, b] = await startPair(500);
    const cookie = await authedCookie(a);
    const id = await createConversation(a, cookie, '挂起 · 提问');

    await sendMessage(a, cookie, id, 'ask: 继续吗？');
    const { callId, message } = await waitForSuspended(a, cookie, id);
    expect(findToolPart(message, callId)).toMatchObject({
      state: 'input-available',
    });
    await waitUntilInactive(b, cookie, id, 10_000);

    await killReplica(a);

    const answered = await retryWhileHolderUnreachable(
      () => postAnswer(b, cookie, id, callId, '要，继续'),
      15_000,
    );
    expect(answered.status).toBe(200);

    const messages = await waitUntilCompleted(b, cookie, id, 20_000);
    const part = findToolPart(
      messages.find((candidate) => candidate.id === message.id),
      callId,
    );
    expect(part).toMatchObject({
      state: 'output-available',
      output: '要，继续',
    });

    await killReplica(b);
  }, 90_000);

  it('场景③：挂起期间发来的消息——先排队，人答完、恢复那一轮收尾后才跑', async () => {
    onTestFailed(() => {
      dumpReplicaLogs(registry.all());
    });

    const [a, b] = await startPair(500);
    const cookie = await authedCookie(a);
    const id = await createConversation(a, cookie, '挂起 · 排队');

    await sendMessage(a, cookie, id, 'run: echo resumed-from-ledger');
    const { callId } = await waitForSuspended(a, cookie, id);

    // 这时候不能起普通轮（悬空调用后面接用户消息，模型服务商会拒），只能排队。
    const queued = await sendMessage(b, cookie, id, '顺便看看 README');
    expect(await parseStartTurnAck(queued)).toMatchObject({ mode: 'queued' });

    await postApproval(a, cookie, id, callId, 'allow');

    // 恢复那一轮收尾时推一把，排队的那条接着跑——这条消息没有 run:/ask: 前缀，演示模型
    // 只会回一段普通文字，这里只看它排在恢复结果之后、且跑完，不关心它具体怎么收尾。
    let messages: LedgerMessage[] = [];
    await waitFor(
      async () => {
        messages = foldMessages(await readLedger(b, cookie, id));
        const queuedAt = messages.findIndex((candidate) =>
          JSON.stringify(candidate.parts).includes('顺便看看 README'),
        );
        const resumedAt = messages.findIndex(
          (candidate) =>
            findToolPart(candidate, callId)?.state === 'output-available',
        );
        return (
          queuedAt >= 0 &&
          resumedAt >= 0 &&
          queuedAt > resumedAt &&
          !(await getActivity(b, cookie, id)).active
        );
      },
      30_000,
      '排队那条被出队、跑完',
    );

    const texts = messages
      .filter((candidate) => candidate.role === 'user')
      .map((candidate) => JSON.stringify(candidate.parts));
    expect(texts[1]).toContain('顺便看看 README');
    // 排队那条一定排在那次调用的结果之后——它从没被插进悬空调用与结果之间。
    const resumedIndex = messages.findIndex(
      (candidate) =>
        findToolPart(candidate, callId)?.state === 'output-available',
    );
    const queuedIndex = messages.findIndex((candidate) =>
      JSON.stringify(candidate.parts).includes('顺便看看 README'),
    );
    expect(resumedIndex).toBeGreaterThanOrEqual(0);
    expect(queuedIndex).toBeGreaterThan(resumedIndex);

    await killReplica(a);
    await killReplica(b);
  }, 90_000);

  it('场景④：内存窗口内的答复打到非持有者——照旧转发给持有者，在内存里直接接上，不挂起', async () => {
    onTestFailed(() => {
      dumpReplicaLogs(registry.all());
    });

    const [a, b] = await startPair(30_000); // 窗口给足 30 秒，够我们读流、答复
    const cookie = await authedCookie(a);
    const id = await createConversation(a, cookie, '挂起 · 窗口内应答');

    await sendMessage(a, cookie, id, 'run: echo window-answer');
    // 等卡片出现：账本里还没有（成品消息收尾才落盘），但持有者的直播流上有。
    await waitFor(
      async () => (await getActivity(b, cookie, id)).holder === a.url,
      10_000,
      'A 登记为持有者',
    );
    const callId = await waitForApprovalCallId(a, cookie, id, 10_000);

    const answered = await postApproval(b, cookie, id, callId, 'allow');
    expect(answered.status).toBe(200);

    const messages = await waitUntilCompleted(b, cookie, id, 20_000);
    // 一次都没挂起：整个会话里没有任何一条 suspended 收尾。
    expect(
      messages.some((candidate) => candidate.metadata?.status === 'suspended'),
    ).toBe(false);

    await killReplica(a);
    await killReplica(b);
  }, 60_000);
});
