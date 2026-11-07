import path from 'node:path';

import {
  cloudflareTest,
  readD1Migrations,
} from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// 测试跑在真的 workerd 里（vitest 4 下 vitest-pool-workers 是一个 Vite 插件）。绑定写在
// test/wrangler.jsonc；D1 迁移在 Node 这一侧读出来，作为绑定交给测试里的 setup 去跑。
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './test/wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(
            path.join(import.meta.dirname, 'migrations'),
          ),
        },
      },
    })),
  ],
  test: {
    name: 'cloudflare-server',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/apply-migrations.ts'],
    // 有几条要等演示模型跑完一整轮（每段之间 20ms）。
    testTimeout: 20_000,
  },
});
