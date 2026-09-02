/**
 * 全只读断言：六命令 + 管道组合执行后，FS 内容（含 mtime）与执行前的快照
 * 完全一致——mini-bash 不实现任何写路径，这里用 MemoryFS.snapshot() 做
 * 端到端证据，而不仅仅是"代码里没调 writeFile"这种静态论证。
 */
import { fromMemory } from "@runko/virtual-fs";
import { describe, expect, it } from "vitest";
import { run } from "./helpers.js";

describe("read-only guarantee", () => {
  it("leaves the filesystem snapshot unchanged after running every command and a pipeline", async () => {
    const fs = fromMemory({
      "/a.txt": "line1\nline2\nline3\n",
      "/b.txt": "foo\nbar\nfoo again\n",
      "/dir/c.txt": "hello\n",
      "/dir/sub/d.txt": "world\n",
    });
    const before = fs.snapshot();

    const commands = [
      "cat /a.txt /b.txt",
      "cat /nope.txt",
      "grep -nic foo /b.txt",
      "grep -l foo /a.txt /b.txt",
      "find /dir -type f -name '*.txt'",
      "find /dir -type d",
      "find /missing",
      "head -n 2 /a.txt",
      "tail -n 2 /a.txt",
      "echo -n hello world",
      "cat /a.txt | grep -n line | head -n 1",
      "cat /a.txt > out.txt", // 不支持语法，解析阶段即失败，同样不应有任何副作用
      "cat < in.txt", // 同上，< 也不应有任何副作用
      "echo a; echo b; echo c",
      "grep zzz /a.txt && cat /a.txt",
      "grep zzz /a.txt || echo fallback",
      "grep zzz /a.txt && cat /a.txt || echo fallback",
      "cat /a.txt | grep line && echo found",
      "cat /nope.txt 2>&1",
      "cat /nope.txt 2>&1 | grep 'No such'",
      "nope; echo b", // 未知命令的链之后仍继续跑，同样不应有任何写副作用
      "cd /dir && pwd",
      "cd /dir/sub; cat d.txt",
      "cd", // 无参数回根
      "cd /missing", // 目标不存在
      "cd /a.txt", // 目标不是目录
      "cd -", // 明确不支持
      "cd /dir /a.txt", // 参数过多
      "cd /dir | cat", // 管道内 cd：子 shell 语义，无外部效果
      "pwd",
    ];
    for (const command of commands) {
      await run(fs, command);
    }

    expect(fs.snapshot()).toEqual(before);
  });
});
