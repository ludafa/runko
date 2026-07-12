import { describe, expect, it } from "vitest";
import type { ParsedScript, ParsedStage } from "../src/parse.js";
import { MiniBashParseError, parse } from "../src/parse.js";

/**
 * 大多数既有用例（P6-1 遗留）只关心"一条链、一个管道、`|` 连接若干阶段、
 * 没有 2>&1"这种最常见的形状——用这个 helper 把 `string[][]` 组装成新的
 * `ParsedScript`，让那些用例的期望值保持和以前一样一目了然，不必逐个手写
 * `{ pipeline: [...], next: undefined }` 的样板。
 */
function simple(...stages: string[][]): ParsedScript {
  const pipeline: ParsedStage[] = stages.map((argv) => ({ argv, mergeStderr: false }));
  return [[{ pipeline, next: undefined }]];
}

describe("parse", () => {
  it("splits a simple command on whitespace", () => {
    expect(parse("cat a.txt")).toEqual(simple(["cat", "a.txt"]));
  });

  it("collapses repeated whitespace between tokens", () => {
    expect(parse("cat   a.txt   b.txt")).toEqual(simple(["cat", "a.txt", "b.txt"]));
  });

  describe("quoting", () => {
    it("keeps spaces inside single quotes as one token", () => {
      expect(parse("echo 'hello world'")).toEqual(simple(["echo", "hello world"]));
    });

    it("keeps spaces inside double quotes as one token", () => {
      expect(parse('echo "hello world"')).toEqual(simple(["echo", "hello world"]));
    });

    it("suppresses all expansion inside single quotes (literal $)", () => {
      expect(parse("echo '$HOME is safe'")).toEqual(simple(["echo", "$HOME is safe"]));
    });

    it("allows double quotes nested inside single quotes", () => {
      expect(parse(`echo 'she said "hi"'`)).toEqual(simple(["echo", 'she said "hi"']));
    });

    it("allows single quotes nested inside double quotes", () => {
      expect(parse(`echo "it's fine"`)).toEqual(simple(["echo", "it's fine"]));
    });

    it("concatenates adjacent quoted and unquoted segments into one token", () => {
      expect(parse(`echo foo"bar baz"qux`)).toEqual(simple(["echo", "foobar bazqux"]));
    });

    it("does not treat a pipe character inside quotes as a pipe", () => {
      expect(parse('echo "a | b"')).toEqual(simple(["echo", "a | b"]));
    });

    it("handles \\\" and \\\\ escapes inside double quotes", () => {
      expect(parse('echo "a\\"b\\\\c"')).toEqual(simple(["echo", 'a"b\\c']));
    });

    it("throws on an unterminated single quote", () => {
      expect(() => parse("echo 'abc")).toThrow(MiniBashParseError);
    });

    it("throws on an unterminated double quote", () => {
      expect(() => parse('echo "abc')).toThrow(MiniBashParseError);
    });

    it("does not treat ; inside quotes as a command separator", () => {
      expect(parse('echo "a; b"')).toEqual(simple(["echo", "a; b"]));
    });

    it("does not treat && / || inside quotes as logical operators", () => {
      expect(parse(`echo 'a && b || c'`)).toEqual(simple(["echo", "a && b || c"]));
    });

    it("does not treat 2>&1 inside quotes as the merge-stderr token", () => {
      expect(parse('echo "2>&1"')).toEqual(simple(["echo", "2>&1"]));
    });
  });

  describe("pipes", () => {
    it("splits a single-level pipeline into stages", () => {
      expect(parse("cat a.txt | grep -n foo | head -n 2")).toEqual(
        simple(["cat", "a.txt"], ["grep", "-n", "foo"], ["head", "-n", "2"]),
      );
    });

    it("throws on a leading pipe (empty command)", () => {
      expect(() => parse("| cat a.txt")).toThrow(MiniBashParseError);
    });

    it("throws on a trailing pipe (empty command)", () => {
      expect(() => parse("cat a.txt |")).toThrow(MiniBashParseError);
    });
  });

  describe("glob characters are passed through literally", () => {
    it("does not error and does not expand *, ?, [ ]", () => {
      expect(parse("echo *.txt file?.md [abc]")).toEqual(simple(["echo", "*.txt", "file?.md", "[abc]"]));
    });
  });

  describe("unsupported syntax reports explicit errors", () => {
    it.each([
      ["redirection >", "echo hi > out.txt", /重定向/, />/],
      ["redirection >>", "echo hi >> out.txt", /重定向/, />>/],
      ["redirection <", "cat < in.txt", /重定向/, /</],
      ["variable expansion $var", "echo $HOME", /变量/, /\$var/],
      ["variable expansion ${var}", "echo ${HOME}", /变量/, /\$var/],
      ["backtick command substitution", "echo `date`", /子 shell/, /`/],
      ["$() command substitution", "echo $(date)", /子 shell/, /\$\(/],
      ["variable expansion inside double quotes", 'echo "$HOME"', /变量/, /\$var/],
      ["backtick command substitution inside double quotes", 'echo "`date`"', /子 shell/, /`/],
      ["background &", "echo a &", /后台执行/, /&/],
    ])("%s", (_label, command, messagePattern, tokenPattern) => {
      let error: unknown;
      try {
        parse(command);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(MiniBashParseError);
      const message = error instanceof Error ? error.message : "";
      expect(message).toContain("mini-bash 不支持");
      expect(message).toMatch(messagePattern);
      expect(message).toMatch(tokenPattern);
    });

    it("redirection > guidance points to write_file", () => {
      expect(() => parse("echo hi > out.txt")).toThrow(/写文件请改用 write_file 工具/);
    });

    it("redirection >> guidance points to write_file", () => {
      expect(() => parse("echo hi >> out.txt")).toThrow(/写文件请改用 write_file 工具/);
    });

    it("redirection 2>file (stderr-to-file, distinct from 2>&1) is still rejected with write_file guidance", () => {
      expect(() => parse("cat missing.txt 2>err.txt")).toThrow(/写文件请改用 write_file 工具/);
    });

    it("redirection < guidance points to cat <file>", () => {
      expect(() => parse("cat < in.txt")).toThrow(/读文件请直接 cat <file>/);
    });
  });

  describe("command separator ;", () => {
    it("splits into independent chains, each a single-pipeline link", () => {
      expect(parse("echo a; echo b")).toEqual([
        [{ pipeline: [{ argv: ["echo", "a"], mergeStderr: false }], next: undefined }],
        [{ pipeline: [{ argv: ["echo", "b"], mergeStderr: false }], next: undefined }],
      ]);
    });

    it("supports more than two chains", () => {
      expect(parse("echo a; echo b; echo c")).toEqual([
        [{ pipeline: [{ argv: ["echo", "a"], mergeStderr: false }], next: undefined }],
        [{ pipeline: [{ argv: ["echo", "b"], mergeStderr: false }], next: undefined }],
        [{ pipeline: [{ argv: ["echo", "c"], mergeStderr: false }], next: undefined }],
      ]);
    });

    it("does not require surrounding whitespace", () => {
      expect(parse("echo a;echo b")).toEqual([
        [{ pipeline: [{ argv: ["echo", "a"], mergeStderr: false }], next: undefined }],
        [{ pipeline: [{ argv: ["echo", "b"], mergeStderr: false }], next: undefined }],
      ]);
    });

    it("throws on a leading ; (empty command)", () => {
      expect(() => parse("; echo a")).toThrow(MiniBashParseError);
    });

    it("throws on a trailing ; (empty command)", () => {
      expect(() => parse("echo a;")).toThrow(MiniBashParseError);
    });

    it("throws on two consecutive ; (empty command in between)", () => {
      expect(() => parse("echo a;; echo b")).toThrow(MiniBashParseError);
    });
  });

  describe("logical operators && / ||", () => {
    it("&& produces a two-link chain with next: '&&' on the first link", () => {
      expect(parse("echo a && echo b")).toEqual([
        [
          { pipeline: [{ argv: ["echo", "a"], mergeStderr: false }], next: "&&" },
          { pipeline: [{ argv: ["echo", "b"], mergeStderr: false }], next: undefined },
        ],
      ]);
    });

    it("|| produces a two-link chain with next: '||' on the first link", () => {
      expect(parse("echo a || echo b")).toEqual([
        [
          { pipeline: [{ argv: ["echo", "a"], mergeStderr: false }], next: "||" },
          { pipeline: [{ argv: ["echo", "b"], mergeStderr: false }], next: undefined },
        ],
      ]);
    });

    it("does not require surrounding whitespace", () => {
      expect(parse("echo a&&echo b")).toEqual([
        [
          { pipeline: [{ argv: ["echo", "a"], mergeStderr: false }], next: "&&" },
          { pipeline: [{ argv: ["echo", "b"], mergeStderr: false }], next: undefined },
        ],
      ]);
    });

    it("&& and || are left-associative within one chain (three links)", () => {
      expect(parse("echo a || echo b && echo c")).toEqual([
        [
          { pipeline: [{ argv: ["echo", "a"], mergeStderr: false }], next: "||" },
          { pipeline: [{ argv: ["echo", "b"], mergeStderr: false }], next: "&&" },
          { pipeline: [{ argv: ["echo", "c"], mergeStderr: false }], next: undefined },
        ],
      ]);
    });

    it("| binds tighter than && / || (a pipeline is one link)", () => {
      expect(parse("cat a.txt | grep x && echo found")).toEqual([
        [
          {
            pipeline: [
              { argv: ["cat", "a.txt"], mergeStderr: false },
              { argv: ["grep", "x"], mergeStderr: false },
            ],
            next: "&&",
          },
          { pipeline: [{ argv: ["echo", "found"], mergeStderr: false }], next: undefined },
        ],
      ]);
    });

    it("; separates independent chains, each possibly containing && / ||", () => {
      expect(parse("echo a && echo b; echo c")).toEqual([
        [
          { pipeline: [{ argv: ["echo", "a"], mergeStderr: false }], next: "&&" },
          { pipeline: [{ argv: ["echo", "b"], mergeStderr: false }], next: undefined },
        ],
        [{ pipeline: [{ argv: ["echo", "c"], mergeStderr: false }], next: undefined }],
      ]);
    });

    it("throws on a trailing && (empty command)", () => {
      expect(() => parse("echo a &&")).toThrow(MiniBashParseError);
    });

    it("throws on a trailing || (empty command)", () => {
      expect(() => parse("echo a ||")).toThrow(MiniBashParseError);
    });

    it("throws on a leading && (empty command)", () => {
      expect(() => parse("&& echo a")).toThrow(MiniBashParseError);
    });
  });

  describe("2>&1", () => {
    it("sets mergeStderr on the stage when it appears at the end of a command", () => {
      expect(parse("cat a.txt 2>&1")).toEqual([[{ pipeline: [{ argv: ["cat", "a.txt"], mergeStderr: true }], next: undefined }]]);
    });

    it("does not appear in argv (consumed as a control token, not a literal arg)", () => {
      const result = parse("cat a.txt 2>&1");
      expect(result[0]?.[0]?.pipeline?.[0]?.argv).toEqual(["cat", "a.txt"]);
    });

    it("is recognized before a pipe: cmd 2>&1 | grep", () => {
      expect(parse("cat a.txt 2>&1 | grep x")).toEqual([
        [
          {
            pipeline: [
              { argv: ["cat", "a.txt"], mergeStderr: true },
              { argv: ["grep", "x"], mergeStderr: false },
            ],
            next: undefined,
          },
        ],
      ]);
    });

    it("is recognized immediately before ; with no space", () => {
      expect(parse("cat a.txt 2>&1;echo b")).toEqual([
        [{ pipeline: [{ argv: ["cat", "a.txt"], mergeStderr: true }], next: undefined }],
        [{ pipeline: [{ argv: ["echo", "b"], mergeStderr: false }], next: undefined }],
      ]);
    });

    it("a lone digit '2' argument is not mistaken for the merge-stderr token", () => {
      expect(parse("head -n 2")).toEqual(simple(["head", "-n", "2"]));
    });

    it("2>file (not 2>&1) is rejected as an ordinary redirection, not treated as a control token", () => {
      expect(() => parse("cat a.txt 2>err.txt")).toThrow(MiniBashParseError);
    });
  });
});
