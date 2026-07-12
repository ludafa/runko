import { fromMemory } from "@nimbo/virtual-fs";
import { describe, expect, it } from "vitest";
import { miniBash } from "../src/index.js";

describe("@nimbo/mini-bash smoke", () => {
  it("exposes miniBash(fs) returning a NimboExec", async () => {
    const fs = fromMemory({ "/hello.txt": "hi\n" });
    const bash = miniBash(fs);
    expect(bash.defaultApproval).toBe("never");
    expect(typeof bash.describe).toBe("function");
    const result = await bash.exec({ command: "cat /hello.txt", signal: new AbortController().signal });
    expect(result).toEqual({ exitCode: 0, stdout: "hi\n", stderr: "", durationMs: expect.any(Number) });
  });
});
