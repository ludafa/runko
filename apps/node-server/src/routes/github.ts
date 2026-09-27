/**
 * `/api/github/status`、`/api/github/repos`（docs/ingress/tech/github-repo-access.md §5）：
 * 前端靠它们决定新建会话弹窗里显示哪一步（连接 GitHub / 去装 App / 选仓库）。
 *
 * 两个接口都只读、都要登录（与 `routes/chat.ts` 同一套 `requireAuth`）。核对用户是否
 * 真能看到某个仓库、签安装令牌，全在 `agent/github-app.ts` 里——本文件只做 HTTP。
 */
import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';

import type { GithubApp, GithubRepoSummary } from '../agent/github-app.js';
import { classifyGithubError, defaultGithubApp } from '../agent/github-app.js';
import type { Db } from '../agent/store.js';
import { db as defaultDb } from '../db/instance.js';
import { requireAuth } from '../middleware/auth.js';
import { ErrorSchema } from '../schemas/api.js';
import type { GithubRepoSummaryDto } from '../schemas/github.js';
import {
  GithubReposResponseSchema,
  GithubStatusSchema,
} from '../schemas/github.js';

type GithubEnv = { Variables: { userId: string } };

export interface GithubRouteDeps {
  db: Db;
  githubApp: GithubApp;
  /** 与 `ChatRouteDeps.authMiddleware` 同样的理由：集成测试塞一个固定 userId 的桩。 */
  authMiddleware: MiddlewareHandler<GithubEnv>;
}

/** 这个用户是否连过 GitHub——`account` 表里有没有一条 `provider_id = 'github'`。 */
async function hasLinkedGithubAccount(
  db: Db,
  userId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('account')
    .select('id')
    .where('userId', '=', userId)
    .where('providerId', '=', 'github')
    .executeTakeFirst();
  return row !== undefined;
}

function toRepoDto(repo: GithubRepoSummary): GithubRepoSummaryDto {
  return {
    installationId: repo.installationId,
    repoId: repo.repoId,
    fullName: repo.fullName,
    private: repo.private,
    defaultBranch: repo.defaultBranch,
  };
}

export function createGithubRoutes(
  deps: GithubRouteDeps,
): OpenAPIHono<GithubEnv> {
  const app = new OpenAPIHono<GithubEnv>();

  app.use('/api/github/*', deps.authMiddleware);

  // ---- GET /api/github/status ----

  const statusRoute = createRoute({
    method: 'get',
    path: '/api/github/status',
    tags: ['GitHub'],
    summary:
      '前端据此决定新建会话弹窗里显示哪一步：连接 GitHub / 去装 App / 直接选仓库',
    responses: {
      200: {
        content: { 'application/json': { schema: GithubStatusSchema } },
        description: 'Status',
      },
      401: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'Unauthorized',
      },
    },
  });

  app.openapi(statusRoute, async (c) => {
    const userId = c.get('userId');
    const linked = await hasLinkedGithubAccount(deps.db, userId);
    return c.json(
      {
        configured: deps.githubApp.configured,
        linked,
        installUrl: deps.githubApp.installUrl ?? null,
      },
      200,
    );
  });

  // ---- GET /api/github/repos ----

  const reposRoute = createRoute({
    method: 'get',
    path: '/api/github/repos',
    tags: ['GitHub'],
    summary:
      '这个用户通过 GitHub App 授权过的全部仓库（跨全部安装）——新建会话的仓库下拉框',
    responses: {
      200: {
        content: { 'application/json': { schema: GithubReposResponseSchema } },
        description: 'Repos',
      },
      401: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'Unauthorized',
      },
      404: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'GitHub App 未配置',
      },
      409: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: '这个用户还没连接 GitHub',
      },
    },
  });

  app.openapi(reposRoute, async (c) => {
    const userId = c.get('userId');
    try {
      const repos = await deps.githubApp.listAccessibleRepos(userId);
      return c.json({ repos: repos.map(toRepoDto) }, 200);
    } catch (error) {
      const kind = classifyGithubError(error);
      if (kind === 'not-configured') {
        return c.json({ error: 'github_not_configured' }, 404);
      }
      if (kind === 'not-linked') {
        return c.json({ error: 'github_not_linked' }, 409);
      }
      throw error;
    }
  });

  return app;
}

export const githubRoutes = createGithubRoutes({
  db: defaultDb,
  githubApp: defaultGithubApp,
  authMiddleware: requireAuth,
});
