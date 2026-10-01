/**
 * 端到端集成用例（docs/ingress/tech/github-repo-access.md §9）——**不设任何门禁，跟着
 * `pnpm test` 正常跑**（文件名故意不是 `*.e2e.test.ts`：那个后缀在这个包里约定为「需要
 * Docker/真凭据，默认跳过」，这份不需要）。
 *
 * 全程零真实网络、零真实沙盒：
 *
 * - **假 GitHub**：真的 `node:http` 服务器 + 真的一对 RSA 密钥（`test/helpers/fake-github-http.ts`），
 *   真验 App JWT 的签名。
 * - **假云沙盒**：结构化实现 `SandboxProvider`，配真的 `createSandboxManager()`——记录
 *   克隆参数、写过的文件、跑过的命令。
 * - **真 chat 应用**：`buildChatApp` + `createGithubRoutes`，一路从 HTTP 入口走到底。
 * - **假模型**：`ai/test` 的 `MockLanguageModelV4`（`capturingModel`），核心跑的是真
 *   `@runko/core` 的 session/turn 逻辑。
 *
 * 令牌「快过期」用 `vi.useFakeTimers()` 把系统时钟拨快——**同一个进程**，假 GitHub 的
 * `Date.now()` 与 `createGithubApp` 的默认 `now` 因此保持一致，不会出现「JWT 用未来的
 * 时间签、服务器拿真实时钟验签」这种自相矛盾（早前在 `github-app.test.ts` 里试过用一个
 * 独立注入的假 `now` 来模拟快过期，结果 JWT 的 `iat/exp` 相对真实时钟变得不合法，
 * 被假服务器拒签——所以这里改用「拨动全局时钟」而不是「只改客户端的 now」）。
 */
import { generateKeyPairSync } from 'node:crypto';

import { OpenAPIHono } from '@hono/zod-openapi';
import type {
  VercelFileSystemLike,
  VercelSandboxLike,
} from '@runko/sandbox-vercel';
import { vercelWorkspace } from '@runko/sandbox-vercel';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { createGithubApp } from '../../src/agent/github-app.js';
import { createChatPersistence } from '../../src/agent/persistence.js';
import type {
  CreateSandboxParams,
  ProvisionedSandbox,
  ResumeResult,
  SandboxProvider,
} from '../../src/agent/sandbox-manager.js';
import { createSandboxManager } from '../../src/agent/sandbox-manager.js';
import type { Db } from '../../src/agent/store.js';
import { createGithubRoutes } from '../../src/routes/github.js';
import { ConversationSchema } from '../../src/schemas/chat.js';
import type {
  GithubReposResponseDto,
  GithubStatusDto,
} from '../../src/schemas/github.js';
import { buildChatApp, fakeAuthMiddleware } from '../helpers/chat-app.js';
import type { FakeGithubHttpServer } from '../helpers/fake-github-http.js';
import { startFakeGithubHttp } from '../helpers/fake-github-http.js';
import { capturingModel } from '../helpers/mock-model.js';
import {
  createTestDb,
  linkGithubAccount,
  seedUser,
} from '../helpers/test-db.js';

const APP_ID = 'integration-test-app-id';
const USER_ID = 'integration-user-1';
const USER_TOKEN = 'integration-user-token';
const REPO_ID = 1;
const INSTALLATION_ID = 1;

// ---------------------------------------------------------------------------
// 假云沙盒 provider（vercel 档）：结构化实现，配真的 `vercelWorkspace()` 适配器，
// 记下克隆参数、写过的文件、跑过的每一条命令——与 test/agent/sandbox-manager.test.ts
// 同一手法，这里为「自包含」重新写一份精简版。
// ---------------------------------------------------------------------------

interface RecordedWrite {
  path: string;
  data: string;
}

interface FakeHandle extends ProvisionedSandbox {
  readonly writes: RecordedWrite[];
  readonly commands: string[];
  readonly ensureLifetimeCalls: number[];
}

function fakeFs(writes: RecordedWrite[]): VercelFileSystemLike {
  const notUsed = (): Promise<never> =>
    Promise.reject(new Error('fs not used in this integration test'));
  return {
    readFile: notUsed,
    async writeFile(path, data) {
      writes.push({
        path,
        data: typeof data === 'string' ? data : new TextDecoder().decode(data),
      });
    },
    async mkdir() {
      return undefined;
    },
    readdir: notUsed,
    stat: notUsed,
    rm: notUsed,
    rmdir: notUsed,
  };
}

function makeHandle(name: string): FakeHandle {
  const writes: RecordedWrite[] = [];
  const commands: string[] = [];
  const ensureLifetimeCalls: number[] = [];
  const sandbox: VercelSandboxLike = {
    fs: fakeFs(writes),
    async runCommand(params) {
      const script = params.args?.[1] ?? '';
      commands.push(script);
      if (script.includes('git symbolic-ref')) {
        params.stdout?.write('refs/remotes/origin/main\n');
        return { exitCode: 0 };
      }
      if (script.startsWith('git fetch origin')) {
        return { exitCode: 1 }; // 分支从没推送过——逼出 `git checkout -b` 那条兜底
      }
      return { exitCode: 0 };
    },
  };
  return {
    workspace: vercelWorkspace(sandbox),
    resumeToken: name,
    writes,
    commands,
    ensureLifetimeCalls,
    async ensureLifetime(targetMs) {
      ensureLifetimeCalls.push(targetMs);
    },
  };
}

interface FakeCloudProvider {
  provider: SandboxProvider;
  readonly createCalls: CreateSandboxParams[];
  readonly resumeCalls: string[];
  readonly handles: Map<string, FakeHandle>;
}

function createFakeCloudProvider(): FakeCloudProvider {
  const createCalls: CreateSandboxParams[] = [];
  const resumeCalls: string[] = [];
  const handles = new Map<string, FakeHandle>();
  const provider: SandboxProvider = {
    id: 'vercel',
    usesGit: true,
    async create(params) {
      createCalls.push(params);
      const handle = makeHandle(params.name);
      handles.set(params.name, handle);
      return handle;
    },
    async resume(resumeToken: string): Promise<ResumeResult> {
      resumeCalls.push(resumeToken);
      const handle = handles.get(resumeToken);
      return handle === undefined ?
          { kind: 'unavailable' }
        : { kind: 'ok', sandbox: handle };
    },
    isGone: () => false,
  };
  return { provider, createCalls, resumeCalls, handles };
}

// ---------------------------------------------------------------------------

function generateRsaKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

async function ledgerMessages(db: Db, conversationId: string) {
  const entries = await createChatPersistence(db).ledger.read(conversationId);
  return entries.map((entry) => entry.message);
}

describe('端到端：按用户授权加载 GitHub 仓库（docs/ingress/tech/github-repo-access.md §9）', () => {
  let keyPair: { publicKey: string; privateKey: string };
  let server: FakeGithubHttpServer;

  beforeAll(async () => {
    keyPair = generateRsaKeyPair();
    server = await startFakeGithubHttp({
      appId: APP_ID,
      publicKey: keyPair.publicKey,
    });
  });

  afterAll(async () => {
    await server.close();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('连接状态 → 列仓库 → 建会话（核对+签令牌+克隆+写令牌文件+凭据助手）→ 起一轮（缓存命中不重签）→ 快过期重签 → 权限收回后失败', async () => {
    server.setUserInstallations(USER_TOKEN, [INSTALLATION_ID]);
    server.setInstallationRepos(INSTALLATION_ID, [
      {
        id: REPO_ID,
        full_name: 'acme/demo',
        private: false,
        default_branch: 'main',
      },
    ]);

    const db = await createTestDb();
    await seedUser(db, USER_ID);
    await linkGithubAccount(db, USER_ID); // `GET /api/github/status` 的 linked 靠这张表

    const githubApp = createGithubApp({
      env: {
        GITHUB_APP_ID: APP_ID,
        GITHUB_APP_SLUG: 'test-app',
        GITHUB_APP_PRIVATE_KEY: keyPair.privateKey,
        GITHUB_CLIENT_ID: 'client-id',
        GITHUB_CLIENT_SECRET: 'client-secret',
        GITHUB_API_URL: server.url,
      },
      fetch,
      getUserToken: async () => USER_TOKEN,
      // **不能**让 `createGithubApp` 用它自己的默认 `opts.now ?? Date.now`——那样会在
      // 这一行提前把 `Date.now` 这个函数引用捕进闭包；`vi.useFakeTimers()` 之后是把
      // `globalThis.Date`整个换掉，不是就地改写原生 `Date.now` 的实现，早捕获的引用
      // 看不到 `vi.setSystemTime()` 拨过的时间（实测过：捕获在前、启用假时钟在后，
      // 拿到的仍是真实时间）。改成每次调用都现查 `globalThis.Date.now()`，写成箭头函数
      // 转发，而不是再次 `const now = Date.now` 式的提前绑定。
      now: () => Date.now(),
    });

    const cloudProvider = createFakeCloudProvider();
    const sandboxManager = createSandboxManager({
      vercel: cloudProvider.provider,
    });
    const model = capturingModel('turn done');

    const { app: chatAppInstance } = buildChatApp({
      db,
      sandboxManager,
      resolveModel: () => model.model,
      userId: USER_ID,
      githubApp,
    });
    const githubRoutesApp = createGithubRoutes({
      db,
      githubApp,
      authMiddleware: fakeAuthMiddleware(USER_ID),
    });
    const app = new OpenAPIHono();
    app.route('/', chatAppInstance);
    app.route('/', githubRoutesApp);

    // ---- ① GET /api/github/status ----
    const statusResponse = await app.request('/api/github/status');
    expect(statusResponse.status).toBe(200);
    const status = (await statusResponse.json()) as GithubStatusDto;
    expect(status).toEqual({
      configured: true,
      linked: true,
      installUrl: 'https://github.com/apps/test-app/installations/new',
    });

    // ---- ② GET /api/github/repos ----
    const reposResponse = await app.request('/api/github/repos');
    expect(reposResponse.status).toBe(200);
    const repos = (await reposResponse.json()) as GithubReposResponseDto;
    expect(repos.repos).toEqual([
      {
        installationId: INSTALLATION_ID,
        repoId: REPO_ID,
        fullName: 'acme/demo',
        private: false,
        defaultBranch: 'main',
      },
    ]);

    // ---- ③ POST 建会话（云沙盒） ----
    const createResponse = await app.request('/api/chat/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'vercel',
        title: '集成测试会话',
        repo: { installationId: INSTALLATION_ID, repoId: REPO_ID },
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = ConversationSchema.parse(await createResponse.json());
    expect(created.repo).toBe('acme/demo');

    // 假 GitHub 只签过一次安装令牌；克隆参数、令牌文件、凭据助手全部核对到位。
    expect(server.mintedTokenCount()).toBe(1);
    const firstToken = `fake-installation-token-1`;

    expect(cloudProvider.createCalls).toMatchObject([
      {
        cloneUrl: 'https://github.com/acme/demo.git',
        githubToken: firstToken,
      },
    ]);

    const handle = cloudProvider.handles.get(created.sandboxName ?? '');
    expect(handle).toBeDefined();
    if (handle === undefined) {
      return;
    }
    expect(handle.writes).toEqual([
      { path: '/vercel/sandbox/.git/runko-github-token', data: firstToken },
    ]);
    const credentialHelperCmd = handle.commands.find((c) =>
      c.includes('credential.helper'),
    );
    expect(credentialHelperCmd).toContain('--absolute-git-dir');
    expect(handle.commands.some((c) => c.includes(firstToken))).toBe(false);
    const resetRemoteCmd = handle.commands.find((c) =>
      c.startsWith('git remote set-url origin'),
    );
    expect(resetRemoteCmd).toBe(
      'git remote set-url origin "https://github.com/acme/demo.git"',
    );

    // 建会话那一步：`getRepoToken` 核对一次（打一次 `.../repositories`），随后签一次安装令牌。
    const reposCallsAfterCreate = server.requests.filter((r) =>
      r.path.startsWith(
        `/user/installations/${String(INSTALLATION_ID)}/repositories`,
      ),
    );
    // 上面②那次 `GET /api/github/repos` 也打了一次，所以这里是「② + 建会话一次」= 2 次。
    expect(reposCallsAfterCreate.length).toBe(2);
    expect(
      server.requests.filter(
        (r) =>
          r.path ===
          `/app/installations/${String(INSTALLATION_ID)}/access_tokens`,
      ),
    ).toHaveLength(1);

    // ---- ④ 发一条消息，跑第一轮：缓存命中，令牌文件用同一个令牌覆写一遍 ----
    const requestsBeforeTurn1 = server.requests.length;
    const turn1 = await app.request(
      `/api/chat/conversations/${created.id}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello from turn 1' }),
      },
    );
    expect(turn1.status).toBe(202);
    await vi.waitFor(async () => {
      const messages = await ledgerMessages(db, created.id);
      expect(messages).toHaveLength(2);
      expect(messages[1]?.role).toBe('assistant');
    });

    expect(server.mintedTokenCount()).toBe(1); // 没有再签
    expect(server.requests.length).toBe(requestsBeforeTurn1); // 缓存命中，零网络请求
    expect(handle.writes.map((w) => w.data)).toEqual([firstToken, firstToken]);

    // ---- ⑤ 把系统时钟拨快，逼近令牌过期：下一轮该重新核对权限、签新令牌 ----
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 55 * 60 * 1000); // 安装令牌 1 小时过期，剩余 < 10 分钟阈值

    const turn2 = await app.request(
      `/api/chat/conversations/${created.id}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello from turn 2' }),
      },
    );
    expect(turn2.status).toBe(202);
    await vi.waitFor(async () => {
      const messages = await ledgerMessages(db, created.id);
      expect(messages).toHaveLength(4);
      expect(messages[3]?.role).toBe('assistant');
    });

    expect(server.mintedTokenCount()).toBe(2); // 重签了一次
    const secondToken = `fake-installation-token-2`;
    expect(handle.writes.at(-1)).toEqual({
      path: '/vercel/sandbox/.git/runko-github-token',
      data: secondToken,
    });
    expect(secondToken).not.toBe(firstToken);

    // ---- ⑥ 用户在 GitHub 上把仓库从安装里移除；再拨快时钟逼近第二把令牌的过期 ----
    server.setInstallationRepos(INSTALLATION_ID, []);
    vi.setSystemTime(Date.now() + 55 * 60 * 1000);

    const turn3 = await app.request(
      `/api/chat/conversations/${created.id}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello from turn 3' }),
      },
    );
    expect(turn3.status).toBe(202);
    await vi.waitFor(async () => {
      const messages = await ledgerMessages(db, created.id);
      expect(messages).toHaveLength(6);
      expect(messages[5]?.metadata?.status).toBe('failed');
    });
    const finalMessages = await ledgerMessages(db, created.id);
    expect(finalMessages[5]?.metadata?.error?.message).toBe(
      '没有权限访问这个仓库了',
    );
    expect(server.mintedTokenCount()).toBe(2); // 权限核对没过，压根没走到重签那一步
  }, 30_000);
});
