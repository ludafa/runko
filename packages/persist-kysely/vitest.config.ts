import { defineConfig } from "vitest/config";

// 独立存在是必需的（同 packages/agent/vitest.config.ts 的理由）：vitest@4 从 cwd
// 向上找配置，没有本文件时 `pnpm -F @nimbo/persist-kysely test` 会一路找到根配置的
// projects glob，相对错误的 root 解析导致 "No projects were found"。
export default defineConfig({
  test: {
    name: "persist-kysely",
    environment: "node",
    include: ["test/**/*.test.ts"],
    // **默认的 5s 在这个包里不够用，必须调大。** 两条理由，都不是「测试写慢了」：
    //
    // 1. 一致性套件里「**心跳自己发现被接管**」那条自带一个 3 秒的等待窗口（它就是
    //    要等心跳自己发现，不能靠调 `nextSeq` 提前触发），加上建连 + 建表 + 两次
    //    acquire，5s 只剩不到 2s 余量。
    // 2. CI 上 `pnpm -r test` 是多个包并发跑的（web 的 18 个测试文件、mongo、mysql
    //    同时在抢 CPU），上面那点余量会被调度延迟吃掉——真挂过一次，两条都是
    //    `Test timed out in 5000ms`，本地单跑却全绿。
    //
    // 调大**不会掩盖真正的卡死**：套件里每条等待都有自己的内层 deadline（3s 那条
    // 到点就断言失败），这里只是别让外层超时抢在断言之前。
    testTimeout: 30_000,
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["**/dist/**", "**/*.d.ts"],
    },
  },
});
