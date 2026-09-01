/**
 * `agent/chat-agent.ts` 剩下的那两个纯函数。
 *
 * 建 `Session` 已经归 `@nimbo/agent`（见 `agent/runtime.ts`），所以这里不再需要真跑一轮：
 *
 * 1. **`gateWorkspace`**——把 bash 卡进[审批链](../../../../docs/terms.md)：每个
 *    `NimboFS`/`NimboExec` 方法原样转发、`defaultApproval` 被强制成 `"review"`、
 *    **可选能力方法（`describe`/`searchFiles`/`searchContent`）必须跟着转发**（2026-07-16
 *    的线上事故：只转发七个必选方法，原生搜索被静默剥掉、grep 永远走 JS 慢路径）。
 * 2. **`buildInstructions`**——系统提示词里那几件必须钉住的事实（工作分支、只读纪律、
 *    联网搜索那行只在真注册了工具时才出现）。
 *
 * `ask-user` 的注册与行为现在归框架，覆盖在 `packages/agent/test/human.test.ts`；
 * `web-search` 的条件注册归 `agent/runtime.ts`，覆盖在 `test/agent/runtime.test.ts`。
 */
import type { ExecRequest, ExecResult, NimboExec, NimboFS } from '@nimbo/core';
import { MemoryFS } from '@nimbo/sdk';
import type { Mock } from 'vitest';
import { describe, expect, it, vi } from 'vitest';

import {
  buildInstructions,
  gateWorkspace,
} from '../../src/agent/chat-agent.js';

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

function createSpyWorkspace(
  opts: { withDescribe?: boolean; withNativeSearch?: boolean } = {},
): SpyWorkspace {
  const fs = new MemoryFS();
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

describe('gateWorkspace', () => {
  it('把 defaultApproval 强制成 "review"——这才是 bash 每次都进审批链的原因', () => {
    const spy = createSpyWorkspace();
    expect(gateWorkspace(spy.workspace).defaultApproval).toBe('review');
  });

  it('每个必选方法原样转发，实参与返回值都不变', async () => {
    const spy = createSpyWorkspace();
    const gated = gateWorkspace(spy.workspace);

    await gated.writeFile('/a.txt', 'hello');
    expect(await new TextDecoder().decode(await gated.readFile('/a.txt'))).toBe(
      'hello',
    );
    await gated.mkdir('/dir');
    expect(await gated.readdir('/')).toEqual(await spy.workspace.readdir('/'));
    expect((await gated.stat('/a.txt')).size).toBeGreaterThan(0);
    expect(await gated.glob('**/*.txt')).toEqual(['/a.txt']);
    await gated.rm('/a.txt');
    const result = await gated.exec({
      command: 'echo hi',
      signal: new AbortController().signal,
    });
    expect(result.stdout).toBe('ok');

    expect(spy.writeFile).toHaveBeenCalledWith('/a.txt', 'hello');
    expect(spy.readFile).toHaveBeenCalledWith('/a.txt');
    expect(spy.mkdir).toHaveBeenCalledWith('/dir');
    expect(spy.rm).toHaveBeenCalled();
    expect(spy.exec).toHaveBeenCalled();
  });

  it('转发可选的原生搜索方法——不转发就等于把 grep/glob 打回 JS 逐文件慢路径', async () => {
    const spy = createSpyWorkspace({ withNativeSearch: true });
    const gated = gateWorkspace(spy.workspace);

    expect(gated.searchFiles).toBeDefined();
    expect(gated.searchContent).toBeDefined();
    await gated.searchFiles?.({ pattern: '**/*.ts', limit: 10 });
    await gated.searchContent?.({
      pattern: 'foo',
      scope: '**/*.ts',
      mode: 'content',
      maxFiles: 100,
      maxLines: 500,
    });
    expect(spy.searchFiles).toHaveBeenCalledTimes(1);
    expect(spy.searchContent).toHaveBeenCalledTimes(1);
  });

  it('原工作区没有的可选方法，包装后也不该凭空长出来（内置工具据此判断「有没有原生搜索」）', () => {
    const gated = gateWorkspace(createSpyWorkspace().workspace);
    expect(gated.searchFiles).toBeUndefined();
    expect(gated.searchContent).toBeUndefined();
    expect(gated.describe).toBeUndefined();
  });

  it('有 describe 就转发', () => {
    const spy = createSpyWorkspace({ withDescribe: true });
    expect(gateWorkspace(spy.workspace).describe?.()).toBe('test env');
    expect(spy.describe).toHaveBeenCalledTimes(1);
  });

  it('返回的是一个新对象——`approvalMode: "off"` 那条路（`runtime.ts` 里判）才是原样透传', () => {
    const spy = createSpyWorkspace();
    expect(gateWorkspace(spy.workspace)).not.toBe(spy.workspace);
  });
});

describe('buildInstructions', () => {
  const base = {
    repoOwner: 'acme',
    repoName: 'demo',
    defaultBranch: 'main',
    branchName: 'nimbo/chat-abc',
  };

  it('把仓库、默认分支、工作分支都烤进提示词——模型不必去猜', () => {
    const text = buildInstructions({ ...base, hasWebSearch: false });
    expect(text).toContain('acme/demo');
    expect(text).toContain('main');
    expect(text).toContain('nimbo/chat-abc');
  });

  it('没注册 web-search 时不提它——否则指令会让模型去调一个不存在的工具', () => {
    expect(buildInstructions({ ...base, hasWebSearch: false })).not.toContain(
      'web-search',
    );
    expect(buildInstructions({ ...base, hasWebSearch: true })).toContain(
      'web-search',
    );
  });

  it('写着「用户没明确要求就只读不写」——多轮对话里绝大多数轮次只是提问', () => {
    expect(buildInstructions({ ...base, hasWebSearch: false })).toContain(
      '只读、不要写',
    );
  });
});
