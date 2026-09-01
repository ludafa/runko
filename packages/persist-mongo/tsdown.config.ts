import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  platform: "node",
  dts: true,
  clean: true,
  // 同其余包：package.json 声明 "type": "module"，关掉 fixedExtension 让 ESM 走
  // .js/.d.ts、CJS 走 .cjs/.d.cts。
  fixedExtension: false,
});
