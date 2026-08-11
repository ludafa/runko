/**
 * `SearchUnsupportedError`（docs/host/sandbox/tech.md §4 原生搜索接缝的唯一运行时产物）：适配器
 * 声明"本次运行时环境无法原生搜索"时抛出的信号类，`grep`/`glob` 工具据此静默回退 JS 扫描。
 */
import { describe, expect, it } from "vitest";
import { SearchUnsupportedError } from "../src/search.js";
import { SearchUnsupportedError as SearchUnsupportedErrorFromIndex } from "../src/index.js";

describe("SearchUnsupportedError", () => {
  it("is an Error subclass named 'SearchUnsupportedError'", () => {
    const error = new SearchUnsupportedError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("SearchUnsupportedError");
  });

  it("has a sensible default message when constructed with no arguments", () => {
    const error = new SearchUnsupportedError();
    expect(error.message.length).toBeGreaterThan(0);
    expect(error.message).toContain("native search");
  });

  it("accepts a custom message (adapters attach their own diagnostic, e.g. 'no usable node in this sandbox')", () => {
    const error = new SearchUnsupportedError("no usable node in this sandbox");
    expect(error.message).toBe("no usable node in this sandbox");
  });

  it("is re-exported from the package's public entry point (@nimbo/core), not just the internal module", () => {
    expect(SearchUnsupportedErrorFromIndex).toBe(SearchUnsupportedError);
  });

  it("is distinguishable from a plain Error by instanceof — grep/glob tools rely on this to decide silent-fallback vs errorResult", () => {
    const plain = new Error("sandbox network dropped");
    expect(plain instanceof SearchUnsupportedError).toBe(false);
    expect(new SearchUnsupportedError() instanceof SearchUnsupportedError).toBe(true);
  });
});
