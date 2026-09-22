/**
 * 用 better-auth 的邮箱注册接口换一个能带着走的 session cookie。
 *
 * **两个副本共用同一个库、同一个 `BETTER_AUTH_SECRET`**：在其中一个副本上注册拿到的
 * cookie，原样带到另一个副本也认——这件事本身就是「登录态不绑单个进程」的证据，
 * 多副本测试借这一步顺手断言一次（见 `multi-replica.e2e.test.ts` 场景①）。
 */
import { signUpResponseSchema } from './schemas.js';

export interface AuthedUser {
  readonly cookie: string;
  readonly userId: string;
}

export interface SignUpOptions {
  readonly email: string;
  readonly password: string;
  readonly name: string;
}

/**
 * 从 `Set-Cookie` 响应头里抠出「能原样塞进下一次请求 Cookie 头」的部分——只要
 * `name=value`，丢掉 `Path`/`HttpOnly`/`SameSite` 等属性（那些是说给浏览器听的，
 * 不是 cookie 值本身的一部分）。
 */
function cookieHeaderFrom(res: Response): string {
  const pairs = res.headers
    .getSetCookie()
    .map((raw) => raw.split(';')[0])
    .filter((pair): pair is string => pair !== undefined && pair.length > 0);
  if (pairs.length === 0) {
    throw new Error('sign-up response carried no set-cookie header');
  }
  return pairs.join('; ');
}

export async function signUp(
  baseUrl: string,
  opts: SignUpOptions,
): Promise<AuthedUser> {
  const res = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts),
  });
  if (!res.ok) {
    throw new Error(
      `sign-up failed: ${String(res.status)} ${await res.text()}`,
    );
  }
  const cookie = cookieHeaderFrom(res);
  // `Response.json()` 没有类型签名（its declared return type is `Promise<any>`）——立刻交给
  // zod 校验，这一行是这份 `any` 唯一能落脚的地方。
  const body: unknown = await res.json();
  const { user } = signUpResponseSchema.parse(body);
  return { cookie, userId: user.id };
}
