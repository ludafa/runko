import { defineConfig } from "vitest/config";

// 独立配置为必需（vitest@4 向上搜寻会命中根 test.projects glob 导致
// "No projects were found"），理由同 just-bash 包内注释。
export default defineConfig({
  test: {
    name: "sandbox-vercel",
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["**/dist/**", "**/*.d.ts"],
    },
  },
});
