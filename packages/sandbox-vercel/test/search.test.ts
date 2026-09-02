/**
 * 原生搜索快路径的接线测试（docs/tech/sandbox.md §4，`src/fs.ts`/`src/search-script.ts`）：一次调用 =
 * 一次 `runCommand`、payload 字段（正则 source/scope/ignore/limit/maxFiles/maxLines/context）
 * 传参正确、node 缺失判定的两种触发形态（拒绝 / exit 127）与缓存、脚本真实执行失败（非零/非
 * 127 退出码、非 JSON 输出）不缓存、本地超时不缓存、`glob()` 的 node-缺失回退。
 *
 * 这里的 `FakeVercelSandbox` 不会真的执行 `node -e SEARCH_SCRIPT` ——`runCommandImpl` 只是按测试
 * 需要直接写一段预期形状的 stdout JSON，或模拟失败/超时；`SEARCH_SCRIPT` 本身在真实 node 子进程
 * 里的行为由 `search-script.e2e.test.ts` 用真实 `child_process` 覆盖。
 */
import { SearchUnsupportedError } from "@runko/core";
import { globToRegExp } from "@runko/virtual-fs";
import { describe, expect, it, vi } from "vitest";
import { vercelWorkspace } from "../src/index.js";
import { DEFAULT_ROOT } from "../src/types.js";
import { FakeVercelSandbox, writeChunks } from "./helpers.js";

// ---- args[3] 的 JSON payload 安全解析：同 `src/fs.ts` 的 isRecord/isStringArray 先例，
// 不让 JSON.parse() 的 unknown 逃逸出这几个函数之外。 ----

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

interface ParsedFilesPayload {
  op: string;
  rootPrefix: string;
  startReal: string;
  patternSource: string;
  ignoreSources: string[];
  limit: number;
}

function parseFilesPayload(raw: string | undefined): ParsedFilesPayload {
  if (raw === undefined) {throw new Error("expected a payload argument, got none");}
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) {throw new Error(`expected an object payload, got: ${raw}`);}
  const { op, rootPrefix, startReal, patternSource, ignoreSources, limit } = value;
  if (
    typeof op !== "string" ||
    typeof rootPrefix !== "string" ||
    typeof startReal !== "string" ||
    typeof patternSource !== "string" ||
    !isStringArray(ignoreSources) ||
    typeof limit !== "number"
  ) {
    throw new Error(`payload does not match the expected "files" op shape: ${raw}`);
  }
  return { op, rootPrefix, startReal, patternSource, ignoreSources, limit };
}

interface ParsedContentPayload {
  op: string;
  rootPrefix: string;
  startReal: string;
  scopeSource: string;
  ignoreSources: string[];
  patternSource: string;
  ignoreCase: boolean;
  mode: string;
  context: number;
  maxFiles: number;
  maxLines: number;
}

function parseContentPayload(raw: string | undefined): ParsedContentPayload {
  if (raw === undefined) {throw new Error("expected a payload argument, got none");}
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) {throw new Error(`expected an object payload, got: ${raw}`);}
  const { op, rootPrefix, startReal, scopeSource, ignoreSources, patternSource, ignoreCase, mode, context, maxFiles, maxLines } = value;
  if (
    typeof op !== "string" ||
    typeof rootPrefix !== "string" ||
    typeof startReal !== "string" ||
    typeof scopeSource !== "string" ||
    !isStringArray(ignoreSources) ||
    typeof patternSource !== "string" ||
    typeof ignoreCase !== "boolean" ||
    typeof mode !== "string" ||
    typeof context !== "number" ||
    typeof maxFiles !== "number" ||
    typeof maxLines !== "number"
  ) {
    throw new Error(`payload does not match the expected "content" op shape: ${raw}`);
  }
  return { op, rootPrefix, startReal, scopeSource, ignoreSources, patternSource, ignoreCase, mode, context, maxFiles, maxLines };
}

/** `searchFiles`/`glob()` 用的默认 stub：写一段最小合法的 "files" 结果 JSON。 */
function stubOk(paths: string[] = [], total = paths.length) {
  return async (call: { stdout?: { write: (chunk: string, cb: (e?: Error | null) => void) => void } }): Promise<{ exitCode: number }> => {
    await writeChunks(call.stdout as Parameters<typeof writeChunks>[0], [JSON.stringify({ paths, total })]);
    return { exitCode: 0 };
  };
}

/** `searchContent` 用的默认 stub：写一段最小合法的 "content" 结果 JSON（形状与 "files" 不同）。 */
function stubOkContent() {
  return async (call: { stdout?: { write: (chunk: string, cb: (e?: Error | null) => void) => void } }): Promise<{ exitCode: number }> => {
    await writeChunks(call.stdout as Parameters<typeof writeChunks>[0], [JSON.stringify({ groups: [], totalFiles: 0, lineCapped: false })]);
    return { exitCode: 0 };
  };
}

describe("searchFiles: single round-trip, correct payload", () => {
  it("issues exactly one runCommand call with cmd=node and the script as -e argument", async () => {
    const sandbox = new FakeVercelSandbox({ runCommandImpl: stubOk() });
    const ws = vercelWorkspace(sandbox);

    await ws.searchFiles?.({ pattern: "/src/**/*.ts", ignore: ["**/.git"], limit: 50 });

    expect(sandbox.calls).toHaveLength(1);
    expect(sandbox.calls[0]?.cmd).toBe("node");
    expect(sandbox.calls[0]?.args[0]).toBe("-e");
    expect(sandbox.calls[0]?.args[2]).toBe("--");
  });

  it("pre-compiles pattern/ignore into regex sources and anchors startReal to the pattern's static prefix under root", async () => {
    const sandbox = new FakeVercelSandbox({ runCommandImpl: stubOk() });
    const ws = vercelWorkspace(sandbox);

    await ws.searchFiles?.({ pattern: "/src/**/*.ts", ignore: ["**/.git", "**/node_modules"], limit: 50 });

    const payload = parseFilesPayload(sandbox.calls[0]?.args[3]);
    expect(payload.op).toBe("files");
    expect(payload.patternSource).toBe(globToRegExp("/src/**/*.ts").source);
    expect(payload.ignoreSources).toEqual([globToRegExp("**/.git").source, globToRegExp("**/node_modules").source]);
    expect(payload.limit).toBe(50);
    expect(payload.rootPrefix).toBe(DEFAULT_ROOT);
    expect(payload.startReal).toBe(`${DEFAULT_ROOT}/src`); // static (non-wildcard) prefix of the pattern
  });

  it("anchors startReal to root itself when the pattern has no static prefix", async () => {
    const sandbox = new FakeVercelSandbox({ runCommandImpl: stubOk() });
    const ws = vercelWorkspace(sandbox);

    await ws.searchFiles?.({ pattern: "/**/*.ts", limit: 1000 });

    const payload = parseFilesPayload(sandbox.calls[0]?.args[3]);
    expect(payload.startReal).toBe(DEFAULT_ROOT);
    expect(payload.ignoreSources).toEqual([]); // no ignore passed → empty array, not undefined
  });

  it("respects a custom root option when anchoring startReal/rootPrefix", async () => {
    const sandbox = new FakeVercelSandbox({ root: "/workspace", runCommandImpl: stubOk() });
    const ws = vercelWorkspace(sandbox, { root: "/workspace" });

    await ws.searchFiles?.({ pattern: "/src/*.ts", limit: 10 });

    const payload = parseFilesPayload(sandbox.calls[0]?.args[3]);
    expect(payload.rootPrefix).toBe("/workspace");
    expect(payload.startReal).toBe("/workspace/src");
  });
});

describe("searchContent: correct payload for both modes", () => {
  it("passes scope/ignore/pattern/ignoreCase/mode/context/maxFiles/maxLines through as given", async () => {
    const sandbox = new FakeVercelSandbox({ runCommandImpl: stubOkContent() });
    const ws = vercelWorkspace(sandbox);

    await ws.searchContent?.({
      pattern: "TODO",
      ignoreCase: true,
      scope: "/src/**",
      ignore: ["**/.git"],
      mode: "content",
      context: 2,
      maxFiles: 10,
      maxLines: 20,
    });

    const payload = parseContentPayload(sandbox.calls[0]?.args[3]);
    expect(payload.op).toBe("content");
    expect(payload.scopeSource).toBe(globToRegExp("/src/**").source);
    expect(payload.ignoreSources).toEqual([globToRegExp("**/.git").source]);
    expect(payload.patternSource).toBe("TODO");
    expect(payload.ignoreCase).toBe(true);
    expect(payload.mode).toBe("content");
    expect(payload.context).toBe(2);
    expect(payload.maxFiles).toBe(10);
    expect(payload.maxLines).toBe(20);
  });

  it("defaults ignoreCase to false and context to 0 in the payload when the query omits them", async () => {
    const sandbox = new FakeVercelSandbox({ runCommandImpl: stubOkContent() });
    const ws = vercelWorkspace(sandbox);

    await ws.searchContent?.({ pattern: "TODO", scope: "/**", mode: "files", maxFiles: 100, maxLines: 500 });

    const payload = parseContentPayload(sandbox.calls[0]?.args[3]);
    expect(payload.ignoreCase).toBe(false);
    expect(payload.context).toBe(0);
    expect(payload.mode).toBe("files");
  });
});

describe("node unavailable: two detection triggers, both cached for the adapter instance's lifetime", () => {
  it("runCommand() rejecting is treated as 'no usable node' — SearchUnsupportedError, cached (no retry on the next call)", async () => {
    const runCommandImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const sandbox = new FakeVercelSandbox({ runCommandImpl });
    const ws = vercelWorkspace(sandbox);

    await expect(ws.searchFiles?.({ pattern: "/**", limit: 10 })).rejects.toBeInstanceOf(SearchUnsupportedError);
    await expect(ws.searchContent?.({ pattern: "x", scope: "/**", mode: "files", maxFiles: 10, maxLines: 10 })).rejects.toBeInstanceOf(
      SearchUnsupportedError,
    );

    expect(runCommandImpl).toHaveBeenCalledTimes(1); // second call short-circuited from the cache, no second runCommand attempt.
  });

  it("exitCode 127 ('command not found') is treated as 'no usable node' — SearchUnsupportedError, cached", async () => {
    const runCommandImpl = vi.fn().mockResolvedValue({ exitCode: 127 });
    const sandbox = new FakeVercelSandbox({ runCommandImpl });
    const ws = vercelWorkspace(sandbox);

    await expect(ws.searchFiles?.({ pattern: "/**", limit: 10 })).rejects.toBeInstanceOf(SearchUnsupportedError);
    await expect(ws.searchFiles?.({ pattern: "/**", limit: 10 })).rejects.toBeInstanceOf(SearchUnsupportedError);

    expect(runCommandImpl).toHaveBeenCalledTimes(1);
  });

  it("the cache is scoped to one vercelWorkspace()/createVercelFs() instance, not the underlying sandbox", async () => {
    const runCommandImpl = vi.fn().mockResolvedValue({ exitCode: 127 });
    const sandbox = new FakeVercelSandbox({ runCommandImpl });

    const ws1 = vercelWorkspace(sandbox);
    await expect(ws1.searchFiles?.({ pattern: "/**", limit: 10 })).rejects.toBeInstanceOf(SearchUnsupportedError);
    expect(runCommandImpl).toHaveBeenCalledTimes(1);

    const ws2 = vercelWorkspace(sandbox); // a fresh adapter instance over the same sandbox
    await expect(ws2.searchFiles?.({ pattern: "/**", limit: 10 })).rejects.toBeInstanceOf(SearchUnsupportedError);
    expect(runCommandImpl).toHaveBeenCalledTimes(2); // ws2 has its own cache, tried again independently.
  });
});

describe("script actually ran but failed: a real bug, not 'no node' — not cached, surfaces as a plain Error", () => {
  it("a non-zero, non-127 exit code throws a plain Error carrying the stderr summary, and is retried on the next call", async () => {
    const runCommandImpl = vi.fn(async (call: { stderr?: { write: (chunk: string, cb: (e?: Error | null) => void) => void } }) => {
      await writeChunks(call.stderr as Parameters<typeof writeChunks>[0], ["TypeError: boom"]);
      return { exitCode: 1 };
    });
    const sandbox = new FakeVercelSandbox({ runCommandImpl });
    const ws = vercelWorkspace(sandbox);

    const first = ws.searchFiles?.({ pattern: "/**", limit: 10 });
    await expect(first).rejects.toThrow(/exited 1/);
    await expect(first).rejects.not.toBeInstanceOf(SearchUnsupportedError);
    await expect(first).rejects.toThrow(/boom/);

    await expect(ws.searchFiles?.({ pattern: "/**", limit: 10 })).rejects.toThrow(/exited 1/);
    expect(runCommandImpl).toHaveBeenCalledTimes(2); // not cached — retried.
  });

  it("non-JSON stdout (exitCode 0) throws a plain Error, and is retried on the next call", async () => {
    const runCommandImpl = vi.fn().mockResolvedValue({ exitCode: 0 }); // no stdout written at all
    const sandbox = new FakeVercelSandbox({ runCommandImpl });
    const ws = vercelWorkspace(sandbox);

    await expect(ws.searchFiles?.({ pattern: "/**", limit: 10 })).rejects.toThrow(/non-JSON output/);
    await expect(ws.searchFiles?.({ pattern: "/**", limit: 10 })).rejects.toThrow(/non-JSON output/);
    expect(runCommandImpl).toHaveBeenCalledTimes(2);
  });
});

describe("local timeout: not cached either, and aborts the in-flight runCommand", () => {
  it("rejects with a timeout error after 60s and marks the passed-through signal aborted, without caching as SearchUnsupportedError", async () => {
    vi.useFakeTimers();
    try {
      let capturedSignal: AbortSignal | undefined;
      const runCommandImpl = vi.fn((call: { signal?: AbortSignal }) => {
        capturedSignal = call.signal;
        return new Promise<{ exitCode: number }>(() => {}); // never resolves — simulates a hung sandbox.
      });
      const sandbox = new FakeVercelSandbox({ runCommandImpl });
      const ws = vercelWorkspace(sandbox);

      const pending = ws.searchFiles?.({ pattern: "/**", limit: 10 });
      const assertion = expect(pending).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;

      expect(capturedSignal?.aborted).toBe(true);
      expect(runCommandImpl).toHaveBeenCalledTimes(1);

      // not cached as "no node" — a second call attempts runCommand again (fresh hang, so give it a
      // real result this time to avoid leaving another pending timer around).
      runCommandImpl.mockResolvedValueOnce({ exitCode: 127 });
      await expect(ws.searchFiles?.({ pattern: "/**", limit: 10 })).rejects.toBeInstanceOf(SearchUnsupportedError);
      expect(runCommandImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("glob(): same node-unavailable detection, falls back to walkFiles, and the fallback is not itself cached as unsupported", () => {
  it("after node is found unavailable once, subsequent glob() calls skip runCommand entirely (cached) and use walkFiles", async () => {
    const runCommandImpl = vi.fn().mockResolvedValue({ exitCode: 127 });
    const sandbox = new FakeVercelSandbox({ runCommandImpl, files: { "/a.ts": "1", "/b.ts": "2" } });
    const ws = vercelWorkspace(sandbox);

    expect(await ws.glob("**/*.ts")).toEqual(["/a.ts", "/b.ts"]);
    expect(runCommandImpl).toHaveBeenCalledTimes(1);

    expect(await ws.glob("**/*.ts")).toEqual(["/a.ts", "/b.ts"]);
    expect(runCommandImpl).toHaveBeenCalledTimes(1); // second call never touched runCommand at all.
  });
});
