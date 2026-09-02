/**
 * examples runner —— `pnpm example <编号或名字前缀>` 的分发器。
 *
 * 在 `src/` 下按前缀挑出**唯一**一个示例脚本，用当前 node 直跑（Node 24
 * 原生 type stripping，无需编译）。这是 examples 实验田「打开即用」的入口：
 *
 *   pnpm --filter @runko/examples example 01        # 按编号
 *   pnpm --filter @runko/examples example dir-mount # 按名字片段
 *   cd examples && pnpm example 07                  # 在包内更短
 *
 * 匹配规则（先命中者胜，避免歧义）：精确名 > 前缀 > 包含子串。命中多个则
 * 列出候选让用户写得更具体；命中零个则打印全部可用示例。示例编号之后的
 * 参数原样透传给被跑的脚本（`pnpm example 01 --foo` → `node src/01-*.ts --foo`）。
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "src");

/** 顶层示例脚本的文件名（去掉 .ts 后缀），排除 shared/ 等子目录与非 NN- 脚本。 */
function exampleStems(): string[] {
  return readdirSync(srcDir)
    .filter((name) => /^\d.*\.ts$/.test(name))
    .map((name) => name.replace(/\.ts$/, ""))
    .sort();
}

function printAvailable(): void {
  console.log("可用示例（pnpm example <编号或名字前缀>）：");
  for (const stem of exampleStems()) {console.log(`  ${stem}`);}
}

const arg = process.argv[2]?.trim();
if (arg === undefined || arg.length === 0) {
  console.error("用法：pnpm example <编号或名字前缀>，例如 `pnpm example 01`。\n");
  printAvailable();
  process.exit(1);
}

const stems = exampleStems();
const exact = stems.filter((s) => s === arg);
const prefix = stems.filter((s) => s.startsWith(arg));
const substr = stems.filter((s) => s.includes(arg));
const picked = exact.length > 0 ? exact : prefix.length > 0 ? prefix : substr;

if (picked.length === 0) {
  console.error(`没有匹配 "${arg}" 的示例。\n`);
  printAvailable();
  process.exit(1);
}
if (picked.length > 1) {
  console.error(`"${arg}" 匹配到多个示例，请写得更具体：`);
  for (const stem of picked) {console.error(`  ${stem}`);}
  process.exit(1);
}

// picked.length === 1；下面的 undefined 分支在类型上收窄，运行时不可达（不用非空断言）。
const [chosen] = picked;
if (chosen === undefined) {process.exit(1);}

const scriptPath = join(srcDir, `${chosen}.ts`);
const passthrough = process.argv.slice(3);
const child = spawn(process.execPath, [scriptPath, ...passthrough], { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal !== null) {process.kill(process.pid, signal);}
  else {process.exit(code ?? 0);}
});
