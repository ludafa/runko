/**
 * Node 版的 GitHub App 单例：用户令牌由 better-auth 代管（`account` 表与刷新逻辑），
 * 其余（签安装令牌、核对仓库）全在共用层的 `createGithubApp` 里。
 */
import type { GithubApp } from '@runko-chat/shared/agent/github-app';
import { createGithubApp } from '@runko-chat/shared/agent/github-app';
import { isAPIError } from 'better-auth/api';

import { auth } from '../auth.js';

/**
 * 生产默认的用户令牌来源：`auth.api.getAccessToken` 直接服务端调用，不带 headers 时按传入的
 * `userId` 解析（见 better-auth `resolveUserId`）。
 *
 * better-auth 以 `APIError` 报的（账号没连过 GitHub、刷新令牌失效）= 没连接，返回 `undefined`；
 * 别的错误（库连不上之类）原样抛——见共用层 `requireUserToken` 的契约。
 */
export async function getGithubUserToken(
  userId: string,
): Promise<string | undefined> {
  try {
    const result = await auth.api.getAccessToken({
      body: { providerId: 'github', userId },
    });
    return result.accessToken;
  } catch (error) {
    if (isAPIError(error)) {
      return undefined;
    }
    throw error;
  }
}

/** 生产单例：env 懒读、构造本身零 I/O，`routes/chat.ts`/`routes/github.ts` 共用（令牌缓存也共享）。 */
export const defaultGithubApp: GithubApp = createGithubApp({
  getUserToken: getGithubUserToken,
});
