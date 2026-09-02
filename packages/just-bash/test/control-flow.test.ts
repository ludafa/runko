/**
 * 真实控制流脚本在注入 MemoryFS 上跑（工单验收点）：每类语法至少一例，断言
 * stdout/exitCode。这是 mini-bash 六命令解释器撑不住、`@runko/just-bash` 存在
 * 的理由本身（docs/tech/core-sdk.md §4.5b 开篇）。
 */
import { fromMemory } from "@runko/virtual-fs";
import { describe, expect, it } from "vitest";
import { run } from "./helpers.js";

describe("if / elif / else", () => {
  it("branches correctly across if / elif / else", async () => {
    const script = `
      x=2
      if [ "$x" = "1" ]; then echo one
      elif [ "$x" = "2" ]; then echo two
      else echo other
      fi
    `;
    const result = await run(fromMemory({}), script);
    expect(result.stdout).toBe("two\n");
    expect(result.exitCode).toBe(0);
  });
});

describe("for", () => {
  it("list-form for iterates the given words", async () => {
    const result = await run(fromMemory({}), "for w in a b c; do echo $w; done");
    expect(result.stdout).toBe("a\nb\nc\n");
    expect(result.exitCode).toBe(0);
  });

  it("C-style for ((init;cond;update)) counts as expected", async () => {
    const result = await run(fromMemory({}), 'for ((i=0;i<3;i++)); do echo "n=$i"; done');
    expect(result.stdout).toBe("n=0\nn=1\nn=2\n");
    expect(result.exitCode).toBe(0);
  });
});

describe("while / until", () => {
  it("while loops while the condition holds", async () => {
    const result = await run(fromMemory({}), 'i=0; while [ "$i" -lt 3 ]; do echo "w=$i"; i=$((i+1)); done');
    expect(result.stdout).toBe("w=0\nw=1\nw=2\n");
    expect(result.exitCode).toBe(0);
  });

  it("until loops until the condition holds", async () => {
    const result = await run(fromMemory({}), 'i=0; until [ "$i" -ge 3 ]; do echo "u=$i"; i=$((i+1)); done');
    expect(result.stdout).toBe("u=0\nu=1\nu=2\n");
    expect(result.exitCode).toBe(0);
  });
});

describe("case", () => {
  it("matches the correct pattern branch", async () => {
    const script = 'x=b; case "$x" in a) echo A;; b) echo B;; *) echo Z;; esac';
    const result = await run(fromMemory({}), script);
    expect(result.stdout).toBe("B\n");
    expect(result.exitCode).toBe(0);
  });
});

describe("functions + local", () => {
  it("a function with a local variable does not leak it to the caller", async () => {
    const script = 'greet() { local msg="hi-$1"; echo "$msg"; }; greet world; echo "leak=${msg:-unset}"';
    const result = await run(fromMemory({}), script);
    expect(result.stdout).toBe("hi-world\nleak=unset\n");
    expect(result.exitCode).toBe(0);
  });
});

describe("variables and parameter expansion", () => {
  it("expands positional-style defaults and substring parameter expansion", async () => {
    const script = 'name="runko"; echo "${name}" "${missing:-fallback}" "${name:0:3}"';
    const result = await run(fromMemory({}), script);
    expect(result.stdout).toBe("runko fallback run\n");
    expect(result.exitCode).toBe(0);
  });
});

describe("glob expansion", () => {
  it("expands a glob pattern against the injected fs's directory contents", async () => {
    const fs = fromMemory({ "/a.txt": "a", "/b.txt": "b", "/c.md": "c" });
    const result = await run(fs, "echo *.txt", { cwd: "/" });
    expect(result.stdout).toBe("a.txt b.txt\n");
    expect(result.exitCode).toBe(0);
  });
});

describe("redirections: > >> < 2>&1", () => {
  it("> creates/overwrites a file, visible to the injected RunkoFS directly (not just through bash)", async () => {
    const fs = fromMemory({});
    const result = await run(fs, "echo hello > /out.txt", { cwd: "/" });
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(await fs.readFile("/out.txt"))).toBe("hello\n");
  });

  it("> bumps the file's mtime (readState invalidation judge, §4.5a mode A rule 2)", async () => {
    const fs = fromMemory({ "/out.txt": "old\n" });
    const before = await fs.stat("/out.txt");
    // mtime clocks in this codebase are monotonic-but-coarse; a tick guarantees the next write is strictly later.
    await new Promise((resolve) => setTimeout(resolve, 2));
    await run(fs, "echo new > /out.txt", { cwd: "/" });
    const after = await fs.stat("/out.txt");
    expect(new TextDecoder().decode(await fs.readFile("/out.txt"))).toBe("new\n");
    expect(after.mtime).not.toBe(before.mtime);
    expect(after.mtime ?? 0).toBeGreaterThan(before.mtime ?? 0);
  });

  it(">> appends without truncating", async () => {
    const fs = fromMemory({});
    const result = await run(fs, "echo one > /log.txt; echo two >> /log.txt", { cwd: "/" });
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(await fs.readFile("/log.txt"))).toBe("one\ntwo\n");
  });

  it("< feeds a file's contents to a command's stdin", async () => {
    const fs = fromMemory({ "/in.txt": "piped-in\n" });
    const result = await run(fs, "cat < /in.txt", { cwd: "/" });
    expect(result.stdout).toBe("piped-in\n");
    expect(result.exitCode).toBe(0);
  });

  it("2>&1 merges this command's stderr into its stdout", async () => {
    const fs = fromMemory({});
    const result = await run(fs, "cat /nope.txt 2>&1", { cwd: "/" });
    expect(result.stdout).toContain("No such file or directory");
    expect(result.stderr).toBe("");
    expect(result.exitCode).not.toBe(0);
  });
});

describe("pipes", () => {
  it("pipes stdout from one command into the next", async () => {
    const fs = fromMemory({ "/a.txt": "line1\nline2\nline3\n" });
    const result = await run(fs, "cat /a.txt | grep line2", { cwd: "/" });
    expect(result.stdout).toBe("line2\n");
    expect(result.exitCode).toBe(0);
  });
});

describe("&& / ||", () => {
  it("&& short-circuits on failure", async () => {
    const result = await run(fromMemory({}), "false && echo should-not-print");
    expect(result.stdout).toBe("");
    expect(result.exitCode).not.toBe(0);
  });

  it("|| runs the fallback only when the previous command failed", async () => {
    const result = await run(fromMemory({}), "false || echo fallback");
    expect(result.stdout).toBe("fallback\n");
    expect(result.exitCode).toBe(0);
  });
});
