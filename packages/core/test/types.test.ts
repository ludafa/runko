import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  ApprovalDecision,
  DirEntry,
  ExecResult,
  FileStat,
  JsonValue,
  NimboExec,
  NimboFS,
  Tool,
  ToolContext,
} from "../src/types.js";
import { jsonValueSchema } from "../src/types.js";

describe("ApprovalDecision discriminated union", () => {
  it("narrows to updatedInput on the allow branch, not message", () => {
    const decision: ApprovalDecision = { behavior: "allow", updatedInput: { path: "a.txt" } };
    expect(decision.behavior).toBe("allow");

    if (decision.behavior !== "allow") throw new Error("unreachable");
    expectTypeOf(decision).toHaveProperty("updatedInput");
    expectTypeOf(decision).not.toHaveProperty("message");
    expectTypeOf(decision.updatedInput).toEqualTypeOf<JsonValue | undefined>();
  });

  it("narrows to message on the deny branch, not updatedInput", () => {
    const decision: ApprovalDecision = { behavior: "deny", message: "not allowed" };
    expect(decision.behavior).toBe("deny");

    if (decision.behavior !== "deny") throw new Error("unreachable");
    expectTypeOf(decision).toHaveProperty("message");
    expectTypeOf(decision).not.toHaveProperty("updatedInput");
    expectTypeOf(decision.message).toEqualTypeOf<string | undefined>();
  });

  it("allows both branches to omit their optional payload field", () => {
    const allow: ApprovalDecision = { behavior: "allow" };
    const deny: ApprovalDecision = { behavior: "deny" };
    expect(allow.behavior).toBe("allow");
    expect(deny.behavior).toBe("deny");
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
      defaultApproval: "always",
    };
    expect(exec.defaultApproval).toBe("always");
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
});
