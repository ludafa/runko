// 测试里 `env` 的类型：应用自己的 `Env`，加上配置里塞进来的迁移列表。
type AppEnv = import('../src/env.js').Env;

declare namespace Cloudflare {
  interface Env extends AppEnv {
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
  interface Exports {
    default: Fetcher;
  }
}
