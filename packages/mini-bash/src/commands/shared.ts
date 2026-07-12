/** 六命令共用的读取/格式化辅助——只依赖 NimboFS 七方法，不做任何写入。 */
import type { FileStat, NimboFS } from "@nimbo/core";
import { resolvePath } from "../path.js";

const decoder = new TextDecoder();

export function decodeText(data: Uint8Array): string {
  return decoder.decode(data);
}

/**
 * 受控例外：参数类型是 `unknown` 而非精确类型，因为这里对接的是任意第三方
 * `NimboFS` 实现可能抛出的任意值（`catch` 块的天然边界，不是我们能定义
 * 形状的调用方）——用 `instanceof Error` 做类型守卫收窄，不做类型断言，
 * 影响范围隔离在这一个函数内，不向外扩散 `unknown`。
 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function statSafe(fs: NimboFS, path: string): Promise<FileStat | undefined> {
  try {
    return await fs.stat(path);
  } catch {
    return undefined;
  }
}

export type ReadFileOutcome = { ok: true; text: string } | { ok: false; message: string };

/**
 * POSIX 风格错误文案（"No such file or directory" / "Is a directory"）只靠
 * `stat()` 的返回值区分，不依赖任何具体 NimboFS 实现抛出的错误类——
 * 第三方 NimboFS（模式 A 沙盒适配器）不一定用 @nimbo/virtual-fs 的
 * NotFoundError，这样才能兼容任意实现。
 */
export async function readFileForCommand(fs: NimboFS, cwd: string, cmdName: string, rawPath: string): Promise<ReadFileOutcome> {
  const path = resolvePath(cwd, rawPath);
  const stat = await statSafe(fs, path);
  if (stat === undefined) return { ok: false, message: `${cmdName}: ${rawPath}: No such file or directory` };
  if (stat.type === "dir") return { ok: false, message: `${cmdName}: ${rawPath}: Is a directory` };
  try {
    return { ok: true, text: decodeText(await fs.readFile(path)) };
  } catch (error) {
    return { ok: false, message: `${cmdName}: ${rawPath}: ${describeError(error)}` };
  }
}

/** 按行切分：空字符串 → 0 行；结尾是否有换行不影响行内容，只影响是否存在"半行"。 */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return body.split("\n");
}

/** 行数组拼回文本：非空则每行换行结尾，符合行式命令输出惯例（cat 除外——cat 不按行处理，直接透传原文）。 */
export function joinLines(lines: string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

export interface CountArgs {
  n: number;
  files: string[];
}

/**
 * head/tail 共用的 `-n N` 解析：接受 `-n N`（两个 token）与 `-nN`（一个
 * token）两种写法。N 必须是非负整数——负数在真实 coreutils 里另有"除最后
 * N 行外全部输出"的语义，mini-bash 不支持，直接报错更明确，不静默误解释。
 */
export function parseCountArgs(args: string[], cmdName: string): CountArgs | { error: string } {
  let n = 10;
  let i = 0;
  const first = args[0];
  if (first !== undefined && first.startsWith("-n")) {
    const inline = first.slice(2);
    let raw: string | undefined;
    if (inline.length > 0) {
      raw = inline;
      i = 1;
    } else {
      raw = args[1];
      i = 2;
    }
    const parsed = raw !== undefined ? Number(raw) : NaN;
    if (raw === undefined || !Number.isInteger(parsed) || parsed < 0) {
      return { error: `${cmdName}: invalid number of lines: '${raw ?? ""}'` };
    }
    n = parsed;
  }
  return { n, files: args.slice(i) };
}
