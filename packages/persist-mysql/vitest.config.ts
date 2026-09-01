import { defineConfig } from "vitest/config";

// 独立存在是必需的（同 packages/agent/vitest.config.ts 的理由）：vitest@4 从 cwd
// 向上找配置，没有本文件时 `pnpm -F @nimbo/persist-mysql test` 会一路找到根配置的
// projects glob，相对错误的 root 解析导致 "No projects were found"。
export default defineConfig({
  test: {
    name: "persist-mysql",
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["**/dist/**", "**/*.d.ts"],
    },
  },
});
