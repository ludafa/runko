/**
 * `src/agent/github-app.ts` 的单测（docs/ingress/tech/github-repo-access.md §9）。
 *
 * 网络层用一个**真的** `node:http` 假 GitHub（`test/helpers/fake-github-http.ts`），
 * 配一对测试用真 RSA 密钥（`crypto.generateKeyPairSync`）——假服务器会**真验签**
 * App JWT（RS256、`iss`、`iat`/`exp` 时间窗），签错了就拒，这样签名那段生产代码
 * 也被测到，而不是只测「调用了 fetch」。
 */
import { createVerify, generateKeyPairSync } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  classifyGithubError,
  createGithubApp,
  GithubNotLinkedError,
  GithubRepoForbiddenError,
  isGithubAppConfigured,
  listAccessibleRepos,
  listInstallationRepos,
  listUserInstallations,
  loadGithubAppConfig,
  mintAppJwt,
  mintInstallationToken,
  splitFullName,
  userCanAccessRepo,
} from '../../src/agent/github-app.js';
import type { FakeGithubHttpServer } from '../helpers/fake-github-http.js';
import { startFakeGithubHttp } from '../helpers/fake-github-http.js';

// ---------------------------------------------------------------------------
// 一对测试专用的真 RSA 密钥——假服务器用公钥验签，config 用私钥签发。
// ---------------------------------------------------------------------------

const APP_ID = 'test-app-id';

function generateRsaKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

function decodeJwtPart(part: string): unknown {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

// ---------------------------------------------------------------------------
// loadGithubAppConfig / isGithubAppConfigured —— 纯函数，零网络
// ---------------------------------------------------------------------------

describe('loadGithubAppConfig / isGithubAppConfigured', () => {
  const FULL_ENV: NodeJS.ProcessEnv = {
    GITHUB_APP_ID: '123',
    GITHUB_APP_SLUG: 'test-app',
    GITHUB_APP_PRIVATE_KEY: 'fake-private-key',
    GITHUB_CLIENT_ID: 'client-id',
    GITHUB_CLIENT_SECRET: 'client-secret',
  };

  it('五项齐全 → configured，字段原样带出（缺省 API 地址）', () => {
    const config = loadGithubAppConfig(FULL_ENV);
    expect(config).toBeDefined();
    expect(config?.appId).toBe('123');
    expect(config?.appSlug).toBe('test-app');
    expect(config?.clientId).toBe('client-id');
    expect(config?.clientSecret).toBe('client-secret');
    expect(config?.apiUrl).toBe('https://api.github.com');
    expect(isGithubAppConfigured(FULL_ENV)).toBe(true);
  });

  const REQUIRED_KEYS = [
    'GITHUB_APP_ID',
    'GITHUB_APP_SLUG',
    'GITHUB_APP_PRIVATE_KEY',
    'GITHUB_CLIENT_ID',
    'GITHUB_CLIENT_SECRET',
  ] as const;

  for (const missingKey of REQUIRED_KEYS) {
    it(`缺少 ${missingKey} → 未配置`, () => {
      const partial: NodeJS.ProcessEnv = {
        ...FULL_ENV,
        [missingKey]: undefined,
      };
      expect(loadGithubAppConfig(partial)).toBeUndefined();
      expect(isGithubAppConfigured(partial)).toBe(false);
    });

    it(`${missingKey} 是空字符串 → 同样未配置`, () => {
      const partial: NodeJS.ProcessEnv = { ...FULL_ENV, [missingKey]: '' };
      expect(loadGithubAppConfig(partial)).toBeUndefined();
    });
  }

  it('GITHUB_API_URL 去掉末尾的斜杠（不管几个）', () => {
    expect(
      loadGithubAppConfig({ ...FULL_ENV, GITHUB_API_URL: 'http://x.test/' })
        ?.apiUrl,
    ).toBe('http://x.test');
    expect(
      loadGithubAppConfig({ ...FULL_ENV, GITHUB_API_URL: 'http://x.test////' })
        ?.apiUrl,
    ).toBe('http://x.test');
    expect(
      loadGithubAppConfig({ ...FULL_ENV, GITHUB_API_URL: 'http://x.test' })
        ?.apiUrl,
    ).toBe('http://x.test');
  });

  it('私钥的真实换行原样保留', () => {
    const withRealNewlines = 'line1\nline2\nline3';
    const config = loadGithubAppConfig({
      ...FULL_ENV,
      GITHUB_APP_PRIVATE_KEY: withRealNewlines,
    });
    expect(config?.privateKey).toBe(withRealNewlines);
  });

  it('私钥里字面量 `\\n` 转成真实换行', () => {
    const escaped = 'line1\\nline2\\nline3';
    const config = loadGithubAppConfig({
      ...FULL_ENV,
      GITHUB_APP_PRIVATE_KEY: escaped,
    });
    expect(config?.privateKey).toBe('line1\nline2\nline3');
  });
});

// ---------------------------------------------------------------------------
// splitFullName —— 边界
// ---------------------------------------------------------------------------

describe('splitFullName', () => {
  it('拆开 owner/repo 并拼出 clone 地址', () => {
    expect(splitFullName('acme/demo')).toEqual({
      owner: 'acme',
      repo: 'demo',
      cloneUrl: 'https://github.com/acme/demo.git',
    });
  });

  it('没有斜杠、或斜杠在开头/结尾 → 抛错', () => {
    expect(() => splitFullName('nogithubslash')).toThrow();
    expect(() => splitFullName('/demo')).toThrow();
    expect(() => splitFullName('acme/')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// mintAppJwt —— 形状、时间窗、签名可验
// ---------------------------------------------------------------------------

describe('mintAppJwt', () => {
  it('产出的 JWT 可用配套公钥验签，iss/iat/exp 都对', () => {
    const { publicKey, privateKey } = generateRsaKeyPair();
    const fixedNowMs = 1_700_000_000_000;
    const config = {
      appId: APP_ID,
      appSlug: 'slug',
      privateKey,
      clientId: 'c',
      clientSecret: 's',
      apiUrl: 'https://api.github.com',
    };

    const token = mintAppJwt(config, () => fixedNowMs);
    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    const [headerPart, payloadPart, signaturePart] = parts;
    expect(headerPart).toBeDefined();
    expect(payloadPart).toBeDefined();
    expect(signaturePart).toBeDefined();
    if (
      headerPart === undefined ||
      payloadPart === undefined ||
      signaturePart === undefined
    ) {
      return;
    }

    expect(decodeJwtPart(headerPart)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const payload = decodeJwtPart(payloadPart);
    const expectedNowSeconds = fixedNowMs / 1000;
    expect(payload).toEqual({
      iss: APP_ID,
      iat: expectedNowSeconds - 60,
      exp: expectedNowSeconds + 9 * 60,
    });

    const verified = createVerify('RSA-SHA256')
      .update(`${headerPart}.${payloadPart}`)
      .verify(publicKey, Buffer.from(signaturePart, 'base64url'));
    expect(verified).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 对真 HTTP 假 GitHub 的用例
// ---------------------------------------------------------------------------

describe('github-app · 对假 GitHub HTTP 服务', () => {
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
    server.failReposWith(undefined);
    server.setNextTokenTtlMs(60 * 60 * 1000);
  });

  function goodEnv(
    overrides: Partial<NodeJS.ProcessEnv> = {},
  ): NodeJS.ProcessEnv {
    return {
      GITHUB_APP_ID: APP_ID,
      GITHUB_APP_SLUG: 'test-app',
      GITHUB_APP_PRIVATE_KEY: keyPair.privateKey,
      GITHUB_CLIENT_ID: 'client-id',
      GITHUB_CLIENT_SECRET: 'client-secret',
      GITHUB_API_URL: server.url,
      ...overrides,
    };
  }

  const config = () => {
    const loaded = loadGithubAppConfig(goodEnv());
    if (loaded === undefined) {
      throw new Error('test setup: config should be defined');
    }
    return loaded;
  };

  it('listUserInstallations：读这个用户令牌名下的安装 id', async () => {
    server.setUserInstallations('user-token-a', [10, 20]);
    const ids = await listUserInstallations(config(), 'user-token-a', fetch);
    expect(ids).toEqual([10, 20]);
  });

  it('listInstallationRepos：翻页翻到底（total_count > per_page）', async () => {
    const repos = Array.from({ length: 130 }, (_, i) => ({
      id: i + 1,
      full_name: `acme/repo-${String(i + 1)}`,
      private: false,
      default_branch: 'main',
    }));
    server.setInstallationRepos(99, repos);

    const result = await listInstallationRepos(config(), 'tok', 99, fetch);

    expect(result).toHaveLength(130);
    expect(result[0]?.fullName).toBe('acme/repo-1');
    expect(result[129]?.fullName).toBe('acme/repo-130');
    const pages = server.requests
      .filter((r) => r.path.startsWith('/user/installations/99/repositories'))
      .map((r) => r.path);
    expect(pages).toEqual([
      '/user/installations/99/repositories?per_page=100&page=1',
      '/user/installations/99/repositories?per_page=100&page=2',
    ]);
  });

  it('listAccessibleRepos：跨全部安装汇总', async () => {
    server.setUserInstallations('tok-multi', [1, 2]);
    server.setInstallationRepos(1, [
      { id: 1, full_name: 'acme/one', private: false, default_branch: 'main' },
      { id: 2, full_name: 'acme/two', private: true, default_branch: 'main' },
    ]);
    server.setInstallationRepos(2, [
      { id: 3, full_name: 'acme/three', private: false, default_branch: 'dev' },
    ]);

    const repos = await listAccessibleRepos(config(), 'tok-multi', fetch);

    expect(repos.map((r) => r.fullName).sort()).toEqual([
      'acme/one',
      'acme/three',
      'acme/two',
    ]);
    expect(repos.find((r) => r.fullName === 'acme/three')?.installationId).toBe(
      2,
    );
  });

  it('userCanAccessRepo：命中返回摘要，没有就 undefined', async () => {
    server.setInstallationRepos(5, [
      {
        id: 42,
        full_name: 'acme/target',
        private: false,
        default_branch: 'main',
      },
    ]);

    expect(
      (await userCanAccessRepo(config(), 'tok', 5, 42, fetch))?.fullName,
    ).toBe('acme/target');
    expect(
      await userCanAccessRepo(config(), 'tok', 5, 999, fetch),
    ).toBeUndefined();
  });

  it('mintInstallationToken：请求体精确是 repository_ids=[repoId] + contents:write/metadata:read', async () => {
    const before = server.requests.length;
    const minted = await mintInstallationToken(config(), 7, 42, fetch);

    expect(minted.token).toMatch(/^fake-installation-token-/);
    expect(minted.expiresAt).toBeGreaterThan(Date.now());

    const mintRequest = server.requests
      .slice(before)
      .find((r) => r.path === '/app/installations/7/access_tokens');
    expect(mintRequest?.body).toEqual({
      repository_ids: [42],
      permissions: { contents: 'write', metadata: 'read' },
    });
  });

  it('App JWT 用错误的私钥签 → 假服务器拒（验签失败），错误原样透出、不是我们自己分类的错误', async () => {
    const otherKeyPair = generateRsaKeyPair();
    const badConfig = loadGithubAppConfig(
      goodEnv({ GITHUB_APP_PRIVATE_KEY: otherKeyPair.privateKey }),
    );
    if (badConfig === undefined) {
      throw new Error('test setup: config should be defined');
    }

    await expect(mintInstallationToken(badConfig, 1, 1, fetch)).rejects.toThrow(
      /HTTP 401/,
    );
  });

  it('App JWT 过期（exp 已经过去）→ 假服务器拒', async () => {
    const backdatedNow = () => Date.now() - 20 * 60 * 1000; // exp = 那时 + 9min，早于现在
    await expect(
      mintInstallationToken(config(), 1, 1, fetch, backdatedNow),
    ).rejects.toThrow(/HTTP 401/);
  });

  it('App JWT 的 iss 对不上这个 App → 假服务器拒', async () => {
    const wrongIssConfig = { ...config(), appId: 'someone-elses-app-id' };
    await expect(
      mintInstallationToken(wrongIssConfig, 1, 1, fetch),
    ).rejects.toThrow(/HTTP 401/);
  });

  it('GitHub 返回 5xx → 错误原样往外抛，不会被吞成 forbidden', async () => {
    server.setUserInstallations('tok', [1]);
    server.failReposWith(500);

    const app = createGithubApp({
      env: goodEnv(),
      fetch,
      getUserToken: async () => 'tok',
    });

    let caught: unknown;
    try {
      await app.listAccessibleRepos('user-1');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(classifyGithubError(caught)).toBe('unknown');
  });

  describe('createGithubApp：安装令牌缓存（docs/ingress/tech/github-repo-access.md §2/§3.3）', () => {
    // 注意：不靠快进时钟模拟「快过期」——`now()` 同时驱动缓存的剩余时间计算**和**
    // App JWT 的 iat/exp（`getRepoToken` 把同一个 `now` 转手交给 `mintInstallationToken`），
    // 而假服务器验签时用的是真实墙钟：把 `now()` 拨到几十分钟之后会让 JWT 的时间窗
    // 相对真实时间不合法，白白撞上验签失败。改用**控制服务端签发的令牌本身的存活时长**
    // （`setNextTokenTtlMs`）来制造「剩余不到 50 分钟」，`now()` 全程留在默认（真实时钟）。
    function setupApp() {
      server.setUserInstallations('user-tok', [1]);
      server.setInstallationRepos(1, [
        {
          id: 100,
          full_name: 'acme/demo',
          private: false,
          default_branch: 'main',
        },
      ]);
      return createGithubApp({
        env: goodEnv(),
        fetch,
        getUserToken: async () => 'user-tok',
      });
    }

    const selector = { userId: 'u1', installationId: 1, repoId: 100 };

    it('缓存命中（剩余 > 50 分钟）：不再核对、不再重签', async () => {
      const app = setupApp();
      server.setNextTokenTtlMs(60 * 60 * 1000); // 1 小时，大于 50 分钟阈值

      const first = await app.getRepoToken(selector);
      const mintedAfterFirst = server.mintedTokenCount();
      const requestsAfterFirst = server.requests.length;

      const second = await app.getRepoToken(selector);

      expect(second.token).toBe(first.token);
      expect(server.mintedTokenCount()).toBe(mintedAfterFirst); // 没有再签
      expect(server.requests.length).toBe(requestsAfterFirst); // 一次网络请求都没有
    });

    it('快过期（剩余 < 50 分钟）：先用用户令牌核对一次权限，再重签新令牌', async () => {
      const app = setupApp();
      server.setNextTokenTtlMs(5 * 60 * 1000); // 签出来的令牌只活 5 分钟——从一开始就「快过期」

      const first = await app.getRepoToken(selector);
      const mintedAfterFirst = server.mintedTokenCount();

      const second = await app.getRepoToken(selector);

      expect(server.mintedTokenCount()).toBe(mintedAfterFirst + 1); // 重签了一次
      expect(second.token).not.toBe(first.token); // 拿到的是新令牌
      const reposCalls = server.requests.filter((r) =>
        r.path.startsWith('/user/installations/1/repositories'),
      );
      expect(reposCalls.length).toBeGreaterThanOrEqual(2); // 首签 + 重签各核对一次
    });

    it('权限被收回：重签前的核对发现仓库不在了 → GithubRepoForbiddenError', async () => {
      const app = setupApp();
      server.setNextTokenTtlMs(5 * 60 * 1000); // 同上，逼近下一次调用就重签

      await app.getRepoToken(selector);
      server.setInstallationRepos(1, []); // 用户在 GitHub 上把仓库从安装里移除了

      await expect(app.getRepoToken(selector)).rejects.toBeInstanceOf(
        GithubRepoForbiddenError,
      );
    });

    it('缓存按用户区分：另一个用户没权限时，拿不到别人缓存下来的令牌', async () => {
      server.setUserInstallations('tok-a', [1]);
      server.setUserInstallations('tok-b', []); // B 已经被移出了这个组织
      server.setInstallationRepos(1, [
        {
          id: 100,
          full_name: 'acme/demo',
          private: false,
          default_branch: 'main',
        },
      ]);
      server.setNextTokenTtlMs(60 * 60 * 1000);
      const tokens = new Map([
        ['user-a', 'tok-a'],
        ['user-b', 'tok-b'],
      ]);
      const app = createGithubApp({
        env: goodEnv(),
        fetch,
        getUserToken: async (userId) => tokens.get(userId),
      });

      await app.getRepoToken({
        userId: 'user-a',
        installationId: 1,
        repoId: 100,
      });
      await expect(
        app.getRepoToken({ userId: 'user-b', installationId: 1, repoId: 100 }),
      ).rejects.toBeInstanceOf(GithubRepoForbiddenError);
    });

    it('用户已经不在这个安装里（GitHub 对安装回 404）→ GithubRepoForbiddenError，不当成真故障', async () => {
      server.setUserInstallations('user-tok', [2]);
      server.setInstallationRepos(1, [
        {
          id: 100,
          full_name: 'acme/demo',
          private: false,
          default_branch: 'main',
        },
      ]);
      const app = createGithubApp({
        env: goodEnv(),
        fetch,
        getUserToken: async () => 'user-tok',
      });
      await expect(app.getRepoToken(selector)).rejects.toBeInstanceOf(
        GithubRepoForbiddenError,
      );
    });

    it('用户在 GitHub 上撤销了授权（用户令牌回 401）→ GithubNotLinkedError，界面据此引导重新连接', async () => {
      // 单独一把令牌：假服务器在整个文件里共用，撤销状态不能漏到别的用例。
      server.setUserInstallations('revoked-tok', [1]);
      server.setInstallationRepos(1, [
        {
          id: 100,
          full_name: 'acme/demo',
          private: false,
          default_branch: 'main',
        },
      ]);
      server.revokeUserToken('revoked-tok');
      const app = createGithubApp({
        env: goodEnv(),
        fetch,
        getUserToken: async () => 'revoked-tok',
      });
      await expect(app.listAccessibleRepos('u1')).rejects.toBeInstanceOf(
        GithubNotLinkedError,
      );
      await expect(app.getRepoToken(selector)).rejects.toBeInstanceOf(
        GithubNotLinkedError,
      );
    });

    it('verifyRepoAccess：安装里没有这个仓库 → GithubRepoForbiddenError', async () => {
      const app = setupApp();
      await expect(
        app.verifyRepoAccess({ userId: 'u1', installationId: 1, repoId: 999 }),
      ).rejects.toBeInstanceOf(GithubRepoForbiddenError);
    });
  });

  it('getUserToken 抛错 = 基础设施故障，原样透出；只有返回 undefined 才算没连接', async () => {
    const app = createGithubApp({
      env: goodEnv(),
      fetch,
      getUserToken: async () => {
        throw new Error('token store unavailable');
      },
    });

    await expect(app.listAccessibleRepos('user-x')).rejects.toThrow(
      'token store unavailable',
    );
  });

  it('createGithubApp.listAccessibleRepos：没连接 GitHub（getUserToken 返回 undefined）→ GithubNotLinkedError', async () => {
    const app = createGithubApp({
      env: goodEnv(),
      fetch,
      getUserToken: async () => undefined,
    });
    await expect(app.listAccessibleRepos('user-x')).rejects.toThrow(/尚未连接/);
  });

  it('未配置 GitHub App → GithubNotConfiguredError（installUrl 为 undefined）', async () => {
    const app = createGithubApp({ env: {}, fetch });
    expect(app.configured).toBe(false);
    expect(app.installUrl).toBeUndefined();
    await expect(app.listAccessibleRepos('user-x')).rejects.toThrow(/未配置/);
  });
});
