import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// 测试跑在真的 workerd 里（vitest 4 下 vitest-pool-workers 是一个 Vite 插件）。
// Worker 与 Durable Object 的绑定写在 test/wrangler.jsonc。
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./test/wrangler.jsonc" } })],
  test: {
    name: "durable-object",
    include: ["test/**/*.test.ts"],
  },
});
