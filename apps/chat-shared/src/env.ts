/**
 * 环境变量的读口。两个服务端都用它：Node 版就是 `process.env`；Cloudflare 版在开了
 * `nodejs_compat` 时 `process.env` 也有（装着 vars 与 secrets），但各处更推荐把 Worker 的
 * `env` 显式传进来——所以凡是读配置的函数都收一个 `env` 参数，缺省才落到这里。
 */
export type EnvLike = Readonly<Record<string, string | undefined>>;

/** `process` 不存在（没开 `nodejs_compat` 的 Worker）时给一个空对象，读配置的地方一律当「没配」。 */
export function processEnv(): EnvLike {
  return typeof process === 'undefined' ? {} : process.env;
}
