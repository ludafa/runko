import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  ApprovalOutcome,
  ApprovalPolicy,
  ContentSearchGroup,
  ContentSearchLine,
  ContentSearchQuery,
  ContentSearchResult,
  DirEntry,
  ExecResult,
  FileSearchQuery,
  FileSearchResult,
  FileStat,
  HumanDecision,
  JsonValue,
  NimboExec,
  NimboFS,
  Tool,
  ToolContext,
} from "../src/types.js";
import { jsonValueSchema } from "../src/types.js";

describe("ApprovalOutcome (docs/agent/single-ledger/tech.md §6.1 三值)", () => {
  it("is exactly the three-value union — nothing more, nothing less", () => {
    expectTypeOf<ApprovalOutcome>().toEqualTypeOf<"allow" | "review" | "deny">();
  });

  it("rejects the retired two-value ApprovalDecision-era literals at the type level", () => {
    expectTypeOf<"never">().not.toExtend<ApprovalOutcome>();
    expectTypeOf<"always">().not.toExtend<ApprovalOutcome>();
    expectTypeOf<"once">().not.toExtend<ApprovalOutcome>();
  });

  it("each of the three literals is a runtime-usable ApprovalOutcome value", () => {
    const outcomes: ApprovalOutcome[] = ["allow", "review", "deny"];
    expect(outcomes).toEqual(["allow", "review", "deny"]);
  });
});

describe("ApprovalPolicy (docs/agent/single-ledger/tech.md §6.1)", () => {
  it("accepts the four fixed-string policies at the type level", () => {
    expectTypeOf<"allow">().toExtend<ApprovalPolicy>();
    expectTypeOf<"review">().toExtend<ApprovalPolicy>();
    expectTypeOf<"review-once">().toExtend<ApprovalPolicy>();
    expectTypeOf<"deny">().toExtend<ApprovalPolicy>();
  });

  it("rejects the retired 'never'/'always'/'once' literals at the type level (2026-07-15 三值重构)", () => {
    expectTypeOf<"never">().not.toExtend<ApprovalPolicy>();
    expectTypeOf<"always">().not.toExtend<ApprovalPolicy>();
    expectTypeOf<"once">().not.toExtend<ApprovalPolicy>();
  });
});

describe("HumanDecision (docs/agent/single-ledger/tech.md §6.3 — two values only, updatedInput deleted)", () => {
  it("narrows to no extra payload on the allow branch", () => {
    const decision: HumanDecision = { behavior: "allow" };
    expect(decision.behavior).toBe("allow");

    if (decision.behavior !== "allow") throw new Error("unreachable");
    expectTypeOf(decision).not.toHaveProperty("message");
    expectTypeOf(decision).not.toHaveProperty("updatedInput");
  });

  it("narrows to an optional message on the deny branch", () => {
    const decision: HumanDecision = { behavior: "deny", message: "not allowed" };
    expect(decision.behavior).toBe("deny");

    if (decision.behavior !== "deny") throw new Error("unreachable");
    expectTypeOf(decision).toHaveProperty("message");
    expectTypeOf(decision.message).toEqualTypeOf<string | undefined>();
  });

  it("allows the deny branch to omit its optional message", () => {
    const deny: HumanDecision = { behavior: "deny" };
    expect(deny.behavior).toBe("deny");
  });

  it("the allow branch's own declared shape has no updatedInput property (deleted 2026-07-15, docs/agent/single-ledger/tech.md §6.3)", () => {
    expectTypeOf<Extract<HumanDecision, { behavior: "allow" }>>().not.toHaveProperty("updatedInput");
  });
});

describe("FileStat", () => {
  it("supports the three type branches", () => {
    const file: FileStat = { type: "file", size: 12, mimeType: "text/plain" };
    const dir: FileStat = { type: "dir" };
    const reference: FileStat = {
      type: "reference",
      href: "https://ci.example.com/builds/123/app.apk",
      mimeType: "application/vnd.android.package-archive",
      annotations: { description: "nightly APK build", tags: ["ci"] },
    };

    expect(file.type).toBe("file");
    expect(dir.type).toBe("dir");
    expect(reference.type).toBe("reference");
    expect(reference.href).toBe("https://ci.example.com/builds/123/app.apk");
  });

  it("keeps href/mimeType/annotations optional on non-reference entries", () => {
    const file: FileStat = { type: "file" };
    expect(file.href).toBeUndefined();
  });

  it("types type/href precisely", () => {
    expectTypeOf<FileStat["type"]>().toEqualTypeOf<"file" | "dir" | "reference">();
    expectTypeOf<FileStat["href"]>().toEqualTypeOf<string | undefined>();
  });
});

describe("DirEntry", () => {
  it("extends FileStat with a name", () => {
    const entry: DirEntry = { name: "builds", type: "dir" };
    const referenceEntry: DirEntry = {
      name: "app.apk",
      type: "reference",
      href: "https://ci.example.com/builds/123/app.apk",
    };

    expect(entry.name).toBe("builds");
    expect(referenceEntry.href).toBe("https://ci.example.com/builds/123/app.apk");
  });
});

describe("jsonValueSchema", () => {
  it("accepts nested JSON-shaped values", () => {
    const value: JsonValue = { a: 1, b: [true, null, "x"], c: { nested: "y" } };
    expect(jsonValueSchema.safeParse(value).success).toBe(true);
  });

  it("rejects values that are not JSON-shaped", () => {
    expect(jsonValueSchema.safeParse(undefined).success).toBe(false);
  });
});

describe("NimboFS / NimboExec / Tool / ToolContext shapes", () => {
  it("accepts a minimal conforming NimboFS implementation", () => {
    const fs: NimboFS = {
      readFile: async () => new Uint8Array(),
      writeFile: async () => {},
      rm: async () => {},
      mkdir: async () => {},
      readdir: async () => [],
      stat: async () => ({ type: "file" }),
      glob: async () => [],
    };
    expect(typeof fs.readFile).toBe("function");
  });

  it("accepts a minimal conforming NimboExec implementation", () => {
    const exec: NimboExec = {
      exec: async (): Promise<ExecResult> => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 0 }),
      defaultApproval: "review",
    };
    expect(exec.defaultApproval).toBe("review");
  });

  it("accepts a minimal conforming Tool + ToolContext pair", async () => {
    const fs: NimboFS = {
      readFile: async () => new Uint8Array(),
      writeFile: async () => {},
      rm: async () => {},
      mkdir: async () => {},
      readdir: async () => [],
      stat: async () => ({ type: "file" }),
      glob: async () => [],
    };
    const ctx: ToolContext = {
      fs,
      abortSignal: new AbortController().signal,
      callId: "call_1",
      session: { id: "sess_1", turn: 0 },
      getSkill: () => ({ file: () => ({ text: async () => "" }) }),
      update: () => {},
    };
    const tool: Tool = {
      description: "echoes input",
      inputSchema: jsonValueSchema,
      execute: (input) => input,
    };

    expect(await tool.execute("hi", ctx)).toBe("hi");
  });

  it("accepts a NimboFS implementation that also implements the optional searchFiles/searchContent seam (docs/host/sandbox/tech.md §4)", async () => {
    const fs: NimboFS = {
      readFile: async () => new Uint8Array(),
      writeFile: async () => {},
      rm: async () => {},
      mkdir: async () => {},
      readdir: async () => [],
      stat: async () => ({ type: "file" }),
      glob: async () => [],
      searchFiles: async () => ({ paths: ["/a.ts"], total: 1 }),
      searchContent: async () => ({ groups: [], totalFiles: 0, lineCapped: false }),
    };
    expect(await fs.searchFiles?.({ pattern: "/**/*.ts", limit: 10 })).toEqual({ paths: ["/a.ts"], total: 1 });
    expect(await fs.searchContent?.({ pattern: "TODO", scope: "/**", mode: "files", maxFiles: 100, maxLines: 500 })).toEqual({
      groups: [],
      totalFiles: 0,
      lineCapped: false,
    });
  });
});

describe("FileSearchQuery / FileSearchResult (NimboFS.searchFiles, docs/host/sandbox/tech.md §4)", () => {
  it("requires pattern + limit; ignore is optional", () => {
    const withoutIgnore: FileSearchQuery = { pattern: "/app/**", limit: 1000 };
    const withIgnore: FileSearchQuery = { pattern: "/app/**", ignore: ["**/.git", "**/node_modules"], limit: 1000 };
    expect(withoutIgnore.ignore).toBeUndefined();
    expect(withIgnore.ignore).toEqual(["**/.git", "**/node_modules"]);
  });

  it("types limit as a required number and ignore as an optional string array", () => {
    expectTypeOf<FileSearchQuery["limit"]>().toEqualTypeOf<number>();
    expectTypeOf<FileSearchQuery["ignore"]>().toEqualTypeOf<string[] | undefined>();
  });

  it("FileSearchResult pairs a paths array with a total count that need not equal paths.length (source-truncated)", () => {
    const result: FileSearchResult = { paths: ["/a.ts", "/b.ts"], total: 5 };
    expect(result.paths).toHaveLength(2);
    expect(result.total).toBe(5);
  });
});

describe("ContentSearchQuery / ContentSearchResult (NimboFS.searchContent, docs/host/sandbox/tech.md §4)", () => {
  it("requires pattern/scope/mode/maxFiles/maxLines; ignoreCase/ignore/context are optional", () => {
    const minimal: ContentSearchQuery = { pattern: "TODO", scope: "/**", mode: "files", maxFiles: 100, maxLines: 500 };
    expect(minimal.ignoreCase).toBeUndefined();
    expect(minimal.ignore).toBeUndefined();
    expect(minimal.context).toBeUndefined();

    const full: ContentSearchQuery = {
      pattern: "TODO",
      ignoreCase: true,
      scope: "/src/**",
      ignore: ["**/.git"],
      mode: "content",
      context: 2,
      maxFiles: 100,
      maxLines: 500,
    };
    expect(full.mode).toBe("content");
    expect(full.context).toBe(2);
  });

  it("mode is exactly the two-value union 'files' | 'content'", () => {
    expectTypeOf<ContentSearchQuery["mode"]>().toEqualTypeOf<"files" | "content">();
  });

  it("ContentSearchLine carries a 1-based line number, its text, and whether it's the matched line vs. ±context", () => {
    const matchLine: ContentSearchLine = { line: 3, text: "TODO here", match: true };
    const contextLine: ContentSearchLine = { line: 2, text: "l2", match: false };
    expect(matchLine.match).toBe(true);
    expect(contextLine.match).toBe(false);
  });

  it("ContentSearchGroup.lines is [] in files mode (files mode doesn't report line-level detail)", () => {
    const group: ContentSearchGroup = { path: "/a.ts", lines: [] };
    expect(group.lines).toEqual([]);
  });

  it("ContentSearchResult carries totalFiles (pre-maxFiles-truncation count) and a lineCapped flag", () => {
    const result: ContentSearchResult = {
      groups: [{ path: "/a.ts", lines: [{ line: 1, text: "TODO", match: true }] }],
      totalFiles: 1,
      lineCapped: false,
    };
    expect(result.totalFiles).toBe(1);
    expect(result.lineCapped).toBe(false);
  });

  it("types totalFiles as number and lineCapped as boolean", () => {
    expectTypeOf<ContentSearchResult["totalFiles"]>().toEqualTypeOf<number>();
    expectTypeOf<ContentSearchResult["lineCapped"]>().toEqualTypeOf<boolean>();
  });
});
