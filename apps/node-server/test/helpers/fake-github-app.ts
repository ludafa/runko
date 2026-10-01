/**
 * 假的 `GithubApp`——集成测试用它跑云沙盒那条路：不连真 GitHub、零网络零凭证，
 * 固定认一份仓库清单（缺省一条 `acme/demo`，`installationId`/`repoId` 都是 1）。
 *
 * `verifyRepoAccessCalls`/`getRepoTokenCalls` 记下每次调用的入参，供需要断言
 * 「核对过谁」「签过谁的令牌」的用例使用。
 */
import type {
  GithubApp,
  GithubRepoAccess,
  GithubRepoSelector,
  GithubRepoSummary,
} from '../../src/agent/github-app.js';
import {
  GithubNotConfiguredError,
  GithubNotLinkedError,
  GithubRepoForbiddenError,
} from '../../src/agent/github-app.js';

export const FAKE_GITHUB_REPO: GithubRepoSummary = {
  installationId: 1,
  repoId: 1,
  fullName: 'acme/demo',
  private: false,
  defaultBranch: 'main',
};

export interface FakeGithubAppOptions {
  /** 这个假 App「认得」的仓库清单。缺省只有 `FAKE_GITHUB_REPO` 一条。 */
  repos?: GithubRepoSummary[];
  installUrl?: string;
  /** `getRepoToken` 签出来的令牌字面量。 */
  token?: string;
  /** `false` 模拟「服务端没配 GitHub App」——所有方法抛 `GithubNotConfiguredError`。缺省 `true`。 */
  configured?: boolean;
  /** `false` 模拟「这个用户还没连接 GitHub」——所有方法抛 `GithubNotLinkedError`。缺省 `true`（仅在 `configured` 为 `true` 时才有意义）。 */
  linked?: boolean;
}

export interface FakeGithubApp extends GithubApp {
  readonly verifyRepoAccessCalls: GithubRepoSelector[];
  readonly getRepoTokenCalls: GithubRepoSelector[];
}

function sameRepo(
  selector: GithubRepoSelector,
  repo: GithubRepoSummary,
): boolean {
  return (
    repo.installationId === selector.installationId &&
    repo.repoId === selector.repoId
  );
}

export function createFakeGithubApp(
  opts: FakeGithubAppOptions = {},
): FakeGithubApp {
  const repos = opts.repos ?? [FAKE_GITHUB_REPO];
  const configured = opts.configured ?? true;
  const linked = opts.linked ?? true;
  const verifyRepoAccessCalls: GithubRepoSelector[] = [];
  const getRepoTokenCalls: GithubRepoSelector[] = [];

  function find(selector: GithubRepoSelector): GithubRepoSummary | undefined {
    return repos.find((repo) => sameRepo(selector, repo));
  }

  /** 与生产的 `requireConfig`/`requireUserToken` 同一顺序：先查配置，再查连接。 */
  function requireReady(): void {
    if (!configured) {
      throw new GithubNotConfiguredError();
    }
    if (!linked) {
      throw new GithubNotLinkedError();
    }
  }

  return {
    configured,
    installUrl:
      configured ?
        (opts.installUrl ??
        'https://github.com/apps/test-app/installations/new')
      : undefined,
    verifyRepoAccessCalls,
    getRepoTokenCalls,
    async listAccessibleRepos() {
      requireReady();
      return repos;
    },
    async verifyRepoAccess(selector) {
      requireReady();
      verifyRepoAccessCalls.push(selector);
      const repo = find(selector);
      if (repo === undefined) {
        throw new GithubRepoForbiddenError();
      }
      return repo;
    },
    async getRepoToken(selector) {
      requireReady();
      getRepoTokenCalls.push(selector);
      const repo = find(selector);
      if (repo === undefined) {
        throw new GithubRepoForbiddenError();
      }
      const access: GithubRepoAccess = {
        token: opts.token ?? 'fake-installation-token',
        expiresAt: Date.now() + 60 * 60 * 1000,
        repo,
      };
      return access;
    },
  };
}
