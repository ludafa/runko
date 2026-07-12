import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  platform: "node",
  dts: true,
  clean: true,
  // 同 just-bash：package.json "type": "module" 下走 .js/.cjs 双产物
  fixedExtension: false,
});
