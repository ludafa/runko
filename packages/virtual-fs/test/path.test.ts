import { describe, expect, it } from "vitest";
import { PathEscapesRootError, basename, dirname, globToRegExp, matchesGlob, normalizePath } from "../src/path.js";

describe("normalizePath", () => {
  it("normalizes an already-absolute path unchanged", () => {
    expect(normalizePath("/a/b/c.txt")).toBe("/a/b/c.txt");
  });

  it("treats a relative path as rooted at /", () => {
    expect(normalizePath("a/b.txt")).toBe("/a/b.txt");
  });

  it("collapses repeated slashes", () => {
    expect(normalizePath("/a//b///c.txt")).toBe("/a/b/c.txt");
  });

  it("drops '.' segments", () => {
    expect(normalizePath("/a/./b/./c.txt")).toBe("/a/b/c.txt");
  });

  it("resolves non-escaping '..' segments", () => {
    expect(normalizePath("/a/b/../c.txt")).toBe("/a/c.txt");
  });

  it("resolves the root path", () => {
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("")).toBe("/");
    expect(normalizePath(".")).toBe("/");
  });

  it("rejects a relative '..' that escapes the root", () => {
    expect(() => normalizePath("../x")).toThrow(PathEscapesRootError);
  });

  it("rejects an absolute path that escapes the root after normalization", () => {
    expect(() => normalizePath("/a/../../etc/passwd")).toThrow(PathEscapesRootError);
  });

  it("rejects a bare '..' at the root", () => {
    expect(() => normalizePath("/..")).toThrow(PathEscapesRootError);
  });

  it("carries the original input on the error", () => {
    try {
      normalizePath("../x");
      throw new Error("expected normalizePath to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PathEscapesRootError);
      if (error instanceof PathEscapesRootError) {
        expect(error.path).toBe("../x");
      }
    }
  });
});

describe("dirname/basename", () => {
  it("splits a nested path", () => {
    expect(dirname("/a/b/c.txt")).toBe("/a/b");
    expect(basename("/a/b/c.txt")).toBe("c.txt");
  });

  it("handles a top-level path", () => {
    expect(dirname("/a.txt")).toBe("/");
    expect(basename("/a.txt")).toBe("a.txt");
  });

  it("handles the root itself", () => {
    expect(dirname("/")).toBe("/");
    expect(basename("/")).toBe("/");
  });
});

describe("globToRegExp / matchesGlob", () => {
  it("matches a single-segment wildcard within one directory level", () => {
    expect(matchesGlob("*.md", "/README.md")).toBe(true);
    expect(matchesGlob("*.md", "/docs/README.md")).toBe(false);
  });

  it("matches '**' across any depth, including zero segments", () => {
    expect(matchesGlob("**/*.ts", "/index.ts")).toBe(true);
    expect(matchesGlob("**/*.ts", "/src/nested/index.ts")).toBe(true);
    expect(matchesGlob("**/*.ts", "/src/index.js")).toBe(false);
  });

  it("matches '?' as exactly one non-slash character", () => {
    expect(matchesGlob("/a?.txt", "/ab.txt")).toBe(true);
    expect(matchesGlob("/a?.txt", "/abc.txt")).toBe(false);
    expect(matchesGlob("/a?.txt", "/a/.txt")).toBe(false);
  });

  it("escapes regex-special characters in literal segments", () => {
    expect(matchesGlob("/a.b.txt", "/a.b.txt")).toBe(true);
    expect(matchesGlob("/a.b.txt", "/aXb.txt")).toBe(false);
  });
});
