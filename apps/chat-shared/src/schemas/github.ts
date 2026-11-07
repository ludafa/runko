/**
 * `/api/github/*` 的 wire 契约（docs/ingress/tech/github-repo-access.md §5）。
 */
import { z } from '@hono/zod-openapi';

export const GithubStatusSchema = z
  .object({
    configured: z.boolean().meta({
      description:
        '服务端是否配了 GitHub App。false 时新建会话弹窗里没有云沙盒可选',
    }),
    linked: z.boolean().meta({
      description:
        '这个用户是否连接过 GitHub（better-auth 的 account 表里有一条 github）',
    }),
    installUrl: z.string().nullable().meta({
      description:
        '安装页地址（`https://github.com/apps/<slug>/installations/new`）；未配置时为 null',
    }),
  })
  .openapi('GithubStatus');

export type GithubStatusDto = z.infer<typeof GithubStatusSchema>;

export const GithubRepoSummarySchema = z
  .object({
    installationId: z.number().int(),
    repoId: z.number().int(),
    fullName: z.string().meta({ examples: ['acme/demo'] }),
    private: z.boolean(),
    defaultBranch: z.string().meta({ examples: ['main'] }),
  })
  .openapi('GithubRepoSummary');

export type GithubRepoSummaryDto = z.infer<typeof GithubRepoSummarySchema>;

export const GithubReposResponseSchema = z
  .object({ repos: z.array(GithubRepoSummarySchema) })
  .openapi('GithubReposResponse');

export type GithubReposResponseDto = z.infer<typeof GithubReposResponseSchema>;
