/**
 * 端到端两件套（同 `@nimbo/just-bash`/`@nimbo/core` 的 e2e 先例，一次覆盖
 * `vercelWorkspace()` 真的接进 `createSession` 的两条线）：
 *   a) mock model 调 `bash` 工具跑一条真实脚本，经 `runCommand({cmd:"bash",
 *      args:["-lc", ...]})` 落到 fake sandbox，工具部件正常 output-available；
 *   b) bash 旁路写（fake sandbox 的 fs.writeFile，不经 file 工具）使 readState
 *      失效（模式 A 规则 2），后续 edit-file 被拒绝直到重新 read-file。
 *
 * P13-5-2（docs/tech/single-ledger.md）迁移：断言从 `SessionEvent`/
 * `SessionItem`（`.status`）改为 `NimboChunk`/账本工具部件（`.state`）——同
 * `@nimbo/just-bash`/`@nimbo/sandbox-e2b`/`@nimbo/sandbox-cloudflare` 的
 * `test/e2e.test.ts` 迁移，一比一照搬；辅助函数就地内联（不跨包 import 测试
 * 辅助，沿既有"各自 test 文件自包含"的风格）。
 */
import { createFileTools } from "@nimbo/virtual-fs";
import { createDerivedDataCollector, createSession, createSessionReadState, defineAgent } from "@nimbo/core";
import type { AgentDefinition, NimboChunk, NimboUIMessage } from "@nimbo/core";
import { isToolUIPart, simulateReadableStream } from "ai";
import type { ToolUIPart, UITools } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { vercelWorkspace } from "../src/index.js";
import { FakeVercelSandbox, writeChunks } from "./helpers.js";

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
function errorResultContent(output: unknown): string {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {return "";}
  if (!("isError" in output) || output.isError !== true) {return "";}
  if (!("content" in output)) {return "";}
  return typeof output.content === "string" ? output.content : "";
}

describe("a) mock model drives the bash tool through vercelWorkspace(), which runs it via bash -lc on the fake sandbox", () => {
  it("bash runs the script and the tool part settles output-available with the sandbox's output", async () => {
    const sandbox = new FakeVercelSandbox({
      runCommandImpl: async (call) => {
        // matches the glob tool suggestion in describe(): a real script would just run;
        // the fake instead pattern-matches on the *.ts glob to prove it saw the exact argv.
        expect(call.cmd).toBe("bash");
        expect(call.args[0]).toBe("-lc");
        await writeChunks(call.stdout, ["found-b\n", "last-is-c\n"]);
        return { exitCode: 0 };
      },
    });
    const ws = vercelWorkspace(sandbox);
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
    const session = createSession(defineAgent({ model }), { fs: ws, exec: ws });

    await drainStream(session.stream("run the control-flow script"));
    const toolCalls = toolCallItems(session.toJSON().messages);

    expect(toolCalls[0]).toMatchObject({ state: "output-available" });
    const output = stringOutput(toolCalls[0]?.output);
    expect(output).toContain("found-b");
    expect(output).toContain("last-is-c");
    expect(output).toContain("exit code: 0");
    expect(sandbox.calls[0]?.args).toEqual(["-lc", script]);
  });
});

describe("b) bypass proof: writing through the sandbox's fs directly (not the file tools) invalidates readState (§4.5a mode A rule 2)", () => {
  function assembleFileToolsSession(model: MockLanguageModelV4, sandbox: FakeVercelSandbox) {
    const ws = vercelWorkspace(sandbox);
    const readState = createSessionReadState();
    const derivedData = createDerivedDataCollector();
    const fileTools = createFileTools({
      readState,
      onFileChange: (changes) => changes.forEach((change) => derivedData.recordFileChange(change)),
    });
    const agent: AgentDefinition = defineAgent({ model, tools: fileTools });
    return { session: createSession(agent, { fs: ws, exec: ws, readState, derivedData }), ws };
  }

  it("read-file, then a bash-tool write (via runCommand touching sandbox.fs directly), then edit-file is rejected until re-read", async () => {
    const sandbox = new FakeVercelSandbox({
      files: { "/f.txt": "hello" },
      runCommandImpl: async (call) => {
        // simulates the script's real side effect: the sandbox process writes the file
        // for real, exactly like a real `bash -lc "echo -n changed-by-bash > /f.txt"` would —
        // going through sandbox.fs directly (not the injected NimboFS wrapper) proves this is
        // the bash bypass path, not a file-tool write.
        await sandbox.fs.writeFile("/vercel/sandbox/f.txt", "changed-by-bash");
        return { exitCode: 0 };
      },
    });
    const model = mockModel([
      toolCallStep("call_1", "read-file", { path: "/f.txt" }),
      toolCallStep("call_2", "bash", { command: "echo -n changed-by-bash > /f.txt" }),
      toolCallStep("call_3", "edit-file", { path: "/f.txt", old_string: "hello", new_string: "nope" }),
      toolCallStep("call_4", "read-file", { path: "/f.txt" }),
      toolCallStep("call_5", "edit-file", { path: "/f.txt", old_string: "changed-by-bash", new_string: "edited-after-reread" }),
      stopStep("done"),
    ]);
    const { session, ws } = assembleFileToolsSession(model, sandbox);

    await drainStream(session.stream("read, bash-write, try to edit (denied), reread, edit (allowed)"));
    const toolCalls = toolCallItems(session.toJSON().messages);

    expect(toolCalls[0]).toMatchObject({ state: "output-available" }); // read-file
    expect(toolCalls[1]).toMatchObject({ state: "output-available" }); // bash write, real fake sandbox side effect
    expect(stringOutput(toolCalls[1]?.output)).toContain("exit code: 0");

    expect(toolCalls[2]).toMatchObject({ state: "output-available" });
    expect(errorResultContent(toolCalls[2]?.output)).toContain("changed since it was last read");

    expect(toolCalls[3]).toMatchObject({ state: "output-available" }); // read-file again picks up bash's write
    expect(stringOutput(toolCalls[3]?.output)).toContain("changed-by-bash");

    expect(toolCalls[4]).toMatchObject({ state: "output-available" }); // edit-file now succeeds
    expect(new TextDecoder().decode(await ws.readFile("/f.txt"))).toBe("edited-after-reread");
  });
});
