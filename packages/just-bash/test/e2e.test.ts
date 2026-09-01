/**
 * End-to-end wiring: mock model drives a real `createSession` + `justBash`
 * bash tool (docs/tech/core-sdk.md §4.5b "端到端两件套" 验收点). Mirrors
 * `@nimbo/core`'s `test/e2e-minibash.test.ts` pattern one-for-one, swapped to
 * the full-syntax interpreter:
 *   a) a mock model tool-calls `bash` to run an if/for/case script, and the
 *      tool part comes back settled (`state: "output-available"`) with the
 *      expected output;
 *   b) bypass proof — `bash` writes through a real shell redirect
 *      (`echo x > /f.txt`), which invalidates `readState` for that path (the
 *      §4.5a mode A rule 2 "readState invalidation" mechanism) so a
 *      subsequent `edit-file` is rejected until the path is re-read.
 *
 * P13-5-2（docs/tech/single-ledger.md）迁移：断言从 `SessionEvent`/
 * `SessionItem`（`.status`）改为 `NimboChunk`/账本工具部件（`.state`）——同
 * `@nimbo/core`'s `test/e2e-minibash.test.ts` 的迁移，一比一对应；辅助函数
 * 就地内联（不跨包 import 测试辅助，沿两包既有"各自 test 文件自包含"的风格）。
 */
import { createFileTools, fromMemory } from "@nimbo/virtual-fs";
import { createDerivedDataCollector, createSession, createSessionReadState, defineAgent } from "@nimbo/core";
import type { AgentDefinition, NimboChunk, NimboUIMessage } from "@nimbo/core";
import { isToolUIPart, simulateReadableStream } from "ai";
import type { ToolUIPart, UITools } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { justBash } from "../src/index.js";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
} as const;

function toolCallStep(toolCallId: string, toolName: string, input: unknown) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "tool-call" as const, toolCallId, toolName, input: JSON.stringify(input) },
        { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage },
      ],
      initialDelayInMs: null,
      chunkDelayInMs: null,
    }),
  };
}

function stopStep(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "t1" },
        { type: "text-delta" as const, id: "t1", delta: text },
        { type: "text-end" as const, id: "t1" },
        { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
      ],
      initialDelayInMs: null,
      chunkDelayInMs: null,
    }),
  };
}

type Step = ReturnType<typeof toolCallStep> | ReturnType<typeof stopStep>;

function mockModel(steps: Step[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({ doStream: steps });
}

async function drainStream(gen: AsyncGenerator<NimboChunk, unknown>): Promise<NimboChunk[]> {
  const chunks: NimboChunk[] = [];
  let next = await gen.next();
  while (!next.done) {
    chunks.push(next.value);
    next = await gen.next();
  }
  return chunks;
}

/** 一条消息里全部工具部件（`tool-<名字>`，排除理论上不会出现的 `dynamic-tool`）。 */
function toolPartsOf(message: NimboUIMessage): ToolUIPart<UITools>[] {
  const result: ToolUIPart<UITools>[] = [];
  for (const part of message.parts) {
    if (isToolUIPart<UITools>(part) && part.type !== "dynamic-tool") {result.push(part);}
  }
  return result;
}

/** 账本级查找：全部消息里的全部工具部件 flatMap——同一 toolCallId 只记结算态，理应各出现一次。 */
function toolCallItems(messages: NimboUIMessage[]): ToolUIPart<UITools>[] {
  return messages.flatMap(toolPartsOf);
}

function stringOutput(output: unknown): string {
  return typeof output === "string" ? output : "";
}
/** Same `{ isError, content }` narrowing pattern as core's `integration.test.ts`. */
function errorResultContent(output: unknown): string {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {return "";}
  if (!("isError" in output) || output.isError !== true) {return "";}
  if (!("content" in output)) {return "";}
  return typeof output.content === "string" ? output.content : "";
}

describe("a) mock model drives bash through a real if/for/case script", () => {
  it("bash runs the script via justBash and the tool part settles output-available with the expected output", async () => {
    const fs = fromMemory({});
    const exec = justBash(fs);
    const script = [
      "for w in a b c; do",
      '  if [ "$w" = "b" ]; then',
      "    echo found-b",
      "  fi",
      "done",
      'case "$w" in',
      "  c) echo last-is-c ;;",
      "  *) echo last-is-other ;;",
      "esac",
    ].join("\n");
    const model = mockModel([toolCallStep("call_1", "bash", { command: script }), stopStep("done")]);
    const session = createSession(defineAgent({ model }), { fs, exec });

    await drainStream(session.stream("run the control-flow script"));
    const toolCalls = toolCallItems(session.toJSON().messages);

    expect(toolCalls[0]).toMatchObject({ state: "output-available" });
    const output = stringOutput(toolCalls[0]?.output);
    expect(output).toContain("found-b");
    expect(output).toContain("last-is-c");
    expect(output).toContain("exit code: 0");
  });
});

describe("b) bypass proof: bash's real redirect write invalidates readState (§4.5a mode A rule 2)", () => {
  function assembleFileToolsSession(model: MockLanguageModelV4, fs: ReturnType<typeof fromMemory>) {
    const exec = justBash(fs);
    const readState = createSessionReadState();
    const derivedData = createDerivedDataCollector();
    const fileTools = createFileTools({
      readState,
      onFileChange: (changes) => changes.forEach((change) => derivedData.recordFileChange(change)),
    });
    const agent: AgentDefinition = defineAgent({ model, tools: fileTools });
    return createSession(agent, { fs, exec, readState, derivedData });
  }

  it("read-file, then a bash redirect write, then edit-file is rejected until the path is re-read — and re-reading unblocks it", async () => {
    const fs = fromMemory({ "/f.txt": "hello" });
    const model = mockModel([
      toolCallStep("call_1", "read-file", { path: "/f.txt" }),
      toolCallStep("call_2", "bash", { command: "echo -n changed-by-bash > /f.txt" }),
      toolCallStep("call_3", "edit-file", { path: "/f.txt", old_string: "hello", new_string: "nope" }),
      toolCallStep("call_4", "read-file", { path: "/f.txt" }),
      toolCallStep("call_5", "edit-file", { path: "/f.txt", old_string: "changed-by-bash", new_string: "edited-after-reread" }),
      stopStep("done"),
    ]);
    const session = assembleFileToolsSession(model, fs);

    await drainStream(session.stream("read, bash-write, try to edit (denied), reread, edit (allowed)"));
    const toolCalls = toolCallItems(session.toJSON().messages);

    expect(toolCalls[0]).toMatchObject({ state: "output-available" }); // read-file
    expect(toolCalls[1]).toMatchObject({ state: "output-available" }); // bash redirect write, real just-bash, real exit 0
    expect(stringOutput(toolCalls[1]?.output)).toContain("exit code: 0");

    // edit-file's execute() itself returns normally with an { isError: true, content } value (docs/tech/builtin-tools.md §0.5) —
    // state stays "output-available", the rejection shows up in output.
    expect(toolCalls[2]).toMatchObject({ state: "output-available" });
    expect(errorResultContent(toolCalls[2]?.output)).toContain("changed since it was last read");

    expect(toolCalls[3]).toMatchObject({ state: "output-available" }); // read-file again picks up bash's write
    expect(stringOutput(toolCalls[3]?.output)).toContain("changed-by-bash");

    expect(toolCalls[4]).toMatchObject({ state: "output-available" }); // edit-file now succeeds
    expect(new TextDecoder().decode(await fs.readFile("/f.txt"))).toBe("edited-after-reread");
  });
});
