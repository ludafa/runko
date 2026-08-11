/**
 * `SEARCH_SCRIPT`（`src/search-script.ts`）真实端到端测试：不用任何 fake 假装脚本跑过——
 * `vercelWorkspace(sandbox, { root: tmpDir })` 里的 `sandbox` 是一个真的会 `spawn("node", ...)`
 * 的最小 `VercelSandboxLike` 实现（`fs.*` 直接落在 `node:fs/promises`，`runCommand` 真的启子进程），
 * 指向一个真实、hermetic 的临时目录（`os.tmpdir()`，不落进仓库，afterEach 清理）。
 *
 * 覆盖 docs/host/sandbox/tech.md §4 原生搜索快路径的行为契约：正则匹配、行号、±context、
 * maxFiles/maxLines 双闸截断、ignore 剪枝（ancestor-or-self）、二进制文件跳过——并对着
 * `MemoryFS` + JS 回退路径（同一份文件内容）做结果对拍，证明两条路径在正常输入上语义一致。
 */
import { spawn } from "node:child_process";
import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";
import * as os from "node:os";
import type { Readable } from "node:stream";
import type { ContentSearchQuery, FileSearchQuery, NimboFS, ToolContext } from "@nimbo/core";
import { createFileTools, fromMemory } from "@nimbo/virtual-fs";
import type { ReadStateStore } from "@nimbo/virtual-fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vercelWorkspace } from "../src/index.js";
import type { VercelDirentLike, VercelFileSystemLike, VercelRunCommandParams, VercelSandboxLike, VercelStatsLike } from "../src/types.js";

/** 真实落在 `node:fs/promises` 上的 `VercelFileSystemLike`——不是 fake，是本机磁盘。 */
class RealNodeFileSystem implements VercelFileSystemLike {
  async readFile(path: string): Promise<Uint8Array> {
    return new Uint8Array(await nodeFs.readFile(path));
  }
  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    await nodeFs.writeFile(path, data);
  }
  mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined> {
    return nodeFs.mkdir(path, options);
  }
  async readdir(path: string, options: { withFileTypes: true }): Promise<VercelDirentLike[]> {
    const entries = await nodeFs.readdir(path, options);
    return entries.map((entry) => ({ name: entry.name, isDirectory: () => entry.isDirectory(), isFile: () => entry.isFile() }));
  }
  async stat(path: string): Promise<VercelStatsLike> {
    const stats = await nodeFs.stat(path);
    return { isDirectory: () => stats.isDirectory(), isFile: () => stats.isFile(), size: stats.size, mtimeMs: stats.mtimeMs };
  }
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    return nodeFs.rm(path, options);
  }
  rmdir(path: string): Promise<void> {
    return nodeFs.rmdir(path);
  }
}

/** 真的 `spawn("node", args)`——`runCommand()` 不是 fake，子进程真实执行 `SEARCH_SCRIPT`。 */
class RealNodeSandbox implements VercelSandboxLike {
  readonly fs: VercelFileSystemLike = new RealNodeFileSystem();

  runCommand(params: VercelRunCommandParams): Promise<{ exitCode: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn(params.cmd, params.args ?? [], {
        cwd: params.cwd,
        env: params.env ? { ...process.env, ...params.env } : process.env,
      });
      const onAbort = (): void => void child.kill();
      params.signal?.addEventListener("abort", onAbort);
      pipeInto(child.stdout, params.stdout);
      pipeInto(child.stderr, params.stderr);
      child.on("error", (error) => {
        params.signal?.removeEventListener("abort", onAbort);
        reject(error);
      });
      child.on("close", (code) => {
        params.signal?.removeEventListener("abort", onAbort);
        resolve({ exitCode: code ?? -1 });
      });
    });
  }
}

function pipeInto(source: Readable, dest: VercelRunCommandParams["stdout"]): void {
  if (dest === undefined) return;
  source.on("data", (chunk: Buffer) => {
    dest.write(chunk);
  });
}

/** 供 JS 回退路径的文件工具用——测试端只需要一个 Map 实现（同 `@nimbo/virtual-fs` 测试的先例）。 */
function createMapReadStateStore(): ReadStateStore {
  const map = new Map<string, number>();
  return { get: (path) => map.get(path), set: (path, version) => void map.set(path, version) };
}

function makeToolCtx(fs: NimboFS): ToolContext {
  return {
    fs,
    abortSignal: new AbortController().signal,
    callId: "call_1",
    session: { id: "s", turn: 0 },
    getSkill: () => ({ file: () => ({ text: async () => "" }) }),
    update: () => {},
  };
}

describe("SEARCH_SCRIPT real end-to-end (real node subprocess, real hermetic temp directory)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await nodeFs.mkdtemp(nodePath.join(os.tmpdir(), "nimbo-search-e2e-"));
    await nodeFs.mkdir(nodePath.join(tmpDir, "src", "nested"), { recursive: true });
    await nodeFs.mkdir(nodePath.join(tmpDir, ".git"), { recursive: true });
    await nodeFs.mkdir(nodePath.join(tmpDir, "node_modules", "pkg"), { recursive: true });

    await nodeFs.writeFile(nodePath.join(tmpDir, "src", "a.ts"), "export const TODO = 1;\nline2\nline3 TODO again");
    await nodeFs.writeFile(nodePath.join(tmpDir, "src", "nested", "b.ts"), "TODO\nother");
    await nodeFs.writeFile(nodePath.join(tmpDir, "src", "c.js"), "no match here");
    await nodeFs.writeFile(nodePath.join(tmpDir, "README.md"), "nothing of interest");
    await nodeFs.writeFile(nodePath.join(tmpDir, "case.ts"), "Todo item (different case)");
    await nodeFs.writeFile(nodePath.join(tmpDir, ".git", "config"), "TODO inside git");
    await nodeFs.writeFile(nodePath.join(tmpDir, "node_modules", "pkg", "index.js"), "TODO in node_modules");
    // a real binary file that also happens to contain the ASCII bytes "TODO" — must be skipped by
    // the NUL-byte sniff (script) and by mimeType (JS fallback via MemoryFS), independently.
    await nodeFs.writeFile(nodePath.join(tmpDir, "logo.png"), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]), Buffer.from("TODO")]));
  });

  afterEach(async () => {
    await nodeFs.rm(tmpDir, { recursive: true, force: true });
  });

  /** 同一份文件内容装一份 MemoryFS，供 JS 回退路径对拍（二进制嗅探算法不同，因此只用 .png 这类双方都判定为二进制的扩展名）。 */
  async function equivalentMemoryFs() {
    const files: Record<string, string | Uint8Array> = {
      "src/a.ts": "export const TODO = 1;\nline2\nline3 TODO again",
      "src/nested/b.ts": "TODO\nother",
      "src/c.js": "no match here",
      "README.md": "nothing of interest",
      "case.ts": "Todo item (different case)",
      ".git/config": "TODO inside git",
      "node_modules/pkg/index.js": "TODO in node_modules",
      "logo.png": await nodeFs.readFile(nodePath.join(tmpDir, "logo.png")),
    };
    return fromMemory(files);
  }

  it("searchFiles: matches by glob pattern, skips .git/node_modules by default, sorted", async () => {
    const ws = vercelWorkspace(new RealNodeSandbox(), { root: tmpDir });
    const query: FileSearchQuery = { pattern: "/**/*.ts", ignore: ["**/.git", "**/node_modules"], limit: 1000 };

    const result = await ws.searchFiles?.(query);

    expect(result).toEqual({ paths: ["/case.ts", "/src/a.ts", "/src/nested/b.ts"], total: 3 });
  });

  it("searchFiles: an ignore entry the path digs explicitly inside is not applied (mirrors resolveDefaultIgnore's contract)", async () => {
    const ws = vercelWorkspace(new RealNodeSandbox(), { root: tmpDir });
    const query: FileSearchQuery = { pattern: "/.git/**", ignore: [], limit: 1000 };

    const result = await ws.searchFiles?.(query);

    expect(result).toEqual({ paths: ["/.git/config"], total: 1 });
  });

  it("searchContent files mode: default ignore excludes .git/node_modules hits, binary file is skipped, sorted paths", async () => {
    const ws = vercelWorkspace(new RealNodeSandbox(), { root: tmpDir });
    const query: ContentSearchQuery = {
      pattern: "TODO",
      scope: "/**",
      ignore: ["**/.git", "**/node_modules"],
      mode: "files",
      maxFiles: 100,
      maxLines: 500,
    };

    const result = await ws.searchContent?.(query);

    expect(result).toEqual({
      groups: [
        { path: "/src/a.ts", lines: [] },
        { path: "/src/nested/b.ts", lines: [] },
      ],
      totalFiles: 2,
      lineCapped: false,
    });
  });

  it("searchContent content mode with ±1 context: line numbers and match flags are correct", async () => {
    const ws = vercelWorkspace(new RealNodeSandbox(), { root: tmpDir });
    const query: ContentSearchQuery = {
      pattern: "TODO",
      scope: "/src/**",
      ignore: ["**/.git", "**/node_modules"],
      mode: "content",
      context: 1,
      maxFiles: 100,
      maxLines: 500,
    };

    const result = await ws.searchContent?.(query);

    expect(result).toEqual({
      groups: [
        {
          path: "/src/a.ts",
          lines: [
            { line: 1, text: "export const TODO = 1;", match: true },
            { line: 2, text: "line2", match: false },
            { line: 3, text: "line3 TODO again", match: true },
          ],
        },
        {
          path: "/src/nested/b.ts",
          lines: [
            { line: 1, text: "TODO", match: true },
            { line: 2, text: "other", match: false },
          ],
        },
      ],
      totalFiles: 2,
      lineCapped: false,
    });
  });

  it("searchContent: ignoreCase makes matching case-insensitive", async () => {
    const ws = vercelWorkspace(new RealNodeSandbox(), { root: tmpDir });
    const query: ContentSearchQuery = {
      pattern: "todo",
      ignoreCase: true,
      scope: "/case.ts",
      mode: "files",
      maxFiles: 100,
      maxLines: 500,
    };

    const result = await ws.searchContent?.(query);

    expect(result).toEqual({ groups: [{ path: "/case.ts", lines: [] }], totalFiles: 1, lineCapped: false });
  });

  it("searchContent: files whose only match lives in a NUL-containing binary file are skipped even though the bytes textually contain the pattern", async () => {
    const ws = vercelWorkspace(new RealNodeSandbox(), { root: tmpDir });
    const query: ContentSearchQuery = { pattern: "TODO", scope: "/logo.png", mode: "files", maxFiles: 100, maxLines: 500 };

    const result = await ws.searchContent?.(query);

    expect(result).toEqual({ groups: [], totalFiles: 0, lineCapped: false });
  });

  it("searchContent: maxFiles/maxLines truncation — file count over the cap, but total selected lines under it", async () => {
    for (let i = 0; i < 5; i++) {
      await nodeFs.writeFile(nodePath.join(tmpDir, `many-${String(i)}.ts`), "TODO");
    }
    const ws = vercelWorkspace(new RealNodeSandbox(), { root: tmpDir });
    const query: ContentSearchQuery = { pattern: "TODO", scope: "/many-*.ts", mode: "content", maxFiles: 3, maxLines: 500, context: 0 };

    const result = await ws.searchContent?.(query);

    expect(result?.totalFiles).toBe(5);
    expect(result?.groups).toHaveLength(3); // capped by maxFiles before the line budget even matters
    expect(result?.lineCapped).toBe(false); // 3 one-line files is nowhere near the 500-line budget
  });

  it("searchContent: maxLines truncation splits mid-file (partial group, not all-or-nothing)", async () => {
    const manyLines = Array.from({ length: 10 }, (_, i) => `TODO-${String(i)}`).join("\n");
    await nodeFs.writeFile(nodePath.join(tmpDir, "many.ts"), manyLines);
    const ws = vercelWorkspace(new RealNodeSandbox(), { root: tmpDir });
    const query: ContentSearchQuery = { pattern: "TODO", scope: "/many.ts", mode: "content", maxFiles: 100, maxLines: 4, context: 0 };

    const result = await ws.searchContent?.(query);

    expect(result?.totalFiles).toBe(1);
    expect(result?.lineCapped).toBe(true);
    expect(result?.groups).toEqual([
      {
        path: "/many.ts",
        lines: [
          { line: 1, text: "TODO-0", match: true },
          { line: 2, text: "TODO-1", match: true },
          { line: 3, text: "TODO-2", match: true },
          { line: 4, text: "TODO-3", match: true },
        ],
      },
    ]);
  });

  it("parity: searchFiles (real script) and the MemoryFS/JS-fallback glob tool produce the same matches for the same fixture", async () => {
    const ws = vercelWorkspace(new RealNodeSandbox(), { root: tmpDir });
    const scriptResult = await ws.searchFiles?.({ pattern: "/**/*.ts", ignore: ["**/.git", "**/node_modules"], limit: 1000 });

    const memFs = await equivalentMemoryFs();
    const globTool = createFileTools({ readState: createMapReadStateStore() }).glob;
    const fallbackText = await globTool.execute({ pattern: "**/*.ts" }, makeToolCtx(memFs));

    expect(typeof fallbackText).toBe("string");
    expect(scriptResult?.paths).toEqual(typeof fallbackText === "string" ? fallbackText.split("\n") : []);
  });

  it("parity: searchContent content-mode with context (real script) matches the MemoryFS/JS-fallback grep tool's formatted output", async () => {
    const ws = vercelWorkspace(new RealNodeSandbox(), { root: tmpDir });
    const scriptResult = await ws.searchContent?.({
      pattern: "TODO",
      scope: "/src/**",
      ignore: ["**/.git", "**/node_modules"],
      mode: "content",
      context: 1,
      maxFiles: 100,
      maxLines: 500,
    });

    const memFs = await equivalentMemoryFs();
    const grepTool = createFileTools({ readState: createMapReadStateStore() }).grep;
    const fallbackText = await grepTool.execute({ pattern: "TODO", path: "/src", mode: "content", context: 1 }, makeToolCtx(memFs));

    const scriptFormatted = (scriptResult?.groups ?? [])
      .flatMap((group) => group.lines.map((line) => `${group.path}${line.match ? ":" : "-"}${String(line.line)}${line.match ? ":" : "-"}${line.text}`))
      .join("\n");
    expect(fallbackText).toBe(scriptFormatted);
  });

  /**
   * 回归锁定（第 1 轮验收发现、已修复）：`staticPrefixDir()`（`src/fs.ts`）曾把完全不含
   * 通配符的 pattern/scope 整条（含文件名）当"起始目录"传给脚本的 `readdirSync`——对文件
   * readdirSync 抛 ENOTDIR 被 `walk()` 静默吞掉，"精确文件名"查询在原生路径上恒返回空。
   * 修复后精确路径回退到父目录起走；这组用例锁定该行为不再回退。
   */
  describe("regression: an exact (wildcard-free) pattern/scope matches on the native path", () => {
    it("glob() finds an exact top-level filename (no wildcard)", async () => {
      const ws = vercelWorkspace(new RealNodeSandbox(), { root: tmpDir });
      const matches = await ws.glob("README.md");
      expect(matches).toEqual(["/README.md"]);
    });

    it("glob() finds an exact nested filename (no wildcard)", async () => {
      const ws = vercelWorkspace(new RealNodeSandbox(), { root: tmpDir });
      const matches = await ws.glob("/src/a.ts");
      expect(matches).toEqual(["/src/a.ts"]);
    });

    it("searchFiles finds an exact FileSearchQuery.pattern (no wildcard)", async () => {
      const ws = vercelWorkspace(new RealNodeSandbox(), { root: tmpDir });
      const result = await ws.searchFiles?.({ pattern: "/README.md", limit: 1000 });
      expect(result).toEqual({ paths: ["/README.md"], total: 1 });
    });

    it("searchContent finds candidates via an exact ContentSearchQuery.scope (no wildcard)", async () => {
      const ws = vercelWorkspace(new RealNodeSandbox(), { root: tmpDir });
      const result = await ws.searchContent?.({ pattern: "TODO", scope: "/src/a.ts", mode: "files", maxFiles: 100, maxLines: 500 });
      expect(result).toEqual({ groups: [{ path: "/src/a.ts", lines: [] }], totalFiles: 1, lineCapped: false });
    });
  });
});
