/**
 * 一个**真的** `node:http` 服务器，扮演 GitHub API——`test/agent/github-app.test.ts`、
 * `test/e2e/github-repo-access.integration.test.ts` 共用（docs/ingress/tech/github-repo-access.md §9：
 * 「它还会验 App JWT 的签名……签错了就拒」）。
 *
 * 实现了本方案用到的三个接口：
 * - `GET /user/installations`
 * - `GET /user/installations/:id/repositories`（支持分页）
 * - `POST /app/installations/:id/access_tokens`（**真验签**：用调用方传入的公钥核对
 *   RS256 签名、`iss` 是不是这个 App、`iat`/`exp` 时间窗）
 *
 * 数据都是可变的（`setUserInstallations`/`setInstallationRepos`），测试可以随时改写，
 * 模拟「用户在 GitHub 上收回了某个仓库」这类场景。
 */
import { createVerify } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { z } from 'zod';

export interface FakeGithubRepoRecord {
  id: number;
  full_name: string;
  private: boolean;
  default_branch: string;
}

export interface LoggedGithubRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  body: unknown;
}

const mintTokenBodySchema = z.object({
  repository_ids: z.array(z.number().int()),
  permissions: z.object({ contents: z.string(), metadata: z.string() }),
});

const jwtPayloadSchema = z.object({
  iat: z.number(),
  exp: z.number(),
  iss: z.string(),
});

/** RS256 验签 + `iss`/时间窗核对——手写而不是引入 `jsonwebtoken`，测试只需要验证「我们自己签的」这一种形状。 */
function verifyAppJwt(
  token: string,
  publicKey: string,
  expectedAppId: string,
  nowMs: number,
): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return false;
  }
  const [headerPart, payloadPart, signaturePart] = parts;
  if (
    headerPart === undefined ||
    payloadPart === undefined ||
    signaturePart === undefined
  ) {
    return false;
  }
  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'));
    payload = JSON.parse(
      Buffer.from(payloadPart, 'base64url').toString('utf8'),
    );
  } catch {
    return false;
  }
  const headerResult = z
    .object({ alg: z.literal('RS256'), typ: z.literal('JWT') })
    .safeParse(header);
  const payloadResult = jwtPayloadSchema.safeParse(payload);
  if (!headerResult.success || !payloadResult.success) {
    return false;
  }
  if (payloadResult.data.iss !== expectedAppId) {
    return false;
  }
  const nowSeconds = nowMs / 1000;
  if (
    payloadResult.data.exp <= nowSeconds ||
    payloadResult.data.iat > nowSeconds
  ) {
    return false;
  }
  const signingInput = `${headerPart}.${payloadPart}`;
  try {
    return createVerify('RSA-SHA256')
      .update(signingInput)
      .verify(publicKey, Buffer.from(signaturePart, 'base64url'));
  } catch {
    return false;
  }
}

export interface FakeGithubHttpServer {
  readonly url: string;
  readonly requests: LoggedGithubRequest[];
  /** 这个用户令牌名下挂着哪些安装（`GET /user/installations` 的数据源）。 */
  /** 让这个用户令牌从此回 401——模拟用户在 GitHub 上撤销了授权。 */
  revokeUserToken(userToken: string): void;
  setUserInstallations(userToken: string, installationIds: number[]): void;
  /** 这次安装此刻能看到的仓库，覆盖式设置——用来模拟建会话之后用户又收回了权限。 */
  setInstallationRepos(
    installationId: number,
    repos: FakeGithubRepoRecord[],
  ): void;
  /** 下一次（及之后）签发的安装令牌的存活时长，缺省 1 小时。 */
  setNextTokenTtlMs(ms: number): void;
  /** 设了就让 `.../repositories` 恒返回这个状态码（模拟 GitHub 故障）；`undefined` 取消。 */
  failReposWith(status: number | undefined): void;
  /** 已经签发过的安装令牌个数——断言「重签了几次」用，比翻 `requests` 数组直接。 */
  mintedTokenCount(): number;
  close(): Promise<void>;
}

export interface StartFakeGithubHttpOptions {
  appId: string;
  publicKey: string;
}

function isAddressInfo(
  value: string | AddressInfo | null,
): value is AddressInfo {
  return value !== null && typeof value === 'object';
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function startFakeGithubHttp(
  opts: StartFakeGithubHttpOptions,
): Promise<FakeGithubHttpServer> {
  const userInstallations = new Map<string, number[]>();
  const revokedUserTokens = new Set<string>();
  const installationRepos = new Map<number, FakeGithubRepoRecord[]>();
  const requests: LoggedGithubRequest[] = [];
  let nextTokenTtlMs = 60 * 60 * 1000;
  let reposFailStatus: number | undefined;
  let mintCount = 0;

  const server = createServer((req, res) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const url = new URL(req.url ?? '/', 'http://fake-github.invalid');
      const authorization = req.headers.authorization;

      const installationsMatch = /^\/user\/installations$/.exec(url.pathname);
      if (installationsMatch && method === 'GET') {
        const token =
          authorization?.startsWith('Bearer ') ?
            authorization.slice('Bearer '.length)
          : undefined;
        if (token !== undefined && revokedUserTokens.has(token)) {
          requests.push({
            method,
            path: url.pathname,
            authorization,
            body: undefined,
          });
          sendJson(res, 401, { message: 'Bad credentials' });
          return;
        }
        const ids =
          token === undefined ? [] : (userInstallations.get(token) ?? []);
        requests.push({
          method,
          path: url.pathname,
          authorization,
          body: undefined,
        });
        sendJson(res, 200, {
          installations: ids.map((id) => ({ id })),
        });
        return;
      }

      const reposMatch = /^\/user\/installations\/(\d+)\/repositories$/.exec(
        url.pathname,
      );
      if (reposMatch && method === 'GET') {
        requests.push({
          method,
          path: `${url.pathname}${url.search}`,
          authorization,
          body: undefined,
        });
        if (reposFailStatus !== undefined) {
          sendJson(res, reposFailStatus, { message: 'internal error' });
          return;
        }
        const idPart = reposMatch[1];
        const installationId = idPart === undefined ? NaN : Number(idPart);
        const bearer =
          authorization?.startsWith('Bearer ') ?
            authorization.slice('Bearer '.length)
          : undefined;
        // 像真 GitHub：令牌被撤销回 401；登记过的用户令牌访问不属于它的安装回 404。
        if (bearer !== undefined && revokedUserTokens.has(bearer)) {
          sendJson(res, 401, { message: 'Bad credentials' });
          return;
        }
        const ownInstallations =
          bearer === undefined ? undefined : userInstallations.get(bearer);
        if (
          ownInstallations !== undefined &&
          !ownInstallations.includes(installationId)
        ) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        const all = installationRepos.get(installationId) ?? [];
        const perPage = Number(url.searchParams.get('per_page') ?? '30');
        const page = Number(url.searchParams.get('page') ?? '1');
        const start = (page - 1) * perPage;
        const slice = all.slice(start, start + perPage);
        sendJson(res, 200, {
          total_count: all.length,
          repositories: slice,
        });
        return;
      }

      const mintMatch = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(
        url.pathname,
      );
      if (mintMatch && method === 'POST') {
        const token =
          authorization?.startsWith('Bearer ') ?
            authorization.slice('Bearer '.length)
          : undefined;
        if (
          token === undefined ||
          !verifyAppJwt(token, opts.publicKey, opts.appId, Date.now())
        ) {
          requests.push({
            method,
            path: url.pathname,
            authorization,
            body: undefined,
          });
          sendJson(res, 401, { message: 'Bad credentials' });
          return;
        }
        const raw = await readBody(req);
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(raw);
        } catch {
          sendJson(res, 422, { message: 'invalid JSON body' });
          return;
        }
        const bodyResult = mintTokenBodySchema.safeParse(parsedJson);
        if (!bodyResult.success) {
          sendJson(res, 422, { message: 'unexpected body shape' });
          return;
        }
        requests.push({
          method,
          path: url.pathname,
          authorization,
          body: bodyResult.data,
        });
        mintCount += 1;
        const expiresAt = new Date(Date.now() + nextTokenTtlMs).toISOString();
        sendJson(res, 201, {
          token: `fake-installation-token-${String(mintCount)}`,
          expires_at: expiresAt,
        });
        return;
      }

      sendJson(res, 404, { message: 'not found in fake GitHub' });
    })().catch((error: unknown) => {
      sendJson(res, 500, {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = isAddressInfo(address) ? address.port : 0;

  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    revokeUserToken(userToken) {
      revokedUserTokens.add(userToken);
    },
    setUserInstallations(userToken, installationIds) {
      userInstallations.set(userToken, installationIds);
    },
    setInstallationRepos(installationId, repos) {
      installationRepos.set(installationId, repos);
    },
    setNextTokenTtlMs(ms) {
      nextTokenTtlMs = ms;
    },
    failReposWith(status) {
      reposFailStatus = status;
    },
    mintedTokenCount() {
      return mintCount;
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  };
}
