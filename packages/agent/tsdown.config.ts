import { defineConfig } from "tsdown";

export default defineConfig({
  // 一个入口。一致性套件曾经是这里的第二个入口（`@runko/agent/conformance`），后来
  // 拆成了独立包 `@runko/conformance`——它需要一套断言，而断言不该把测试框架拖进一个
  // **运行时**包的依赖里。
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  platform: "node",
  dts: true,
  clean: true,
  // 同 packages/virtual-fs：package.json 是 "type": "module"，关掉 fixedExtension
  // 让 ESM 走 .js/.d.ts、CJS 走 .cjs/.d.cts。
  fixedExtension: false,
});
