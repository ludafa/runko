import { fromMemory } from "@runko/virtual-fs";
import { describe, expect, it } from "vitest";
import { miniBash } from "../src/index.js";

describe("@runko/mini-bash smoke", () => {
  it("exposes miniBash(fs) returning a RunkoExec", async () => {
    const fs = fromMemory({ "/hello.txt": "hi\n" });
    const bash = miniBash(fs);
    expect(bash.defaultApproval).toBe("allow");
    expect(typeof bash.describe).toBe("function");
    const result = await bash.exec({ command: "cat /hello.txt", signal: new AbortController().signal });
    expect(result).toEqual({ exitCode: 0, stdout: "hi\n", stderr: "", durationMs: expect.any(Number) });
  });
});
