/**
 * 测试共享辅助（不是 `*.test.ts`，vitest 不会当测试文件收集）。
 *
 * `FakeE2bSandbox`：进程内实现 `E2bSandboxLike` 的假沙盒——不连真实 e2b，
 * 覆盖契约测试所需的全部行为面：内存路径树（文件+目录）、写时抬升
 * `modifiedTime`（`readFile`→`stat` 的 mtime 判据）、`commands.run()` 的一个
 * 微型 DSL（用命令字符串前缀分派，模拟真实 shell 的若干行为——stdout 分片
 * 回调、非零退出抛 `CommandExitError` 形状、e2b 自家 `TimeoutError`/
 * `SandboxNotFoundError` 形状、永不 resolve 用于超时/中止测试、以及一个
 * "按 cwd 相对路径写文件"的命令，用来在 e2e 测试里模拟 bash 旁路写）。
 *
 * fake 刻意复刻真实 SDK 的抛错行为（结构，不是类实例）：e2b 的错误只在
 * `Error.name` 上区分（`FileNotFoundError`/`TimeoutError`/`SandboxNotFoundError`
 * 等，见 e2b@2.32.0 源码），`CommandExitError` 额外携带 `exitCode`/`stdout`/
 * `stderr` 字段——本文件用普通 `Error` + 手工赋值复刻这两种形状，不 import "e2b"。
 */
import type { E2bCommandResult, E2bCommandRunOpts, E2bEntryInfo, E2bFilesystemListOpts, E2bSandboxLike } from "../src/index.js";

export interface FakeE2bSandbox extends E2bSandboxLike {
  /** 断言用：绕过锚定直接读一个真实路径当前的字节，undefined 表示不存在。 */
  debugReadRaw(realPath: string): Uint8Array | undefined;
  /** 断言用：最近一次 `commands.run()` 收到的 `cwd`（验证锚定/透传）。 */
  readonly lastRunCwd: string | undefined;
}

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}

function basenameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return path.slice(idx + 1);
}

function notFoundError(path: string): Error {
  const error = new Error(`no such file or directory: ${path}`);
  error.name = "FileNotFoundError";
  return error;
}

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/** `CommandExitError` 的字段形状（`exitCode`/`stdout`/`stderr`），复刻真实 e2b 抛出的异常结构（不是它的类实例）。 */
function commandExitError(result: E2bCommandResult): Error {
  const error = new Error(result.stderr);
  error.name = "CommandExitError";
  return Object.assign(error, result);
}

export function createFakeE2bSandbox(seedDirs: readonly string[] = ["/home/user"]): FakeE2bSandbox {
  const fileMap = new Map<string, { data: Uint8Array; mtime: Date }>();
  const dirs = new Set<string>(["/", ...seedDirs]);
  let clock = 0;
  let lastRunCwd: string | undefined;

  function nextMtime(): Date {
    const now = Date.now();
    clock = now > clock ? now : clock + 1;
    return new Date(clock);
  }

  function ensureDir(path: string): void {
    if (dirs.has(path)) {return;}
    const parent = dirnameOf(path);
    if (parent !== path) {ensureDir(parent);}
    dirs.add(path);
  }

  function toEntryInfo(path: string): E2bEntryInfo {
    const file = fileMap.get(path);
    if (file) {return { name: basenameOf(path), type: "file", path, size: file.data.byteLength, modifiedTime: file.mtime };}
    return { name: basenameOf(path), type: "dir", path, size: 0 };
  }

  async function writeInternal(path: string, data: Uint8Array | string): Promise<void> {
    ensureDir(dirnameOf(path));
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    fileMap.set(path, { data: bytes, mtime: nextMtime() });
  }

  const sandbox: FakeE2bSandbox = {
    get lastRunCwd() {
      return lastRunCwd;
    },
    debugReadRaw(realPath: string): Uint8Array | undefined {
      return fileMap.get(realPath)?.data;
    },
    files: {
      async read(path: string): Promise<Uint8Array> {
        const file = fileMap.get(path);
        if (!file) {throw notFoundError(path);}
        return file.data;
      },
      async write(path: string, data: string | ArrayBuffer) {
        await writeInternal(path, typeof data === "string" ? data : new Uint8Array(data));
        return { name: basenameOf(path), path };
      },
      async list(path: string, opts?: E2bFilesystemListOpts): Promise<E2bEntryInfo[]> {
        if (!dirs.has(path)) {
          if (fileMap.has(path)) {throw namedError("InvalidArgumentError", `not a directory: ${path}`);}
          throw notFoundError(path);
        }
        const depth = opts?.depth ?? 1;
        const results: E2bEntryInfo[] = [];
        const collect = (dirPath: string, remaining: number): void => {
          if (remaining <= 0) {return;}
          for (const d of dirs) {
            if (d !== dirPath && dirnameOf(d) === dirPath) {
              results.push(toEntryInfo(d));
              collect(d, remaining - 1);
            }
          }
          for (const f of fileMap.keys()) {
            if (dirnameOf(f) === dirPath) {results.push(toEntryInfo(f));}
          }
        };
        collect(path, depth);
        return results;
      },
      async remove(path: string): Promise<void> {
        if (fileMap.has(path)) {
          fileMap.delete(path);
          return;
        }
        if (dirs.has(path)) {
          const prefix = `${path === "/" ? "" : path}/`;
          for (const d of [...dirs]) {if (d.startsWith(prefix)) {dirs.delete(d);}}
          for (const f of [...fileMap.keys()]) {if (f.startsWith(prefix)) {fileMap.delete(f);}}
          dirs.delete(path);
          return;
        }
        throw notFoundError(path);
      },
      async makeDir(path: string): Promise<boolean> {
        if (dirs.has(path)) {return false;}
        ensureDir(path);
        return true;
      },
      async getInfo(path: string): Promise<E2bEntryInfo> {
        if (fileMap.has(path) || dirs.has(path)) {return toEntryInfo(path);}
        throw notFoundError(path);
      },
    },
    commands: {
      async run(command: string, opts?: E2bCommandRunOpts): Promise<E2bCommandResult> {
        lastRunCwd = opts?.cwd;

        if (command === "hang") {return new Promise<E2bCommandResult>(() => {});}

        if (command.startsWith("echo:")) {
          const text = command.slice("echo:".length);
          opts?.onStdout?.(text);
          return { exitCode: 0, stdout: text, stderr: "" };
        }

        if (command.startsWith("chunks:")) {
          const parts = command.slice("chunks:".length).split("|");
          let stdout = "";
          for (const part of parts) {
            opts?.onStdout?.(part);
            stdout += part;
          }
          return { exitCode: 0, stdout, stderr: "" };
        }

        if (command.startsWith("fail:")) {
          const rest = command.slice("fail:".length);
          const sep = rest.indexOf(":");
          const codeText = sep === -1 ? rest : rest.slice(0, sep);
          const message = sep === -1 ? "" : rest.slice(sep + 1);
          opts?.onStderr?.(message);
          throw commandExitError({ exitCode: Number(codeText), stdout: "", stderr: message });
        }

        if (command === "timeout-error") {throw namedError("TimeoutError", "simulated e2b command timeout");}
        if (command === "sandbox-error") {throw namedError("SandboxNotFoundError", "sandbox not found (stopped or expired)");}

        if (command.startsWith("write-file:")) {
          const rest = command.slice("write-file:".length);
          const sep = rest.indexOf(":");
          const rawPath = sep === -1 ? rest : rest.slice(0, sep);
          const content = sep === -1 ? "" : rest.slice(sep + 1);
          const cwd = opts?.cwd ?? "/";
          const realPath = rawPath.startsWith("/") ? rawPath : `${cwd === "/" ? "" : cwd}/${rawPath}`;
          await writeInternal(realPath, content);
          return { exitCode: 0, stdout: "", stderr: "" };
        }

        if (command === "pwd") {return { exitCode: 0, stdout: `${opts?.cwd ?? ""}\n`, stderr: "" };}

        return { exitCode: 0, stdout: command, stderr: "" };
      },
    },
  };

  return sandbox;
}
