import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "persist-demo",
    environment: "node",
    include: ["test/**/*.test.ts"],
    // e2e 要起真 HTTP 服务 + 建库，比单测慢一档。
    testTimeout: 30_000,
  },
});
