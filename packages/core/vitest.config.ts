import { defineConfig } from "vitest/config";

// 独立存在是必需的，不只是风格选择：vitest@4 从 cwd 向上找配置文件，
// 若本包没有自己的 vitest.config.ts，`pnpm -F @runko/core test`（cwd 在包目录）
// 会一路找到根 vitest.config.ts 的 test.projects glob，相对错误的 root 解析导致
// "No projects were found"。有本文件后向上搜索在这里停住，各包可独立运行。
export default defineConfig({
  test: {
    name: "core",
    environment: "node",
    include: ["test/**/*.test.ts"],
    // 包内单跑 --coverage 时与根聚合口径一致：只统计 src，排除测试辅助与配置
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["**/dist/**", "**/*.d.ts"],
    },
  },
});
