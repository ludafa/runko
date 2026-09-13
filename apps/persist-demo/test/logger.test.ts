/**
 * demo 文本 logger 的格式与级别过滤。格式要钉死，是因为多副本验证环境靠「每行以 ISO 时间开头、
 * 列之间两个空格」把几个副本的日志合并成一条时间线（`scripts/lab-logs.ts`）。
 */
import { describe, expect, it } from "vitest";

import { createTextLogger, formatLogLine, parseLogLevel } from "../src/logger.js";

const AT = new Date("2026-09-13T06:30:57.530Z");

describe("formatLogLine", () => {
  it("时间 · 谁 · 级别 · 模块 · 消息 · 字段，列之间两个空格", () => {
    expect(
      formatLogLine({
        at: AT,
        node: "replica-a",
        level: "warn",
        scope: "lease",
        message: "took over a stale lease",
        fields: { conversationId: "c1", staleForMs: 5120, lost: false },
      }),
    ).toBe("2026-09-13T06:30:57.530Z  replica-a   WARN   lease         took over a stale lease  conversationId=c1 staleForMs=5120 lost=false");
  });

  it("值里有空格、引号、等号或为空时加引号；`undefined` 的字段整个不出现", () => {
    const line = formatLogLine({
      at: AT,
      node: "test",
      level: "STEP",
      scope: "S7",
      message: "冻住",
      fields: { cause: "no response headers within 2000ms", path: "/a=b", empty: "", skipped: undefined },
    });
    expect(line.endsWith('cause="no response headers within 2000ms" path="/a=b" empty=""')).toBe(true);
    expect(line).not.toContain("skipped");
  });

  it("没有字段时不留尾巴空格", () => {
    expect(formatLogLine({ at: AT, node: "demo", level: "info", scope: "server", message: "listening" })).toBe(
      "2026-09-13T06:30:57.530Z  demo        INFO   server        listening",
    );
  });
});

describe("createTextLogger", () => {
  it("低于阈值的级别不打", () => {
    const lines: string[] = [];
    const logger = createTextLogger({ node: "demo", level: "warn", write: (line) => lines.push(line), now: () => AT });
    logger.debug("x", "debug");
    logger.info("x", "info");
    logger.warn("x", "warn");
    logger.error("x", "error");
    expect(lines.map((line) => line.trim().split(/\s+/).at(-1))).toEqual(["warn", "error"]);
  });

  it("`silent` 一行都不打", () => {
    const lines: string[] = [];
    const logger = createTextLogger({ node: "demo", level: "silent", write: (line) => lines.push(line) });
    logger.error("x", "error");
    expect(lines).toEqual([]);
  });
});

describe("parseLogLevel", () => {
  it("认得的级别不分大小写；认不出来返回 undefined，由调用方给缺省值", () => {
    expect(parseLogLevel(" DEBUG ")).toBe("debug");
    expect(parseLogLevel("silent")).toBe("silent");
    expect(parseLogLevel("verbose")).toBeUndefined();
    expect(parseLogLevel(undefined)).toBeUndefined();
  });
});
