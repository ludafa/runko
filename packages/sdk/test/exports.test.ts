/**
 * P7-1 acceptance item 5 ("冒烟升级"): the P0 placeholder smoke test (`RUNKO_SDK_VERSION`
 * constant) is replaced by real export-surface assertions — every layer's public symbols
 * (`@runko/core` L0/L1/L2, `@runko/virtual-fs` FS implementations + file tools,
 * `@runko/mini-bash`) must be importable from this single `@runko/sdk` barrel, plus the
 * two P7-specific additions (`RunkoFS` value namespace, the default-assembly `createSession`).
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import * as sdk from "../src/index.js";
import type {
  AgentDefinition,
  FileToolName,
  RunkoFS as RunkoFSType,
  Session,
  SessionOptions,
  Skill as SkillType,
  Tool,
} from "../src/index.js";

describe("@runko/sdk re-exports @runko/core's L0/L1/L2 surface", () => {
  it("L1 definition layer: defineAgent/defineTool/defineSkill", () => {
    expect(typeof sdk.defineAgent).toBe("function");
    expect(typeof sdk.defineTool).toBe("function");
    expect(typeof sdk.defineSkill).toBe("function");
  });

  it("Skill value namespace (interface+const co-existing in the same module, P5-1 precedent)", () => {
    expect(typeof sdk.Skill.fromDirectory).toBe("function");
    expect(typeof sdk.Skill.fromFS).toBe("function");
    expect(typeof sdk.Skill.fromMarkdown).toBe("function");
  });

  it("builtinTools constants: BuiltinToolName + READ_ONLY_TOOLS", () => {
    expect(sdk.READ_ONLY_TOOLS).toEqual(["read-file", "list-dir", "glob", "grep"]);
  });

  it("L2 runtime helpers: createSessionReadState/createDerivedDataCollector/RunkoSessionError", () => {
    expect(typeof sdk.createSessionReadState).toBe("function");
    expect(typeof sdk.createDerivedDataCollector).toBe("function");
    expect(typeof sdk.RunkoSessionError).toBe("function");
    const readState = sdk.createSessionReadState();
    expect(readState.get("/a.txt")).toBeUndefined();
  });

  it("version marker flows through unchanged", () => {
    expect(sdk.RUNKO_CORE_VERSION).toBe("0.0.0");
  });
});

describe("@runko/sdk re-exports @runko/virtual-fs's surface", () => {
  it("FS implementations + factories", () => {
    expect(typeof sdk.MemoryFS).toBe("function");
    expect(typeof sdk.OverlayFS).toBe("function");
    expect(typeof sdk.DirFS).toBe("function");
    expect(typeof sdk.fromMemory).toBe("function");
    expect(typeof sdk.fromDirectory).toBe("function");
  });

  it("file tools eight-set factory", () => {
    expect(typeof sdk.createFileTools).toBe("function");
    const readState = sdk.createSessionReadState();
    const tools = sdk.createFileTools({ readState });
    const names = Object.keys(tools).sort();
    expect(names).toEqual(["delete-file", "edit-file", "glob", "grep", "list-dir", "move-file", "read-file", "write-file"]);
  });

  it("diff/mime/path helpers", () => {
    expect(typeof sdk.buildFileDiff).toBe("function");
    expect(typeof sdk.inferMimeType).toBe("function");
    expect(typeof sdk.normalizePath).toBe("function");
  });
});

describe("@runko/sdk re-exports @runko/mini-bash's surface", () => {
  it("miniBash factory", () => {
    expect(typeof sdk.miniBash).toBe("function");
    const fs = sdk.fromMemory({ "a.txt": "hello" });
    const exec = sdk.miniBash(fs);
    expect(exec.defaultApproval).toBe("allow");
  });
});

describe("@runko/sdk's own additions", () => {
  it("createSession is the facade version (a function), distinct in behavior from core's raw one", () => {
    expect(typeof sdk.createSession).toBe("function");
  });

  it("RunkoFS value namespace exposes fromMemory/fromDirectory", () => {
    expect(typeof sdk.RunkoFS.fromMemory).toBe("function");
    expect(typeof sdk.RunkoFS.fromDirectory).toBe("function");
  });
});

describe("type-level export surface (compiles => passes; verified by typecheck, asserted here for documentation)", () => {
  it("core types are importable from the single barrel", () => {
    expectTypeOf<AgentDefinition["model"]>().not.toBeAny();
    expectTypeOf<SessionOptions["fs"]>().toEqualTypeOf<RunkoFSType | undefined>();
    expectTypeOf<Tool["description"]>().toEqualTypeOf<string>();
  });

  it("virtual-fs's FileToolName type is importable from the single barrel", () => {
    const name: FileToolName = "read-file";
    expect(name).toBe("read-file");
  });

  it("Skill (type) and Session<F> (sdk-local generic) both resolve without a cast", () => {
    expectTypeOf<Session<RunkoFSType>["fs"]>().toEqualTypeOf<RunkoFSType>();
    expectTypeOf<SkillType["name"]>().toEqualTypeOf<string>();
  });
});
