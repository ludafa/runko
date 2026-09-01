import { defineConfig } from "tsdown";

export default defineConfig({
  // 两个入口：主门面，以及给各持久化实现自测用的一致性套件（`@nimbo/agent/conformance`）。
  // 套件断言的是**接口的承诺**，所以住在定义接口的包里——persist-sql / 将来的
  // persist-drizzle / 第三方实现都引它自测。它 import vitest，故列为可选 peer。
  entry: ["src/index.ts", "src/conformance.ts"],
  format: ["esm", "cjs"],
  platform: "node",
  dts: true,
  clean: true,
  // 同 packages/virtual-fs：package.json 是 "type": "module"，关掉 fixedExtension
  // 让 ESM 走 .js/.d.ts、CJS 走 .cjs/.d.cts。
  fixedExtension: false,
});
