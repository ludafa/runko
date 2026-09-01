/**
 * 文件工具测试的共享辅助（不是 *.test.ts，vitest 不会把它当测试文件收集）。
 */
import type { JsonValue, NimboFS, ToolContext, ToolReturn } from "@nimbo/core";
import { expect, vi } from "vitest";
import type { FileChange, ReadStateStore } from "../../src/tools/shared.js";

/** 工单要求的"接缝"验收方式：测试端只需要一个 Map 实现，不依赖 P4 的真实 session 状态。 */
export function createMapReadStateStore(): ReadStateStore {
  const map = new Map<string, number>();
  return {
    get: (path) => map.get(path),
    set: (path, version) => {
      map.set(path, version);
    },
  };
}

/** Narrows FileStat.mtime (number|undefined) to number by runtime check — no `as` needed. */
export async function readMtime(fs: NimboFS, path: string): Promise<number> {
  const stat = await fs.stat(path);
  if (stat.mtime === undefined) {throw new Error(`expected "${path}" to have an mtime, got undefined`);}
  return stat.mtime;
}

export function makeCtx(fs: NimboFS): ToolContext {
  return {
    fs,
    abortSignal: new AbortController().signal,
    callId: "call_1",
    session: { id: "sess_1", turn: 0 },
    getSkill: () => ({ file: () => ({ text: async () => "" }) }),
    update: () => {},
  };
}

export interface ErrorResultShape {
  isError: true;
  content: string;
}

export function isErrorResult(result: ToolReturn): result is JsonValue & ErrorResultShape {
  return typeof result === "object" && result !== null && !Array.isArray(result) && result.isError === true;
}

/** 断言结果是 isError:true 的错误结果，并返回其 content 字符串供进一步断言。 */
export function expectError(result: ToolReturn): string {
  expect(isErrorResult(result)).toBe(true);
  if (!isErrorResult(result)) {throw new Error("unreachable: expect above already asserted isErrorResult");}
  return result.content;
}

export function expectText(result: ToolReturn): string {
  expect(typeof result).toBe("string");
  return typeof result === "string" ? result : "";
}

export type OnFileChangeMock = ReturnType<typeof vi.fn<(changes: FileChange[]) => void>>;

/** Typed `vi.fn()` for `CreateFileToolsOptions.onFileChange` — avoids `any`-typed mock.calls in assertions. */
export function createOnFileChangeMock(): OnFileChangeMock {
  return vi.fn<(changes: FileChange[]) => void>();
}
