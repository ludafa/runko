/**
 * 端到端两件套（同 `@nimbo/just-bash`/`@nimbo/core` 的 e2e 先例，一次覆盖
 * `vercelWorkspace()` 真的接进 `createSession` 的两条线）：
 *   a) mock model 调 `bash` 工具跑一条真实脚本，经 `runCommand({cmd:"bash",
 *      args:["-lc", ...]})` 落到 fake sandbox，tool_call 正常 completed；
 *   b) bash 旁路写（fake sandbox 的 fs.writeFile，不经 file 工具）使 readState
 *      失效（模式 A 规则 2），后续 edit_file 被拒绝直到重新 read_file。
 */
import { createFileTools } from "@nimbo/virtual-fs";
import { createDerivedDataCollector, createSession, createSessionReadState, defineAgent } from "@nimbo/core";
import type { AgentDefinition, SessionEvent, SessionItem } from "@nimbo/core";
import { simulateReadableStream } from "ai";
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

async function drainStream(gen: AsyncGenerator<SessionEvent, unknown>): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return events;
}

function isItemCompleted(event: SessionEvent): event is { type: "item.completed"; item: SessionItem } {
  return event.type === "item.completed";
}
function isToolCallItem(item: SessionItem): item is Extract<SessionItem, { type: "tool_call" }> {
  return item.type === "tool_call";
}
function stringOutput(output: Extract<SessionItem, { type: "tool_call" }>["output"]): string {
  return typeof output === "string" ? output : "";
}
function errorResultContent(output: Extract<SessionItem, { type: "tool_call" }>["output"]): string {
  if (typeof output !== "object" || output === null || Array.isArray(output)) return "";
  if (output.isError !== true) return "";
  return typeof output.content === "string" ? output.content : "";
}

describe("a) mock model drives the bash tool through vercelWorkspace(), which runs it via bash -lc on the fake sandbox", () => {
  it("bash runs the script and the tool_call completes with the sandbox's output", async () => {
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

    const events = await drainStream(session.stream("run the control-flow script"));
    const toolCalls = events.filter(isItemCompleted).map((e) => e.item).filter(isToolCallItem);

    expect(toolCalls[0]?.status).toBe("completed");
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

  it("read_file, then a bash-tool write (via runCommand touching sandbox.fs directly), then edit_file is rejected until re-read", async () => {
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
      toolCallStep("call_1", "read_file", { path: "/f.txt" }),
      toolCallStep("call_2", "bash", { command: "echo -n changed-by-bash > /f.txt" }),
      toolCallStep("call_3", "edit_file", { path: "/f.txt", old_string: "hello", new_string: "nope" }),
      toolCallStep("call_4", "read_file", { path: "/f.txt" }),
      toolCallStep("call_5", "edit_file", { path: "/f.txt", old_string: "changed-by-bash", new_string: "edited-after-reread" }),
      stopStep("done"),
    ]);
    const { session, ws } = assembleFileToolsSession(model, sandbox);

    const events = await drainStream(session.stream("read, bash-write, try to edit (denied), reread, edit (allowed)"));
    const toolCalls = events.filter(isItemCompleted).map((e) => e.item).filter(isToolCallItem);

    expect(toolCalls[0]?.status).toBe("completed"); // read_file
    expect(toolCalls[1]?.status).toBe("completed"); // bash write, real fake sandbox side effect
    expect(stringOutput(toolCalls[1]?.output)).toContain("exit code: 0");

    expect(toolCalls[2]?.status).toBe("completed");
    expect(errorResultContent(toolCalls[2]?.output)).toContain("changed since it was last read");

    expect(toolCalls[3]?.status).toBe("completed"); // read_file again picks up bash's write
    expect(stringOutput(toolCalls[3]?.output)).toContain("changed-by-bash");

    expect(toolCalls[4]?.status).toBe("completed"); // edit_file now succeeds
    expect(new TextDecoder().decode(await ws.readFile("/f.txt"))).toBe("edited-after-reread");
  });
});
