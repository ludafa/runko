/**
 * `agent/chat-agent.ts`'s `buildSession` (docs/tech/chat-webapp.md §2.2c
 * （审批链）, docs/tech/single-ledger.md §5 单-3/§6): coverage for the
 * two pieces of surface this module adds on top of a plain `@nimbo/sdk`
 * `createSession` call —
 *
 *   1. `gateWorkspace` (private, not exported): every `NimboFS`/`NimboExec`
 *      method forwards to the original workspace unchanged, `defaultApproval`
 *      is forced to `"review"` (docs/tech/single-ledger.md §6.1's three-value `ApprovalOutcome`
 *      — the retired boolean-flavored `"always"` string is gone), `describe`
 *      is included only when the original workspace has one, and
 *      `approvalMode: "off"` skips the wrapping entirely (the returned
 *      session's `fs` is the exact same object reference). Exercised
 *      indirectly through `buildSession(...)`'s returned `Session.fs` —
 *      `packages/core/src/session.ts` stores exactly `opts.fs ?? opts.workspace`
 *      as `session.fs`, no further wrapping, so `session.fs` *is* whatever
 *      `gateWorkspace` (or the identity passthrough) produced.
 *   2. `createAskUserTool` (private, not exported): registered into
 *      `agent.tools` only when `opts.onAskUser` is supplied, independent of
 *      `approvalMode`. Exercised by actually running a turn (`session.stream`)
 *      against a scripted `MockLanguageModelV4` that calls the `ask-user`
 *      tool — now read back as a `tool-ask-user` part on the finished
 *      `NimboUIMessage` (`session.toJSON().messages`), not a retired
 *      `SessionItem.tool_call`, same technique `test/routes/chat.test.ts`'s
 *      tool-call end-to-end tests use.
 */
import type {
  ExecRequest,
  ExecResult,
  NimboExec,
  NimboFS,
  NimboUIMessage,
} from '@nimbo/core';
import { MemoryFS } from '@nimbo/sdk';
import type { ToolUIPart, UITools } from 'ai';
import type { Mock } from 'vitest';
import { describe, expect, it, vi } from 'vitest';

import { buildSession } from '../../src/agent/chat-agent.js';
import type {
  AskUserOutcome,
  RequestUserAnswerInput,
} from '../../src/agent/turn-runner.js';
import { stopOnlyModel, toolCallThenStopModel } from '../helpers/mock-model.js';
import { allToolParts, drainTurn } from '../helpers/nimbo-chunks.js';

const FRONTEND_DESIGN_SKILL_STUB = `---
description: Make one focused, non-generic visual/interaction improvement to an existing web UI without rewriting it.
---
# frontend-design (test stub)
`;

// ---------------------------------------------------------------------------
// A spied workspace (NimboFS & NimboExec) — a real MemoryFS underneath (so
// Skill.fromFS(...) and real file operations still work), with every method
// wrapped in a `vi.fn` so tests can assert forwarding without inspecting
// gateWorkspace directly (it's private to chat-agent.ts).
// ---------------------------------------------------------------------------

interface SpyWorkspace {
  workspace: NimboFS & NimboExec;
  readFile: Mock<NimboFS['readFile']>;
  writeFile: Mock<NimboFS['writeFile']>;
  rm: Mock<NimboFS['rm']>;
  mkdir: Mock<NimboFS['mkdir']>;
  readdir: Mock<NimboFS['readdir']>;
  stat: Mock<NimboFS['stat']>;
  glob: Mock<NimboFS['glob']>;
  exec: Mock<NimboExec['exec']>;
  describe?: Mock<() => string>;
  searchFiles?: Mock<NonNullable<NimboFS['searchFiles']>>;
  searchContent?: Mock<NonNullable<NimboFS['searchContent']>>;
}

async function createSpyWorkspace(
  opts: { withDescribe?: boolean; withNativeSearch?: boolean } = {},
): Promise<SpyWorkspace> {
  const fs = new MemoryFS();
  await fs.writeFile(
    '/.agents/skills/frontend-design/SKILL.md',
    FRONTEND_DESIGN_SKILL_STUB,
  );

  const readFile = vi.fn(fs.readFile.bind(fs));
  const writeFile = vi.fn(fs.writeFile.bind(fs));
  const rm = vi.fn(fs.rm.bind(fs));
  const mkdir = vi.fn(fs.mkdir.bind(fs));
  const readdir = vi.fn(fs.readdir.bind(fs));
  const stat = vi.fn(fs.stat.bind(fs));
  const glob = vi.fn(fs.glob.bind(fs));
  const execResult: ExecResult = {
    exitCode: 0,
    stdout: 'ok',
    stderr: '',
    durationMs: 1,
  };
  const exec = vi.fn((_req: ExecRequest) => Promise.resolve(execResult));
  const describeSpy =
    opts.withDescribe === true ? vi.fn(() => 'test env') : undefined;
  // 原生搜索可选方法（docs/tech/builtin-tools.md §3.7/§3.8）：MemoryFS 本身刻意
  // 不实现，这里按需挂假实现——用来锁定 gateWorkspace 必须转发可选能力方法
  // （2026-07-16 的回归：只转发七个必选方法导致 chat 应用里原生搜索永远失效）。
  const searchFilesSpy =
    opts.withNativeSearch === true ?
      vi.fn<NonNullable<NimboFS['searchFiles']>>(() =>
        Promise.resolve({ paths: ['/hit.ts'], total: 1 }),
      )
    : undefined;
  const searchContentSpy =
    opts.withNativeSearch === true ?
      vi.fn<NonNullable<NimboFS['searchContent']>>(() =>
        Promise.resolve({ groups: [], totalFiles: 0, lineCapped: false }),
      )
    : undefined;

  const workspace: NimboFS & NimboExec = {
    readFile,
    writeFile,
    rm,
    mkdir,
    readdir,
    stat,
    glob,
    exec,
    ...(describeSpy !== undefined ? { describe: describeSpy } : {}),
    ...(searchFilesSpy !== undefined ? { searchFiles: searchFilesSpy } : {}),
    ...(searchContentSpy !== undefined ?
      { searchContent: searchContentSpy }
    : {}),
  };

  return {
    workspace,
    readFile,
    writeFile,
    rm,
    mkdir,
    readdir,
    stat,
    glob,
    exec,
    ...(describeSpy !== undefined ? { describe: describeSpy } : {}),
    ...(searchFilesSpy !== undefined ? { searchFiles: searchFilesSpy } : {}),
    ...(searchContentSpy !== undefined ?
      { searchContent: searchContentSpy }
    : {}),
  };
}

interface BaseBuildOptions {
  workspace: NimboFS & NimboExec;
  repoOwner: string;
  repoName: string;
  defaultBranch: string;
  branchName: string;
}

function baseBuildOptions(workspace: NimboFS & NimboExec): BaseBuildOptions {
  return {
    workspace,
    repoOwner: 'acme',
    repoName: 'demo',
    defaultBranch: 'main',
    branchName: 'nimbo/chat-sess-1',
  };
}

type BuiltSession = Awaited<ReturnType<typeof buildSession>>;

/** Drains a session's `stream(text)` to completion and hands back the finished ledger (`session.toJSON().messages`) — the new "what happened this turn" source of truth (docs/tech/single-ledger.md §5 单-3), replacing the retired `SessionEvent`/`SessionItem` stream inspection. */
async function drainStream(
  session: BuiltSession,
  text: string,
): Promise<{ messages: NimboUIMessage[] }> {
  await drainTurn(session.stream(text));
  return { messages: session.toJSON().messages };
}

/** The tool part (`tool-<name>`) for a given tool name, across a finished turn's messages — at most one per `toolCallId` (docs/tech/single-ledger.md §4.1 实现教训: only the settled state is ever recorded). */
function findToolPart(
  messages: NimboUIMessage[],
  toolName: string,
): ToolUIPart<UITools> | undefined {
  return allToolParts(messages).find(
    (part) => part.type === `tool-${toolName}`,
  );
}

describe('agent/chat-agent: buildSession — gateWorkspace (approvalMode !== "off")', () => {
  it('forwards every NimboFS/NimboExec method call to the original workspace, preserving arguments and return values, and forces defaultApproval to "review"', async () => {
    const spy = await createSpyWorkspace({ withDescribe: true });
    const session = await buildSession({
      ...baseBuildOptions(spy.workspace),
      model: stopOnlyModel('ok'),
    });

    // Skill.fromFS(...) already made some calls (readFile/readdir) while
    // loading the skill during buildSession — clear those before asserting
    // our own calls below.
    spy.readFile.mockClear();
    spy.writeFile.mockClear();
    spy.rm.mockClear();
    spy.mkdir.mockClear();
    spy.readdir.mockClear();
    spy.stat.mockClear();
    spy.glob.mockClear();
    spy.exec.mockClear();
    spy.describe?.mockClear();

    await session.fs.writeFile('/a.txt', 'hello');
    expect(spy.writeFile).toHaveBeenCalledExactlyOnceWith('/a.txt', 'hello');
    spy.writeFile.mockClear();

    await session.fs.readFile('/a.txt');
    expect(spy.readFile).toHaveBeenCalledExactlyOnceWith('/a.txt');

    await session.fs.writeFile('/b.txt', 'hi');
    expect(spy.writeFile).toHaveBeenCalledExactlyOnceWith('/b.txt', 'hi');

    await session.fs.rm('/b.txt', { recursive: true });
    expect(spy.rm).toHaveBeenCalledExactlyOnceWith('/b.txt', {
      recursive: true,
    });

    await session.fs.mkdir('/dir');
    expect(spy.mkdir).toHaveBeenCalledExactlyOnceWith('/dir');

    await session.fs.readdir('/');
    expect(spy.readdir).toHaveBeenCalledExactlyOnceWith('/');

    await session.fs.stat('/a.txt');
    expect(spy.stat).toHaveBeenCalledExactlyOnceWith('/a.txt');

    await session.fs.glob('**/*.txt');
    expect(spy.glob).toHaveBeenCalledExactlyOnceWith('**/*.txt');

    const execRequest: ExecRequest = {
      command: 'echo hi',
      signal: new AbortController().signal,
    };
    const execOutcome = await session.fs.exec(execRequest);
    expect(spy.exec).toHaveBeenCalledExactlyOnceWith(execRequest, undefined);
    expect(execOutcome).toEqual({
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      durationMs: 1,
    });

    expect(session.fs.describe?.()).toBe('test env');
    expect(spy.describe).toHaveBeenCalledTimes(1);

    expect(session.fs.defaultApproval).toBe('review');
  });

  it('omits describe entirely from the wrapped fs when the original workspace has none', async () => {
    const spy = await createSpyWorkspace({ withDescribe: false });
    const session = await buildSession({
      ...baseBuildOptions(spy.workspace),
      model: stopOnlyModel('ok'),
    });
    expect('describe' in session.fs).toBe(false);
  });

  it('forwards the optional native-search methods (searchFiles/searchContent) when the workspace implements them — the grep/glob fast path must survive the gate', async () => {
    const spy = await createSpyWorkspace({ withNativeSearch: true });
    const session = await buildSession({
      ...baseBuildOptions(spy.workspace),
      model: stopOnlyModel('ok'),
    });

    const filesResult = await session.fs.searchFiles?.({
      pattern: '/**/*.ts',
      limit: 100,
    });
    expect(spy.searchFiles).toHaveBeenCalledExactlyOnceWith({
      pattern: '/**/*.ts',
      limit: 100,
    });
    expect(filesResult).toEqual({ paths: ['/hit.ts'], total: 1 });

    const contentResult = await session.fs.searchContent?.({
      pattern: 'TODO',
      scope: '/**',
      mode: 'files',
      maxFiles: 100,
      maxLines: 500,
    });
    expect(spy.searchContent).toHaveBeenCalledExactlyOnceWith({
      pattern: 'TODO',
      scope: '/**',
      mode: 'files',
      maxFiles: 100,
      maxLines: 500,
    });
    expect(contentResult).toEqual({
      groups: [],
      totalFiles: 0,
      lineCapped: false,
    });
  });

  it('omits searchFiles/searchContent entirely when the workspace lacks them — the built-in tools must keep seeing "no native search" and fall back', async () => {
    const spy = await createSpyWorkspace({ withNativeSearch: false });
    const session = await buildSession({
      ...baseBuildOptions(spy.workspace),
      model: stopOnlyModel('ok'),
    });
    expect('searchFiles' in session.fs).toBe(false);
    expect('searchContent' in session.fs).toBe(false);
  });

  it('gates by default — approvalMode omitted (defaults to "dangerous") wraps the workspace into a different object', async () => {
    const spy = await createSpyWorkspace();
    const session = await buildSession({
      ...baseBuildOptions(spy.workspace),
      model: stopOnlyModel('ok'),
    });
    expect(session.fs).not.toBe(spy.workspace);
    expect(session.fs.defaultApproval).toBe('review');
  });

  it('gates explicitly under approvalMode "dangerous", same as the default', async () => {
    const spy = await createSpyWorkspace();
    const session = await buildSession({
      ...baseBuildOptions(spy.workspace),
      model: stopOnlyModel('ok'),
      approvalMode: 'dangerous',
    });
    expect(session.fs).not.toBe(spy.workspace);
    expect(session.fs.defaultApproval).toBe('review');
  });

  it('gates under approvalMode "all", same as "dangerous"', async () => {
    const spy = await createSpyWorkspace();
    const session = await buildSession({
      ...baseBuildOptions(spy.workspace),
      model: stopOnlyModel('ok'),
      approvalMode: 'all',
    });
    expect(session.fs).not.toBe(spy.workspace);
    expect(session.fs.defaultApproval).toBe('review');
  });
});

describe('agent/chat-agent: buildSession — approvalMode "off"', () => {
  it('passes the original workspace object straight through — zero wrapping', async () => {
    const spy = await createSpyWorkspace();
    const session = await buildSession({
      ...baseBuildOptions(spy.workspace),
      model: stopOnlyModel('ok'),
      approvalMode: 'off',
    });
    expect(session.fs).toBe(spy.workspace);
  });
});

describe('agent/chat-agent: buildSession — ask-user tool registration', () => {
  it('omits ask-user from the tool set when onAskUser is not supplied — a model call to it fails as an unavailable tool (tool-ask-user part settles output-error)', async () => {
    const spy = await createSpyWorkspace();
    const session = await buildSession({
      ...baseBuildOptions(spy.workspace),
      model: toolCallThenStopModel(
        'ask-user',
        { question: 'want fries?' },
        'call_1',
        'done',
      ),
    });

    const { messages } = await drainStream(session, 'hi');
    const askUserPart = findToolPart(messages, 'ask-user');
    expect(askUserPart?.state).toBe('output-error');
    // The AI SDK's own tool-call streaming classifies a call to a tool name
    // absent from the declared tool set as a "dynamic, invalid" call before
    // it ever reaches `@nimbo/core`'s `loop.ts`'s own "Unknown tool" branch
    // (`settleToolCall`) — so the error text a client actually sees is the
    // SDK's own "unavailable tool" wording, not nimbo's. See this ticket's
    // report for a note on `settleToolCall`'s "Unknown tool" branch looking
    // unreachable through the normal `streamText` tool-calling pipeline.
    expect(
      askUserPart?.state === 'output-error' ? askUserPart.errorText : undefined,
    ).toContain("unavailable tool 'ask-user'");
  });

  it('registers ask-user when onAskUser is supplied; an "answered" outcome returns the answer verbatim, settling output-available', async () => {
    const spy = await createSpyWorkspace();
    const calls: RequestUserAnswerInput[] = [];
    const onAskUser = (
      req: RequestUserAnswerInput,
    ): Promise<AskUserOutcome> => {
      calls.push(req);
      return Promise.resolve({ outcome: 'answered', answer: 'blue' });
    };
    const session = await buildSession({
      ...baseBuildOptions(spy.workspace),
      model: toolCallThenStopModel(
        'ask-user',
        { question: 'favorite color?' },
        'call_1',
        'thanks',
      ),
      onAskUser,
    });

    const { messages } = await drainStream(session, 'hi');
    const askUserPart = findToolPart(messages, 'ask-user');
    expect(askUserPart?.state).toBe('output-available');
    expect(
      askUserPart?.state === 'output-available' ?
        askUserPart.output
      : undefined,
    ).toBe('blue');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.callId).toBe('call_1');
    expect(calls[0]?.question).toBe('favorite color?');
    // No `options` supplied by the model — must arrive as undefined, not [].
    expect(calls[0]?.options).toBeUndefined();
  });

  it('passes options through to onAskUser verbatim when the model supplies them', async () => {
    const spy = await createSpyWorkspace();
    const calls: RequestUserAnswerInput[] = [];
    const onAskUser = (
      req: RequestUserAnswerInput,
    ): Promise<AskUserOutcome> => {
      calls.push(req);
      return Promise.resolve({ outcome: 'answered', answer: 'red' });
    };
    const session = await buildSession({
      ...baseBuildOptions(spy.workspace),
      model: toolCallThenStopModel(
        'ask-user',
        { question: 'pick a color', options: ['red', 'blue'] },
        'call_1',
        'thanks',
      ),
      onAskUser,
    });

    await drainStream(session, 'hi');
    expect(calls[0]?.options).toEqual(['red', 'blue']);
  });

  it('a "timeout" outcome resolves the tool call to the fixed English notice, still settling output-available (not output-error/output-denied)', async () => {
    const spy = await createSpyWorkspace();
    const onAskUser = (): Promise<AskUserOutcome> =>
      Promise.resolve({ outcome: 'timeout' });
    const session = await buildSession({
      ...baseBuildOptions(spy.workspace),
      model: toolCallThenStopModel(
        'ask-user',
        { question: 'still there?' },
        'call_1',
        'ok',
      ),
      onAskUser,
    });

    const { messages } = await drainStream(session, 'hi');
    const askUserPart = findToolPart(messages, 'ask-user');
    expect(askUserPart?.state).toBe('output-available');
    expect(
      askUserPart?.state === 'output-available' ?
        askUserPart.output
      : undefined,
    ).toBe(
      'The user did not respond within the time limit. Proceed with your best judgment, or ask again later.',
    );
  });

  it('registers ask-user independent of approvalMode — still present (and answerable) under approvalMode "off"', async () => {
    const spy = await createSpyWorkspace();
    const onAskUser = (): Promise<AskUserOutcome> =>
      Promise.resolve({ outcome: 'answered', answer: 'ok' });
    const session = await buildSession({
      ...baseBuildOptions(spy.workspace),
      model: toolCallThenStopModel(
        'ask-user',
        { question: 'continue?' },
        'call_1',
        'done',
      ),
      onAskUser,
      approvalMode: 'off',
    });

    // Confirms the two options are independent: 'off' still skips gateWorkspace...
    expect(session.fs).toBe(spy.workspace);

    // ...while ask-user is registered and answerable regardless.
    const { messages } = await drainStream(session, 'hi');
    const askUserPart = findToolPart(messages, 'ask-user');
    expect(askUserPart?.state).toBe('output-available');
    expect(
      askUserPart?.state === 'output-available' ?
        askUserPart.output
      : undefined,
    ).toBe('ok');
  });
});
