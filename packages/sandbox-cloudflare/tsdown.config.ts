import { defineConfig } from "tsdown";

export default defineConfig({
  // 双入口：`.` 客户端（任意 Node）+ `./worker` 网关（宿主 wrangler 项目里用，
  // 但本体零 cloudflare import——getSandbox 经参数注入，纯协议翻译，Node 可测）
  entry: ["src/index.ts", "src/worker.ts"],
  format: ["esm", "cjs"],
  platform: "node",
  dts: true,
  clean: true,
  fixedExtension: false,
});
