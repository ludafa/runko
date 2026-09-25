/**
 * **两个真进程，共用一个库。** 这是多副本这件事**唯一真正的证明**——一个进程里起两个
 * `Arbitration` 实例已经能验令牌 CAS（见 `@runko/persist-kysely` 的仲裁用例），但
 * **进程崩溃、连接池各自独立、被冻住又活过来**这些只有跨进程才有。
 *
 * 用的是 SQLite 文件而不是 Postgres：一个文件对两个进程就是
 * [Node 长驻](../../../../docs/host/node/tech/deployment.md)里的「同机多进程」那一档，
 * 走的代码路径与 Postgres 完全相同（同一个 `leaseArbitration`，只是方言不同），而且
 * **不需要任何外部服务**。配了 `DATABASE_URL` 时改用真 Postgres（`helpers/env.ts` 的
 * `selectDb`），CI 用得上。
 *
 * 接管要等多久由租约说了算，所以等待一律用轮询（`retryWhileHolderUnreachable` / `waitFor`），不写死时长。
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  onTestFailed,
} from 'vitest';

import { signUp } from './helpers/auth.js';
import {
  createConversation,
  foldMessages,
  getActivity,
  parseStartTurnAck,
  readLedger,
  retryWhileHolderUnreachable,
  sendMessage,
  waitUntilInactive,
} from './helpers/chat-client.js';
import {
  EFFECTIVE_TAKEOVER_MS,
  replicaIdentityEnv,
  selectDb,
} from './helpers/env.js';
import type { Replica } from './helpers/process.js';
import {
  createReplicaRegistry,
  dumpReplicaLogs,
  killReplica,
  signalReplica,
} from './helpers/process.js';
import { sleep, waitFor } from './helpers/wait.js';

/** 接管轮询的总预算：真实默认阈值（60s）之上再留富余；见文件头「已知缺口」。 */
const TAKEOVER_POLL_BUDGET_MS = EFFECTIVE_TAKEOVER_MS + 10_000;

const registry = createReplicaRegistry();

let tmpDir: string;
let dbPath: string;
let a: Replica;
let b: Replica;
let cookie: string;

/** 没有 `run:`/`ask:` 前缀，也不需要审批——多副本这份文件只关心归属，approval 语义交给 `suspend-resume.e2e.test.ts`。 */
function startReplicaEnv(port: number): Record<string, string> {
  return {
    ...selectDb(dbPath).env,
    ...replicaIdentityEnv({ port }),
    CHAT_APPROVAL_MODE: 'off',
    CHAT_DEMO_DELAY_MS: '200',
  };
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'runko-multi-'));
  dbPath = join(tmpDir, 'demo.db');
  a = await registry.start({
    name: 'A',
    port: 3921,
    env: startReplicaEnv(3921),
  });
  b = await registry.start({
    name: 'B',
    port: 3922,
    env: startReplicaEnv(3922),
  });
  const user = await signUp(a.url, {
    email: `multi-replica-${randomUUID()}@example.com`,
    password: 'e2e-test-password-1',
    name: 'Multi Replica Tester',
  });
  cookie = user.cookie;
}, 60_000);

afterAll(() => {
  registry.killAll();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('多副本：两个真进程共用一个库', () => {
  it('场景①：归属只落在一个副本上，打到另一个副本的请求被转过去', async () => {
    onTestFailed(() => {
      dumpReplicaLogs(registry.all());
    });

    // 登录态不绑单个进程：在 A 上换来的 cookie，原样带到 B 也认（同库同 secret）。
    const crossNodeAuth = await fetch(`${b.url}/api/chat/conversations`, {
      headers: { cookie },
    });
    expect(crossNodeAuth.status).toBe(200);

    const id = await createConversation(a, cookie, '多副本 · 转发');

    // A 起轮。
    expect(
      await parseStartTurnAck(await sendMessage(a, cookie, id, '第一条')),
    ).toMatchObject({ mode: 'started' });
    await waitFor(
      async () => (await getActivity(a, cookie, id)).active,
      10_000,
      'A 上这一轮已登记为在跑',
    );

    // B 上看同一份对话：**权威答案说有轮在跑，而且不在本地**——这正是接入层据以转发的信号。
    expect(await getActivity(b, cookie, id)).toMatchObject({
      active: true,
      local: false,
      holder: a.url,
    });

    // 同一条会话再往 B 发一句：B 抢不到归属 → 拿着 holder 转给 A → A 排队。
    // 转发没接通的话这里会是 503。
    const second = await sendMessage(b, cookie, id, '第二条');
    expect(second.status).toBe(202);
    expect(await parseStartTurnAck(second)).toMatchObject({ mode: 'queued' });

    // 两条用户消息各进账本一次，不多不少；从 B 读也一样——账本是权威共享状态。
    await waitFor(
      async () =>
        (await readLedger(a, cookie, id)).filter(
          (frame) => frame.message.role === 'user',
        ).length === 2,
      30_000,
      '两条用户消息都落账本',
    );
    const framesFromB = await readLedger(b, cookie, id);
    const seqs = framesFromB.map((frame) => frame.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(seqs.length);
  }, 60_000);

  it('场景②：SSE 订阅打到非持有者，也能看到那一轮的内容', async () => {
    onTestFailed(() => {
      dumpReplicaLogs(registry.all());
    });

    const id = await createConversation(b, cookie, '多副本 · SSE 转发');
    await sendMessage(b, cookie, id, '看流');
    await waitFor(
      async () => (await getActivity(b, cookie, id)).active,
      10_000,
      'B 上这一轮已登记为在跑',
    );

    // 打 A（非持有者）的 activity：权威答案说不在本地、持有者是 B——这正是接入层
    // 据以把 SSE 转发出去的同一个信号。
    expect(await getActivity(a, cookie, id)).toMatchObject({
      active: true,
      local: false,
      holder: b.url,
    });

    // 从 A 订阅（A 不是持有者）。它应当把整条流转发给 B，而不是回一句「没有轮在跑」。
    const res = await fetch(`${a.url}/api/chat/conversations/${id}/stream`, {
      headers: { cookie },
      signal: AbortSignal.timeout(30_000),
    });
    expect(res.ok).toBe(true);
    const text = await res.text();
    expect(text).toContain('event: turn-state');
    // 关键：**不是** `"turnActive":false`。那才是本地登记表会给出的假象；转发之后读到的
    // 是权威持有者（B）那侧的真实状态。
    expect(text).toContain('"turnActive":true');
  }, 60_000);

  it(
    '场景③：持有者被 kill -9，另一个副本在租约过期后接管得了（含跨副本文件延续）',
    async () => {
      onTestFailed(() => {
        dumpReplicaLogs(registry.all());
      });

      const id = await createConversation(a, cookie, '多副本 · 接管');

      // 先让 A 完整跑完一轮真的写文件的命令——这样接管之后才有东西可验证「B 接得上
      // A 留下的工作区」（本地沙盒的文件快照落在 `local_workspaces` 表，不在进程内存）。
      expect(
        await parseStartTurnAck(
          await sendMessage(a, cookie, id, 'run: echo hi > /a.txt'),
        ),
      ).toMatchObject({
        mode: 'started',
      });
      await waitUntilInactive(a, cookie, id, 30_000);

      // 再起一轮，跑到一半就把 A 杀掉——这条会话的归属现在「没放」，只能靠接管阈值过期收拾。
      await sendMessage(a, cookie, id, '跑一半就死');
      await waitFor(
        async () => (await getActivity(a, cookie, id)).active,
        10_000,
        'A 上第二轮已登记为在跑',
      );

      await killReplica(a);

      // 接管前 B 抢不到（撞上「转发目标够不着」的 503）；接管阈值过去之后才行。
      const takeover = await retryWhileHolderUnreachable(
        () => sendMessage(b, cookie, id, '我来接手'),
        TAKEOVER_POLL_BUDGET_MS,
      );
      expect(takeover.status).toBe(202);
      expect(await parseStartTurnAck(takeover)).toMatchObject({
        mode: 'started',
      });

      // A 没了，只能从 B 读；账本仍然是干净的。
      await waitUntilInactive(b, cookie, id, 30_000);
      const rows = await readLedger(b, cookie, id);
      const seqs = rows.map((frame) => frame.seq);
      expect(new Set(seqs).size).toBe(seqs.length);

      // 跨副本文件延续：A 早前写的 /a.txt，B 接管之后还读得到。
      expect(
        await parseStartTurnAck(
          await sendMessage(b, cookie, id, 'run: cat /a.txt'),
        ),
      ).toMatchObject({
        mode: 'started',
      });
      await waitUntilInactive(b, cookie, id, 30_000);
      const afterCat = foldMessages(await readLedger(b, cookie, id));
      const catPart = afterCat
        .flatMap((message) => message.parts)
        .find(
          (part) =>
            part.input !== undefined &&
            JSON.stringify(part.input).includes('cat /a.txt'),
        );
      expect(catPart).toBeDefined();
      expect(JSON.stringify(catPart?.output)).toContain('hi');
    },
    TAKEOVER_POLL_BUDGET_MS + 40_000,
  );

  it(
    '场景④：被误判的老持有者活过来之后，写不进账本（这条是核心）',
    async () => {
      onTestFailed(() => {
        dumpReplicaLogs(registry.all());
      });

      // A 已经在场景③里死了，这一条用 B 当老持有者、重新起一个 C 当接管方。
      const c = await registry.start({
        name: 'C',
        port: 3923,
        env: startReplicaEnv(3923),
      });

      const id = await createConversation(b, cookie, '多副本 · 冻结旧持有者');
      await sendMessage(b, cookie, id, '冻住我');
      await waitFor(
        async () => (await getActivity(b, cookie, id)).active,
        10_000,
        'B 上这一轮已登记为在跑',
      );

      // **冻住 B**：进程还在，只是不跑了——心跳因此停掉，而它自己毫不知情。
      // 这正是「你没法知道远处那个节点是死了还是只是联系不上」的实景。
      signalReplica(b, 'SIGSTOP');

      // **先等租约过期，再发第一条消息。** 冻结期间发出去的请求会被转发给 B，而 B 的内核
      // 照样完成握手、把请求收进缓冲区——它一解冻就会挨个处理，凭空多跑好几轮。那是
      // 「冻住的进程醒来后会把积压的请求做掉」这条已知限制，不是本条要验的事。
      await waitFor(
        async () => !(await getActivity(c, cookie, id)).active,
        TAKEOVER_POLL_BUDGET_MS,
        'B 的租约过期、谁都可以接管',
      );
      const takeover = await retryWhileHolderUnreachable(
        () => sendMessage(c, cookie, id, '我接管了'),
        TAKEOVER_POLL_BUDGET_MS,
      );
      expect(takeover.status).toBe(202);
      expect(await parseStartTurnAck(takeover)).toMatchObject({
        mode: 'started',
      });
      await waitUntilInactive(c, cookie, id, 30_000);
      const afterTakeover = await readLedger(c, cookie, id);

      // 唤醒 B。它的模型这时才吐完，于是它去取号、去写账本——**必须被拒**。
      signalReplica(b, 'SIGCONT');
      await sleep(8_000); // 给 B 被冻结前剩下的那点流跑完 + 尝试写账本一点余量

      const rows = await readLedger(c, cookie, id);
      // 账本没被写坏：序号唯一、递增，而且**没有多出 B 那一轮的成品消息**。
      const seqs = rows.map((frame) => frame.seq);
      expect(new Set(seqs).size).toBe(seqs.length);
      expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
      expect(rows.length).toBe(afterTakeover.length);
    },
    TAKEOVER_POLL_BUDGET_MS + 40_000,
  );
});
