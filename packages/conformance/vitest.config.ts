import { defineConfig } from "vitest/config";

// 独立存在是必需的（同其余包的理由）：vitest@4 从 cwd 向上找配置，没有本文件时
// `pnpm -F @nimbo/conformance test` 会一路找到根配置的 projects glob，相对错误的 root
// 解析导致 "No projects were found"。
export default defineConfig({
  test: {
    name: "conformance",
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["**/dist/**", "**/*.d.ts"],
    },
  },
});
