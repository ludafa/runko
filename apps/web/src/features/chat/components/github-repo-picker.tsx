/**
 * 新建会话弹窗里的「仓库」栏（docs/ingress/features/github-repo-access.md §2.1，
 * docs/ingress/tech/github-repo-access.md §5）——只在选中云沙盒 provider（`e2b`/
 * `vercel`）时才会被装配，组件自己不判断 provider。
 *
 * 状态机按 `GET /api/github/status` → `GET /api/github/repos` 这条链路走：没配
 * GitHub App → 没连 GitHub → 正在列仓库 → 仓库列表（可能是空的）。用一个判别联合
 * 表达，避免出现「configured 是 false 但 repos 已经有值」这类不该存在的组合。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { authClient } from '@/lib/auth-client';

import { fetchGithubRepos, fetchGithubStatus } from '../api';
import { ChatApiError } from '../api-error';
import type { GithubRepo, GithubRepoRef } from '../schema';

/** 拼一个仓库在下拉框里的稳定 key——`installationId`+`repoId` 才是服务端认的身份，`fullName` 只用来显示。 */
function repoKey(repo: GithubRepoRef): string {
  return `${String(repo.installationId)}:${String(repo.repoId)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type GithubDataState =
  | { phase: 'loading' }
  | { phase: 'status-error'; message: string }
  | { phase: 'not-configured' }
  | { phase: 'not-linked'; installUrl: string | null }
  | { phase: 'loading-repos'; installUrl: string | null }
  | { phase: 'repos-error'; installUrl: string | null; message: string }
  | { phase: 'ready'; installUrl: string | null; repos: GithubRepo[] };

/** 在新标签页打开安装页——装完/改完勾选之后用户自己点「刷新」，不是本组件负责监听。 */
function InstallLink({ installUrl }: { installUrl: string | null }) {
  if (installUrl === null) {
    return null;
  }
  return (
    <a
      href={installUrl}
      target="_blank"
      rel="noreferrer"
      className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
    >
      去 GitHub 选仓库
    </a>
  );
}

async function handleConnectGithub() {
  // 与登录页 `handleGitHub` 同一姿态：这个调用会把浏览器整页跳去 GitHub 授权页，
  // 不需要在这里处理返回值或异常。
  await authClient.linkSocial({
    provider: 'github',
    callbackURL: window.location.href,
  });
}

export interface GithubRepoPickerProps {
  value: GithubRepoRef | undefined;
  onChange: (repo: GithubRepoRef | undefined) => void;
}

export function GithubRepoPicker({ value, onChange }: GithubRepoPickerProps) {
  const [state, setState] = useState<GithubDataState>({ phase: 'loading' });
  const abortRef = useRef<AbortController | null>(null);

  // 只管发请求、按结果落 state——不在这里把阶段先拨回 `loading`，因为它既要给
  // 挂载时的 effect 用（初值已经是 `loading`，不用再设一遍），也要给 `refresh`
  // 用（`refresh` 自己在事件里同步拨一次，effect 里不能有这种同步 setState）。
  const runFetch = useCallback((controller: AbortController) => {
    fetchGithubStatus(controller.signal)
      .then((status) => {
        if (!status.configured) {
          setState({ phase: 'not-configured' });
          return undefined;
        }
        if (!status.linked) {
          setState({ phase: 'not-linked', installUrl: status.installUrl });
          return undefined;
        }
        setState({ phase: 'loading-repos', installUrl: status.installUrl });
        return fetchGithubRepos(controller.signal).then((repos) => {
          setState({ phase: 'ready', installUrl: status.installUrl, repos });
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        // 列仓库回 409：GitHub 那边的授权失效了（用户撤销、刷新令牌过期），状态接口只看得到
        // 「连过」，看不出令牌还能不能用——回到「连接 GitHub」这一步，让用户重新连。
        if (error instanceof ChatApiError && error.status === 409) {
          setState((prev) => ({
            phase: 'not-linked',
            installUrl: prev.phase === 'loading-repos' ? prev.installUrl : null,
          }));
          return;
        }
        // 用「刚设过的阶段是不是 loading-repos」区分这次失败发生在哪一步——两步共用
        // 同一条 `.catch`，不用再维护一个额外的「正在请求哪个接口」标记。
        setState((prev) =>
          prev.phase === 'loading-repos' ?
            {
              phase: 'repos-error',
              installUrl: prev.installUrl,
              message: errorMessage(error),
            }
          : { phase: 'status-error', message: errorMessage(error) },
        );
      });
  }, []);

  /** 「刷新」「重试」按钮用——这是个事件处理函数，同步拨回 `loading`没有问题。 */
  const refresh = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ phase: 'loading' });
    runFetch(controller);
  }, [runFetch]);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    runFetch(controller);
    return () => controller.abort();
  }, [runFetch]);

  // 列表到手时对一下手上的选择：还没选、或者选的那个已经不在列表里（用户在 GitHub 上把它去掉了
  // 再点了刷新）——换成第一个，列表空了就清掉。多数用户只装了少数几个仓库，默认第一个省一次点击；
  // 不想用这个默认值的话下拉框随时能改。
  useEffect(() => {
    if (state.phase !== 'ready') {
      return;
    }
    const stillThere =
      value !== undefined &&
      state.repos.some((repo) => repoKey(repo) === repoKey(value));
    if (stillThere) {
      return;
    }
    const first = state.repos[0];
    const next =
      first === undefined ? undefined : (
        { installationId: first.installationId, repoId: first.repoId }
      );
    if (next === undefined && value === undefined) {
      return;
    }
    onChange(next);
  }, [state, value, onChange]);

  switch (state.phase) {
    case 'loading':
      return (
        <p className="text-muted-foreground text-xs">
          正在检查 GitHub 连接状态…
        </p>
      );

    case 'status-error':
      return (
        <div className="flex flex-col gap-1.5">
          <p className="border-destructive/70 text-destructive border-l-2 py-0.5 pl-3 text-xs leading-relaxed">
            {state.message}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={refresh}
            className="self-start"
          >
            重试
          </Button>
        </div>
      );

    case 'not-configured':
      return (
        <p className="text-muted-foreground text-xs leading-relaxed">
          服务端还没配置 GitHub App，暂时不能加载仓库——选本地沙盒可以直接用。
        </p>
      );

    case 'not-linked':
      return (
        <div className="flex flex-col items-start gap-1.5">
          <p className="text-muted-foreground text-xs leading-relaxed">
            连接 GitHub 后才能从你自己的仓库里选一个。
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void handleConnectGithub();
            }}
          >
            连接 GitHub
          </Button>
        </div>
      );

    case 'loading-repos':
      return <p className="text-muted-foreground text-xs">正在加载仓库列表…</p>;

    case 'repos-error':
      return (
        <div className="flex flex-col items-start gap-1.5">
          <p className="border-destructive/70 text-destructive border-l-2 py-0.5 pl-3 text-xs leading-relaxed">
            {state.message}
          </p>
          <div className="flex items-center gap-3">
            <Button type="button" variant="outline" size="sm" onClick={refresh}>
              重试
            </Button>
            <InstallLink installUrl={state.installUrl} />
          </div>
        </div>
      );

    case 'ready': {
      if (state.repos.length === 0) {
        return (
          <div className="flex flex-col items-start gap-1.5">
            <p className="text-muted-foreground text-xs leading-relaxed">
              还没有勾选过任何仓库——去 GitHub 选好之后回来点刷新。
            </p>
            <div className="flex items-center gap-3">
              <InstallLink installUrl={state.installUrl} />
              <button
                type="button"
                onClick={refresh}
                className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
              >
                刷新
              </button>
            </div>
          </div>
        );
      }

      const selectedKey = value !== undefined ? repoKey(value) : undefined;
      return (
        <div className="flex flex-col items-start gap-1.5">
          <Select
            // 收起时触发器上显示什么靠这张表：不给的话 base-ui 直接显示原始值（`installationId:repoId`）。
            items={state.repos.map((repo) => ({
              value: repoKey(repo),
              label: repo.fullName,
            }))}
            value={selectedKey ?? null}
            onValueChange={(key) => {
              const repo = state.repos.find((r) => repoKey(r) === key);
              onChange(
                repo === undefined ? undefined : (
                  { installationId: repo.installationId, repoId: repo.repoId }
                ),
              );
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="选一个仓库" />
            </SelectTrigger>
            <SelectContent>
              {state.repos.map((repo) => (
                <SelectItem key={repoKey(repo)} value={repoKey(repo)}>
                  {repo.fullName}
                  {repo.private && (
                    <span className="text-muted-foreground text-[0.6875rem]">
                      私有
                    </span>
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-3">
            <InstallLink installUrl={state.installUrl} />
            <button
              type="button"
              onClick={refresh}
              className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
            >
              刷新
            </button>
          </div>
        </div>
      );
    }
  }
}
