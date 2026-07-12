import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  platform: "node",
  dts: true,
  clean: true,
  // package.json 声明 "type": "module"：关掉 tsdown 对 node 平台默认打开的
  // fixedExtension，让 ESM 走 .js/.d.ts、CJS 走 .cjs/.d.cts，而不是 .mjs/.d.mts。
  fixedExtension: false,
});
