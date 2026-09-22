/**
 * 两个测试文件共用的进程环境变量拼装：库怎么选、副本身份怎么定、鉴权密钥怎么给。
 *
 * chat 应用零配置也能跑，但**多副本测试必须显式打开**：不给 `RUNKO_NODE_URL`，
 * `createChatArbitration` 就退回单进程模式（holder 固定是 `'local'`），怎么杀怎么冻都测不出
 * 归属仲裁——这正是 `docs/host/node/features/multi-replica.md` 那张环境变量表的由来。
 */
/** 两个副本共用同一把内部令牌，防的是「伪造转发标记」，不是真鉴权（见 `routes/forward.ts`）。 */
export const PEER_TOKEN = 'e2e-peer-token';

/** better-auth 要求密钥至少 32 字符；两个副本必须给同一个值，注册出来的 cookie 才能跨副本认。 */
export const BETTER_AUTH_SECRET =
  'e2e-shared-secret-not-for-production-0123456789';

/**
 * 把时间轴压扁：缺省是 5 秒心跳 / 60 秒接管，一个依赖接管的场景要干等一分钟。
 * 阈值必须 ≥ 3 倍心跳，否则副本启动时框架就抛。
 */
export const WANTED_HEARTBEAT_MS = 200;
export const WANTED_TAKEOVER_MS = 900;

/** 实际生效的接管阈值 —— 依赖接管的用例据此设轮询上限。 */
export const EFFECTIVE_TAKEOVER_MS = WANTED_TAKEOVER_MS;

export interface DbSelection {
  readonly label: string;
  readonly env: Record<string, string>;
}

/** SQLite 共享文件，或者（配了 `DATABASE_URL` 时）真 Postgres——两个副本指同一个库。 */
export function selectDb(sqlitePath: string): DbSelection {
  const url = process.env.DATABASE_URL?.trim();
  if (url !== undefined && url.length > 0) {
    return { label: 'Postgres（DATABASE_URL）', env: { DATABASE_URL: url } };
  }
  return { label: 'SQLite 文件', env: { DATABASE_PATH: sqlitePath } };
}

export interface ReplicaIdentityOptions {
  readonly port: number;
}

/** 一个副本的身份 + 鉴权配置：自己的可达地址、副本间令牌、共享的 auth secret。 */
export function replicaIdentityEnv(
  opts: ReplicaIdentityOptions,
): Record<string, string> {
  const url = `http://127.0.0.1:${String(opts.port)}`;
  return {
    RUNKO_NODE_URL: url,
    RUNKO_PEER_TOKEN: PEER_TOKEN,
    RUNKO_HEARTBEAT_MS: String(WANTED_HEARTBEAT_MS),
    RUNKO_TAKEOVER_MS: String(WANTED_TAKEOVER_MS),
    BETTER_AUTH_SECRET,
    SERVER_URL: url,
    CLIENT_URL: 'http://127.0.0.1:5173',
  };
}
