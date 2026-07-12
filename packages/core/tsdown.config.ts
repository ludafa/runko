import { defineConfig } from "tsdown";

export default defineConfig({
  // "src/load.ts" 是 P7-3 新增的第二个入口——落地 tech-spec §4.7 的 `nimbo/load`
  // 子路径（本仓裁量为 @nimbo/core 的 "./load" subpath export，见 package.json
  // "exports" 与 src/load.ts 头注释）。产出 dist/load.js/.cjs/.d.ts/.d.cts，
  // 与主入口 dist/index.* 并列。
  entry: ["src/index.ts", "src/load.ts"],
  format: ["esm", "cjs"],
  platform: "node",
  dts: true,
  clean: true,
  // package.json 声明 "type": "module"：关掉 tsdown 对 node 平台默认打开的
  // fixedExtension，让 ESM 走 .js/.d.ts、CJS 走 .cjs/.d.cts，而不是 .mjs/.d.mts。
  fixedExtension: false,
});
