/**
 * `/api/github/status`、`/api/github/repos`（docs/ingress/tech/github-repo-access.md §5）。
 *
 * `githubApp` 全部注入假实现——零网络零凭证；`linked` 直接查 `account` 表
 * （`test/helpers/test-db.ts` 的 `linkGithubAccount`），不经 better-auth 真流程。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type {
  GithubApp,
  GithubRepoSummary,
} from '../../src/agent/github-app.js';
import {
  GithubNotConfiguredError,
  GithubNotLinkedError,
} from '../../src/agent/github-app.js';
import type { Db } from '../../src/agent/store.js';
import { createGithubRoutes } from '../../src/routes/github.js';
import type {
  GithubReposResponseDto,
  GithubStatusDto,
} from '../../src/schemas/github.js';
import {
  fakeAuthMiddleware,
  unauthorizedMiddleware,
} from '../helpers/chat-app.js';
import {
  createTestDb,
  linkGithubAccount,
  seedUser,
} from '../helpers/test-db.js';

const USER_ID = 'user-1';

const DEMO_REPO: GithubRepoSummary = {
  installationId: 1,
  repoId: 1,
  fullName: 'acme/demo',
  private: false,
  defaultBranch: 'main',
};

function fakeGithubApp(overrides: Partial<GithubApp> = {}): GithubApp {
  return {
    configured: true,
    installUrl: 'https://github.com/apps/test-app/installations/new',
    async listAccessibleRepos() {
      return [DEMO_REPO];
    },
    async verifyRepoAccess(selector) {
      if (selector.repoId !== DEMO_REPO.repoId) {
        throw new Error('not the demo repo');
      }
      return DEMO_REPO;
    },
    async getRepoToken() {
      return {
        token: 'fake-token',
        expiresAt: Date.now() + 3600_000,
        repo: DEMO_REPO,
      };
    },
    ...overrides,
  };
}

describe('routes/github', () => {
  let db: Db;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUser(db, USER_ID);
  });

  function app(githubApp: GithubApp, userId: string = USER_ID) {
    return createGithubRoutes({
      db,
      githubApp,
      authMiddleware: fakeAuthMiddleware(userId),
    });
  }

  describe('GET /api/github/status', () => {
    it('配置了 + 已连接 GitHub → { configured: true, linked: true, installUrl }', async () => {
      await linkGithubAccount(db, USER_ID);
      const response = await app(fakeGithubApp()).request('/api/github/status');
      expect(response.status).toBe(200);
      const body = (await response.json()) as GithubStatusDto;
      expect(body).toEqual({
        configured: true,
        linked: true,
        installUrl: 'https://github.com/apps/test-app/installations/new',
      });
    });

    it('配置了但还没连接 GitHub → linked: false', async () => {
      const response = await app(fakeGithubApp()).request('/api/github/status');
      const body = (await response.json()) as GithubStatusDto;
      expect(body.linked).toBe(false);
      expect(body.configured).toBe(true);
    });

    it('没配置 GitHub App → configured: false，installUrl 为 null（哪怕这个用户连过 GitHub）', async () => {
      await linkGithubAccount(db, USER_ID);
      const response = await app(
        fakeGithubApp({ configured: false, installUrl: undefined }),
      ).request('/api/github/status');
      const body = (await response.json()) as GithubStatusDto;
      expect(body).toEqual({
        configured: false,
        linked: true,
        installUrl: null,
      });
    });

    it('linked 只看这个用户自己的 account 行，不看别人的', async () => {
      await seedUser(db, 'user-2');
      await linkGithubAccount(db, 'user-2');
      const response = await app(fakeGithubApp()).request('/api/github/status');
      const body = (await response.json()) as GithubStatusDto;
      expect(body.linked).toBe(false);
    });

    it('未登录 → 401', async () => {
      const response = await createGithubRoutes({
        db,
        githubApp: fakeGithubApp(),
        authMiddleware: unauthorizedMiddleware,
      }).request('/api/github/status');
      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/github/repos', () => {
    it('200：返回这个用户能看到的仓库清单', async () => {
      const response = await app(fakeGithubApp()).request('/api/github/repos');
      expect(response.status).toBe(200);
      const body = (await response.json()) as GithubReposResponseDto;
      expect(body).toEqual({
        repos: [
          {
            installationId: 1,
            repoId: 1,
            fullName: 'acme/demo',
            private: false,
            defaultBranch: 'main',
          },
        ],
      });
    });

    it('404 github_not_configured：服务端没配 GitHub App', async () => {
      const response = await app(
        fakeGithubApp({
          async listAccessibleRepos() {
            throw new GithubNotConfiguredError();
          },
        }),
      ).request('/api/github/repos');
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'github_not_configured' });
    });

    it('409 github_not_linked：这个用户还没连接 GitHub', async () => {
      const response = await app(
        fakeGithubApp({
          async listAccessibleRepos() {
            throw new GithubNotLinkedError();
          },
        }),
      ).request('/api/github/repos');
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'github_not_linked' });
    });

    it('未分类的错误原样往外抛（不是这三种拒绝之一时不该被吞成 4xx）', async () => {
      const response = await app(
        fakeGithubApp({
          async listAccessibleRepos() {
            throw new Error('unexpected GitHub failure');
          },
        }),
      ).request('/api/github/repos');
      // Hono 未捕获的抛出在默认错误处理下回 500，不是本方案定义的三种拒绝之一。
      expect(response.status).toBe(500);
    });

    it('未登录 → 401', async () => {
      const response = await createGithubRoutes({
        db,
        githubApp: fakeGithubApp(),
        authMiddleware: unauthorizedMiddleware,
      }).request('/api/github/repos');
      expect(response.status).toBe(401);
    });
  });
});
