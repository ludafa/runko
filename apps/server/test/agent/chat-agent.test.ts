/**
 * `agent/chat-agent.ts`'s `buildSession` (docs/08-chat-agent-webapp.md §2.2c
 * （审批链）): coverage for the two pieces of surface this module adds on top
 * of a plain `@nimbo/sdk` `createSession` call —
 *
 *   1. `gateWorkspace` (private, not exported): every `NimboFS`/`NimboExec`
 *      method forwards to the original workspace unchanged, `defaultApproval`
 *      is forced to `"always"`, `describe` is included only when the
 *      original workspace has one, and `approvalMode: "off"` skips the
 *      wrapping entirely (the returned session's `fs` is the exact same
 *      object reference). Exercised indirectly through `buildSession(...)`'s
 *      returned `Session.fs` — `packages/core/src/session.ts` stores exactly
 *      `opts.fs ?? opts.workspace` as `session.fs`, no further wrapping, so
 *      `session.fs` *is* whatever `gateWorkspace` (or the identity passthrough)
 *      produced.
 *   2. `createAskUserTool` (private, not exported): registered into
 *      `agent.tools` only when `opts.onAskUser` is supplied, independent of
 *      `approvalMode`. Exercised by actually running a turn (`session.stream`)
 *      against a scripted `MockLanguageModelV4` that calls the `ask_user`
 *      tool, same technique as `test/routes/chat.test.ts`'s tool-call
 *      end-to-end tests.
 */
import type {
  ExecRequest,
  ExecResult,
  NimboExec,
  NimboFS,
  SessionEvent,
  SessionItem,
  TurnResult,
} from '@nimbo/core';
import { MemoryFS } from '@nimbo/sdk';
import type { Mock } from 'vitest';
import { describe, expect, it, vi } from 'vitest';

import { buildSession } from '../../src/agent/chat-agent.js';
import type {
  AskUserOutcome,
  RequestUserAnswerInput,
} from '../../src/agent/turn-runner.js';
import { stopOnlyModel, toolCallThenStopModel } from '../helpers/mock-model.js';

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
}

async function createSpyWorkspace(
  opts: { withDescribe?: boolean } = {},
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

/** Drains a session's `stream(text)` to completion, same shape as `turn-runner.ts`'s own `driveTurn` loop. */
async function drainStream(
  session: BuiltSession,
  text: string,
): Promise<{ events: SessionEvent[]; result: TurnResult }> {
  const events: SessionEvent[] = [];
  const gen = session.stream(text);
  let step = await gen.next();
  while (!step.done) {
    events.push(step.value);
    step = await gen.next();
  }
  return { events, result: step.value };
}

function isToolCallItem(
  item: SessionItem,
): item is Extract<SessionItem, { type: 'tool_call' }> {
  return item.type === 'tool_call';
}

/** Every `item.completed` tool_call item across a drained turn, in order. */
function completedToolCallItems(
  events: SessionEvent[],
): Array<Extract<SessionItem, { type: 'tool_call' }>> {
  const result: Array<Extract<SessionItem, { type: 'tool_call' }>> = [];
  for (const event of events) {
    if (event.type === 'item.completed' && isToolCallItem(event.item)) {
      result.push(event.item);
    }
  }
  return result;
}

describe('agent/chat-agent: buildSession — gateWorkspace (approvalMode !== "off")', () => {
  it('forwards every NimboFS/NimboExec method call to the original workspace, preserving arguments and return values, and forces defaultApproval to "always"', async () => {
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

    expect(session.fs.defaultApproval).toBe('always');
  });

  it('omits describe entirely from the wrapped fs when the original workspace has none', async () => {
    const spy = await createSpyWorkspace({ withDescribe: false });
    const session = await buildSession({
      ...baseBuildOptions(spy.workspace),
      model: stopOnlyModel('ok'),
    });
    expect('describe' in session.fs).toBe(false);
  });

  it('gates by default — approvalMode omitted (defaults to "dangerous") wraps the workspace into a different object', async () => {
    const spy = await createSpyWorkspace();
    const session = await buildSession({
      ...baseBuildOptions(spy.workspace),
      model: stopOnlyModel('ok'),
    });
    expect(session.fs).not.toBe(spy.workspace);
    expect(session.fs.defaultApproval).toBe('always');
  });

  it('gates explicitly under approvalMode "dangerous", same as the default', async () => {
    const spy = await createSpyWorkspace();
    const session = await buildSession({
      ...baseBuildOptions(spy.workspace),
      model: stopOnlyModel('ok'),
      approvalMode: 'dangerous',
    });
    expect(session.fs).not.toBe(spy.workspace);
    expect(session.fs.defaultApproval).toBe('always');
  });

  it('gates under approvalMode "all", same as "dangerous"', async () => {
    const spy = await createSpyWorkspace();
    const session = await buildSession({
      ...baseBuildOptions(spy.workspace),
      model: stopOnlyModel('ok'),
      approvalMode: 'all',
    });
    expect(session.fs).not.toBe(spy.workspace);
    expect(session.fs.defaultApproval).toBe('always');
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

describe('agent/chat-agent: buildSession — ask_user tool registration', () => {
  it('omits ask_user from the tool set when onAskUser is not supplied — a model call to it fails as an unknown tool', async () => {
    const spy = await createSpyWorkspace();
    const session = await buildSession({
      ...baseBuildOptions(spy.workspace),
      model: toolCallThenStopModel(
        'ask_user',
        { question: 'want fries?' },
        'call_1',
        'done',
      ),
    });

    const { events } = await drainStream(session, 'hi');
    const askUserCall = completedToolCallItems(events).find(
      (item) => item.toolName === 'ask_user',
    );
    expect(askUserCall?.status).toBe('failed');
    expect(askUserCall?.output).toContain('Unknown tool "ask_user"');
  });

  it('registers ask_user when onAskUser is supplied; an "answered" outcome returns the answer verbatim with tool_call status "completed"', async () => {
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
        'ask_user',
        { question: 'favorite color?' },
        'call_1',
        'thanks',
      ),
      onAskUser,
    });

    const { events } = await drainStream(session, 'hi');
    const askUserCall = completedToolCallItems(events).find(
      (item) => item.toolName === 'ask_user',
    );
    expect(askUserCall?.status).toBe('completed');
    expect(askUserCall?.output).toBe('blue');

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
        'ask_user',
        { question: 'pick a color', options: ['red', 'blue'] },
        'call_1',
        'thanks',
      ),
      onAskUser,
    });

    await drainStream(session, 'hi');
    expect(calls[0]?.options).toEqual(['red', 'blue']);
  });

  it('a "timeout" outcome resolves the tool call to the fixed English notice, still with status "completed" (not failed/denied)', async () => {
    const spy = await createSpyWorkspace();
    const onAskUser = (): Promise<AskUserOutcome> =>
      Promise.resolve({ outcome: 'timeout' });
    const session = await buildSession({
      ...baseBuildOptions(spy.workspace),
      model: toolCallThenStopModel(
        'ask_user',
        { question: 'still there?' },
        'call_1',
        'ok',
      ),
      onAskUser,
    });

    const { events } = await drainStream(session, 'hi');
    const askUserCall = completedToolCallItems(events).find(
      (item) => item.toolName === 'ask_user',
    );
    expect(askUserCall?.status).toBe('completed');
    expect(askUserCall?.output).toBe(
      'The user did not respond within the time limit. Proceed with your best judgment, or ask again later.',
    );
  });

  it('registers ask_user independent of approvalMode — still present (and answerable) under approvalMode "off"', async () => {
    const spy = await createSpyWorkspace();
    const onAskUser = (): Promise<AskUserOutcome> =>
      Promise.resolve({ outcome: 'answered', answer: 'ok' });
    const session = await buildSession({
      ...baseBuildOptions(spy.workspace),
      model: toolCallThenStopModel(
        'ask_user',
        { question: 'continue?' },
        'call_1',
        'done',
      ),
      onAskUser,
      approvalMode: 'off',
    });

    // Confirms the two options are independent: 'off' still skips gateWorkspace...
    expect(session.fs).toBe(spy.workspace);

    // ...while ask_user is registered and answerable regardless.
    const { events } = await drainStream(session, 'hi');
    const askUserCall = completedToolCallItems(events).find(
      (item) => item.toolName === 'ask_user',
    );
    expect(askUserCall?.status).toBe('completed');
    expect(askUserCall?.output).toBe('ok');
  });
});
