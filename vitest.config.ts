import { defineConfig } from "vitest/config";

// vitest@4 移除了 vitest.workspace.ts；四包项目改用 test.projects 聚合，
// 在仓库根跑 `pnpm coverage` 时对四包一起做 v8 覆盖率统计与阈值校验。
export default defineConfig({
  test: {
    projects: ["packages/*"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/dist/**", "**/test/**", "**/*.d.ts", "**/*.config.ts"],
      thresholds: {
        lines: 90,
      },
    },
  },
});
