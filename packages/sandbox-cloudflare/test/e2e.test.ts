/**
 * 端到端接线（docs/tech/sandbox.md §8.4 第 1 点"与 core 文件工具/bash 工具的 e2e"）：mock model
 * 驱动一个真实 `createSession({ workspace })`，`workspace` 是
 * `cloudflareWorkspace()`（客户端）← `fetchViaGateway`（进程内直连）← `createSandboxGateway()`
 * （网关）← `FakeCfSandbox`（沙盒）的完整四层链路——不 mock 任何 nimbo 内部模块。
 * 镜像 `@nimbo/just-bash` `test/e2e.test.ts` 的结构：
 *   a) mock model 用 `bash` 工具跑一条 echo 命令，工具部件完整回填预期输出；
 *   b) 旁路证明——bash 用一条相对路径的重定向写入（见 `src/index.ts` DESCRIBE 里
 *      "虚拟根锚定在沙盒默认 cwd" 的说明：bash 命令字符串本身不经过 NimboFS 的
 *      path 换算，必须用不带前导 "/" 的相对路径才能落在文件工具同一个锚点下）
 *      使该路径的 `readState` 失效（§4.5a 模式 A 规则 2），之后 `edit-file` 被拒
 *      直到重新 `read-file`。
 *
 * P13-5-2（docs/tech/single-ledger.md）迁移：断言从 `SessionEvent`/
 * `SessionItem`（`.status`）改为 `NimboChunk`/账本工具部件（`.state`）——同
 * `@nimbo/just-bash`/`@nimbo/sandbox-e2b` 的 `test/e2e.test.ts` 迁移，一比一
 * 照搬；辅助函数就地内联（不跨包 import 测试辅助，沿两包既有"各自 test 文件
 * 自包含"的风格）。
 */
import { createFileTools } from "@nimbo/virtual-fs";
import { createDerivedDataCollector, createSession, createSessionReadState, defineAgent } from "@nimbo/core";
import type { AgentDefinition, NimboChunk, NimboUIMessage } from "@nimbo/core";
import { isToolUIPart, simulateReadableStream } from "ai";
import type { ToolUIPart, UITools } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { cloudflareWorkspace } from "../src/index.js";
import { createSandboxGateway } from "../src/worker.js";
import { FakeCfSandbox, fetchViaGateway } from "./helpers.js";

const TOKEN = "test-token";
const BASE_URL = "http://gw.local";

function makeWorkspace(sandbox: FakeCfSandbox) {
  const gateway = createSandboxGateway({ token: TOKEN, getSandbox: async () => sandbox });
  return cloudflareWorkspace({ url: BASE_URL, token: TOKEN, fetch: fetchViaGateway(gateway) });
}

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

describe("a) mock model drives bash through the full client → gateway → FakeCfSandbox chain", () => {
  it("bash runs an echo command and the tool part settles output-available with the expected output", async () => {
    const workspace = makeWorkspace(new FakeCfSandbox());
    const model = mockModel([toolCallStep("call_1", "bash", { command: "echo hello-from-cloudflare" }), stopStep("done")]);
    const session = createSession(defineAgent({ model }), { workspace });

    await drainStream(session.stream("run echo through the cloudflare sandbox gateway"));
    const toolCalls = toolCallItems(session.toJSON().messages);

    expect(toolCalls[0]).toMatchObject({ state: "output-available" });
    const output = stringOutput(toolCalls[0]?.output);
    expect(output).toContain("hello-from-cloudflare");
    expect(output).toContain("exit code: 0");
  });
});

describe("b) bypass proof: bash's redirect write invalidates readState (§4.5a mode A rule 2)", () => {
  function assembleFileToolsSession(model: MockLanguageModelV4, workspace: ReturnType<typeof makeWorkspace>) {
    const readState = createSessionReadState();
    const derivedData = createDerivedDataCollector();
    const fileTools = createFileTools({
      readState,
      onFileChange: (changes) => changes.forEach((change) => derivedData.recordFileChange(change)),
    });
    const agent: AgentDefinition = defineAgent({ model, tools: fileTools });
    return createSession(agent, { workspace, readState, derivedData });
  }

  it("read-file, then a bash redirect write, then edit-file is rejected until the path is re-read — and re-reading unblocks it", async () => {
    const sandbox = new FakeCfSandbox({ files: { "f.txt": "hello" } });
    const workspace = makeWorkspace(sandbox);
    const model = mockModel([
      toolCallStep("call_1", "read-file", { path: "/f.txt" }),
      // 相对路径（无前导 "/"）——落在与 NimboFS "/" 同一个沙盒默认 cwd 锚点下，
      // 这正是"同源工作区"一致性在本适配器里成立的前提，见文件头注释。
      toolCallStep("call_2", "bash", { command: "echo -n changed-by-bash > f.txt" }),
      toolCallStep("call_3", "edit-file", { path: "/f.txt", old_string: "hello", new_string: "nope" }),
      toolCallStep("call_4", "read-file", { path: "/f.txt" }),
      toolCallStep("call_5", "edit-file", { path: "/f.txt", old_string: "changed-by-bash", new_string: "edited-after-reread" }),
      stopStep("done"),
    ]);
    const session = assembleFileToolsSession(model, workspace);

    await drainStream(session.stream("read, bash-write, try to edit (denied), reread, edit (allowed)"));
    const toolCalls = toolCallItems(session.toJSON().messages);

    expect(toolCalls[0]).toMatchObject({ state: "output-available" }); // read-file
    expect(toolCalls[1]).toMatchObject({ state: "output-available" }); // bash redirect write, real exec through the gateway, real exit 0
    expect(stringOutput(toolCalls[1]?.output)).toContain("exit code: 0");

    expect(toolCalls[2]).toMatchObject({ state: "output-available" });
    expect(errorResultContent(toolCalls[2]?.output)).toContain("changed since it was last read");

    expect(toolCalls[3]).toMatchObject({ state: "output-available" }); // read-file again picks up bash's write
    expect(stringOutput(toolCalls[3]?.output)).toContain("changed-by-bash");

    expect(toolCalls[4]).toMatchObject({ state: "output-available" }); // edit-file now succeeds
    expect(new TextDecoder().decode(await workspace.readFile("/f.txt"))).toBe("edited-after-reread");
  });
});
