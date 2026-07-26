/**
 * `agent/web-search.ts`（docs/tech/web-search.md，验收要点见
 * docs/plans/web-search.md）：`web-search` 工具的单测。
 *
 * **零网络零凭证**——`fetch` 经 `CreateWebSearchToolOptions.fetchImpl` 注入假
 * 实现，超时经 `timeoutMs` 注入毫秒级值，所以「超时」这条分支是真跑出来的，
 * 不是 mock 出来的。请求体/请求头都在假 `fetch` 的调用记录里逐字段核对
 * （包括三个刻意不用的 Exa 过时参数）。
 */
import type { JsonValue, NimboFS, ToolContext } from '@nimbo/core';
import { MemoryFS } from '@nimbo/sdk';
import type { Mock } from 'vitest';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  createWebSearchTool,
  createWebSearchToolFromEnv,
  resolveWebSearchConfig,
} from '../../src/agent/web-search.js';

const API_KEY = 'exa-test-key';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function toolContext(abortSignal?: AbortSignal): ToolContext {
  const fs: NimboFS = new MemoryFS();
  return {
    fs,
    abortSignal: abortSignal ?? new AbortController().signal,
    callId: 'call_1',
    session: { id: 'sess_1', turn: 1 },
    getSkill: () => {
      throw new Error('getSkill is not used by web-search');
    },
    update: () => {},
  };
}

/** 假 `fetch`：固定返回一个 `Response`。 */
function fetchReturning(body: string, init?: ResponseInit): Mock<typeof fetch> {
  return vi.fn<typeof fetch>(() => Promise.resolve(new Response(body, init)));
}

function fetchReturningJson(payload: unknown): Mock<typeof fetch> {
  return fetchReturning(JSON.stringify(payload), { status: 200 });
}

/** Exa 请求体的形状断言用 schema——用 zod 解析而不是 `JSON.parse(...) as T`（全局 CLAUDE.md 的类型纪律）。 */
const requestBodySchema = z.object({
  query: z.string(),
  type: z.string(),
  numResults: z.number(),
  contents: z.object({
    text: z.object({ maxCharacters: z.number() }),
    highlights: z.boolean(),
  }),
  category: z.string().optional(),
  includeDomains: z.array(z.string()).optional(),
});

function requestOf(fetchImpl: Mock<typeof fetch>): {
  url: string;
  method: string | undefined;
  apiKeyHeader: string | null;
  contentTypeHeader: string | null;
  body: z.infer<typeof requestBodySchema>;
  rawBodyKeys: string[];
} {
  const call = fetchImpl.mock.calls[0];
  if (call === undefined) throw new Error('fetch was never called');
  const [input, init] = call;
  if (typeof input !== 'string') throw new Error('expected a string URL');
  const raw = init?.body;
  if (typeof raw !== 'string') throw new Error('expected a string body');
  const headers = new Headers(init?.headers);
  const parsedRaw: unknown = JSON.parse(raw);
  return {
    url: input,
    method: init?.method,
    apiKeyHeader: headers.get('x-api-key'),
    contentTypeHeader: headers.get('content-type'),
    body: requestBodySchema.parse(parsedRaw),
    rawBodyKeys: Object.keys(
      z.record(z.string(), z.unknown()).parse(parsedRaw),
    ),
  };
}

function runTool(
  fetchImpl: Mock<typeof fetch>,
  input: JsonValue,
  extra: { timeoutMs?: number; abortSignal?: AbortSignal } = {},
): Promise<string> {
  const tool = createWebSearchTool({
    apiKey: API_KEY,
    fetchImpl,
    ...(extra.timeoutMs !== undefined ? { timeoutMs: extra.timeoutMs } : {}),
  });
  return Promise.resolve(
    tool.execute(input, toolContext(extra.abortSignal)),
  ).then((output) => {
    if (typeof output !== 'string') {
      throw new Error('web-search must return a string');
    }
    return output;
  });
}

const ONE_RESULT = {
  results: [
    {
      title: 'Test Context | Vitest',
      url: 'https://vitest.dev/guide/test-context',
      publishedDate: '2026-03-11',
      author: 'Vitest Team',
      text: 'Vitest provides a test context object...',
      highlights: ['Fixtures are defined with test.extend'],
    },
  ],
};

// ---------------------------------------------------------------------------
// 请求形状
// ---------------------------------------------------------------------------

describe('agent/web-search: 请求形状', () => {
  it('POST 到 Exa /search，带 x-api-key 与 JSON content-type', async () => {
    const fetchImpl = fetchReturningJson(ONE_RESULT);
    await runTool(fetchImpl, { query: 'vitest fixtures' });

    const request = requestOf(fetchImpl);
    expect(request.url).toBe('https://api.exa.ai/search');
    expect(request.method).toBe('POST');
    expect(request.apiKeyHeader).toBe(API_KEY);
    expect(request.contentTypeHeader).toBe('application/json');
  });

  it('body 命中约定形状：type=auto、numResults 默认 5、contents 同时要正文与 highlights', async () => {
    const fetchImpl = fetchReturningJson(ONE_RESULT);
    await runTool(fetchImpl, { query: 'vitest fixtures' });

    expect(requestOf(fetchImpl).body).toEqual({
      query: 'vitest fixtures',
      type: 'auto',
      numResults: 5,
      contents: {
        text: { maxCharacters: 1200 },
        highlights: true,
      },
    });
  });

  it('不发送 Exa 已废弃的三个参数（useAutoprompt / livecrawl / highlights 的 numSentences）', async () => {
    const fetchImpl = fetchReturningJson(ONE_RESULT);
    await runTool(fetchImpl, { query: 'x' });

    const { rawBodyKeys, body } = requestOf(fetchImpl);
    expect(rawBodyKeys).not.toContain('useAutoprompt');
    expect(rawBodyKeys).not.toContain('livecrawl');
    // highlights 传布尔 true，不是带 numSentences/highlightsPerUrl 的对象。
    expect(body.contents.highlights).toBe(true);
  });

  it('模型给的 numResults 原样带上', async () => {
    const fetchImpl = fetchReturningJson(ONE_RESULT);
    await runTool(fetchImpl, { query: 'x', numResults: 3 });
    expect(requestOf(fetchImpl).body.numResults).toBe(3);
  });

  it('category / includeDomains 只有模型给了才进 body（缺省不发这两个键）', async () => {
    const without = fetchReturningJson(ONE_RESULT);
    await runTool(without, { query: 'x' });
    expect(requestOf(without).rawBodyKeys).not.toContain('category');
    expect(requestOf(without).rawBodyKeys).not.toContain('includeDomains');

    const withBoth = fetchReturningJson(ONE_RESULT);
    await runTool(withBoth, {
      query: 'x',
      category: 'news',
      includeDomains: ['vitest.dev'],
    });
    expect(requestOf(withBoth).body.category).toBe('news');
    expect(requestOf(withBoth).body.includeDomains).toEqual(['vitest.dev']);
  });
});

// ---------------------------------------------------------------------------
// 输入 schema（模型给的参数由 zod 挡）
// ---------------------------------------------------------------------------

describe('agent/web-search: 输入 schema', () => {
  const tool = createWebSearchTool({ apiKey: API_KEY });

  it('接受只有 query 的最小输入', () => {
    expect(tool.inputSchema.safeParse({ query: 'hello' }).success).toBe(true);
  });

  it('拒绝空 query', () => {
    expect(tool.inputSchema.safeParse({ query: '' }).success).toBe(false);
    expect(tool.inputSchema.safeParse({}).success).toBe(false);
  });

  it('numResults 越界或非整数一律拒绝（1..10）', () => {
    for (const numResults of [0, 11, 2.5, -1]) {
      expect(
        tool.inputSchema.safeParse({ query: 'x', numResults }).success,
      ).toBe(false);
    }
    expect(
      tool.inputSchema.safeParse({ query: 'x', numResults: 10 }).success,
    ).toBe(true);
  });

  it('category 只认 Exa 的六个枚举值', () => {
    expect(
      tool.inputSchema.safeParse({ query: 'x', category: 'news' }).success,
    ).toBe(true);
    expect(
      tool.inputSchema.safeParse({ query: 'x', category: 'blog' }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 输出格式化
// ---------------------------------------------------------------------------

describe('agent/web-search: 输出格式化', () => {
  it('完整字段 → 序号+标题 / 网址 / 日期·作者 / highlights 摘录', async () => {
    const output = await runTool(fetchReturningJson(ONE_RESULT), {
      query: 'vitest fixtures',
    });

    expect(output).toBe(
      [
        'Found 1 result(s) for "vitest fixtures":',
        '',
        '[1] Test Context | Vitest',
        '    https://vitest.dev/guide/test-context',
        '    Published: 2026-03-11 · Author: Vitest Team',
        '    - Fixtures are defined with test.extend',
      ].join('\n'),
    );
  });

  it('highlights 优先于正文，且最多取 3 段', async () => {
    const output = await runTool(
      fetchReturningJson({
        results: [
          {
            title: 'T',
            url: 'https://e.com',
            text: 'FULL BODY TEXT',
            highlights: ['h1', 'h2', 'h3', 'h4'],
          },
        ],
      }),
      { query: 'q' },
    );

    expect(output).toContain('    - h1');
    expect(output).toContain('    - h3');
    expect(output).not.toContain('h4');
    expect(output).not.toContain('FULL BODY TEXT');
  });

  it('没有 highlights 时退回正文，并压缩空白 + 截断到 500 字符', async () => {
    const long = 'a'.repeat(600);
    const output = await runTool(
      fetchReturningJson({
        results: [
          {
            title: 'T',
            url: 'https://e.com',
            text: `line1\n\n  line2`,
            highlights: [],
          },
          { title: 'L', url: 'https://l.com', text: long },
        ],
      }),
      { query: 'q' },
    );

    expect(output).toContain('    line1 line2');
    expect(output).toContain(`    ${'a'.repeat(500)}…`);
    expect(output).not.toContain('a'.repeat(501));
  });

  it('缺字段不打印 undefined：无标题写 (untitled)，无网址/日期/作者的行整行省略', async () => {
    const output = await runTool(
      fetchReturningJson({
        results: [{ text: 'just some text' }],
      }),
      { query: 'q' },
    );

    expect(output).toBe(
      [
        'Found 1 result(s) for "q":',
        '',
        '[1] (untitled)',
        '    just some text',
      ].join('\n'),
    );
  });

  it('null 字段（Exa 的 publishedDate/author 常为 null）不炸', async () => {
    const output = await runTool(
      fetchReturningJson({
        results: [
          {
            title: 'T',
            url: 'https://e.com',
            publishedDate: null,
            author: null,
            text: null,
            highlights: null,
          },
        ],
      }),
      { query: 'q' },
    );

    expect(output).toBe(
      ['Found 1 result(s) for "q":', '', '[1] T', '    https://e.com'].join(
        '\n',
      ),
    );
  });

  it('零结果返回一句可读文案，不抛错也不返回空串', async () => {
    const output = await runTool(fetchReturningJson({ results: [] }), {
      query: 'nothing at all',
    });
    expect(output).toBe('No results found for "nothing at all".');
  });

  it('results 字段整个缺席时按零结果处理', async () => {
    const output = await runTool(fetchReturningJson({ requestId: 'r1' }), {
      query: 'q',
    });
    expect(output).toBe('No results found for "q".');
  });

  it('多条结果按序编号，之间空一行', async () => {
    const output = await runTool(
      fetchReturningJson({
        results: [
          { title: 'A', url: 'https://a.com' },
          { title: 'B', url: 'https://b.com' },
        ],
      }),
      { query: 'q' },
    );

    expect(output).toBe(
      [
        'Found 2 result(s) for "q":',
        '',
        '[1] A',
        '    https://a.com',
        '',
        '[2] B',
        '    https://b.com',
      ].join('\n'),
    );
  });
});

// ---------------------------------------------------------------------------
// 错误分档
// ---------------------------------------------------------------------------

describe('agent/web-search: 错误分档', () => {
  it('401/403 → 指向 EXA_API_KEY 的文案，且不回显 key 本身', async () => {
    for (const status of [401, 403]) {
      const promise = runTool(fetchReturning('nope', { status }), {
        query: 'q',
      });
      await expect(promise).rejects.toThrow(
        `Exa rejected the request (HTTP ${status}) — the server's EXA_API_KEY is missing or invalid.`,
      );
      await expect(promise).rejects.not.toThrow(API_KEY);
    }
  });

  it('429 → 限流文案', async () => {
    await expect(
      runTool(fetchReturning('slow down', { status: 429 }), { query: 'q' }),
    ).rejects.toThrow(
      'Exa rate-limited this request (HTTP 429) — wait a moment before searching again.',
    );
  });

  it('其他非 2xx → 带响应体前缀（压缩空白、截到 200 字符）', async () => {
    await expect(
      runTool(fetchReturning('upstream  \n exploded', { status: 500 }), {
        query: 'q',
      }),
    ).rejects.toThrow('Exa search failed (HTTP 500): upstream exploded');

    const long = 'x'.repeat(400);
    const promise = runTool(fetchReturning(long, { status: 502 }), {
      query: 'q',
    });
    await expect(promise).rejects.toThrow(`HTTP 502): ${'x'.repeat(200)}`);
    await expect(promise).rejects.not.toThrow('x'.repeat(201));
  });

  it('非 2xx 且响应体为空 → 只报状态码', async () => {
    await expect(
      runTool(fetchReturning('', { status: 503 }), { query: 'q' }),
    ).rejects.toThrow('Exa search failed (HTTP 503).');
  });

  it('200 但响应不是 JSON → unexpected response shape', async () => {
    await expect(
      runTool(fetchReturning('<html>oops</html>', { status: 200 }), {
        query: 'q',
      }),
    ).rejects.toThrow('Exa returned an unexpected response shape.');
  });

  it('200 但 results 形状不符（不是数组）→ unexpected response shape', async () => {
    await expect(
      runTool(fetchReturningJson({ results: 'nope' }), { query: 'q' }),
    ).rejects.toThrow('Exa returned an unexpected response shape.');
  });

  it('超时 → 专门的超时文案（用注入的毫秒级 timeoutMs 真跑出这条分支）', async () => {
    const hanging = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );

    await expect(
      runTool(hanging, { query: 'q' }, { timeoutMs: 10 }),
    ).rejects.toThrow('Exa search timed out after');
  });

  it('本轮被停止 → 原样上抛 abort 错误，不伪装成搜索失败/超时', async () => {
    const controller = new AbortController();
    controller.abort();
    const aborting = vi.fn<typeof fetch>(() =>
      Promise.reject(
        new DOMException('The operation was aborted', 'AbortError'),
      ),
    );

    const promise = runTool(
      aborting,
      { query: 'q' },
      { abortSignal: controller.signal },
    );
    await expect(promise).rejects.toThrow('The operation was aborted');
    await expect(promise).rejects.not.toThrow('Exa search failed');
    await expect(promise).rejects.not.toThrow('timed out');
  });

  it('网络层异常（非 abort、非 HTTP 错误）→ 带原始消息的通用失败文案', async () => {
    const failing = vi.fn<typeof fetch>(() =>
      Promise.reject(new Error('ECONNREFUSED')),
    );
    await expect(runTool(failing, { query: 'q' })).rejects.toThrow(
      'Exa search failed: ECONNREFUSED',
    );
  });
});

// ---------------------------------------------------------------------------
// 工具声明 & env 装配
// ---------------------------------------------------------------------------

describe('agent/web-search: 工具声明', () => {
  it('声明为 readOnly（同批全只读时 loop 可并行结算），且不挂 approval', () => {
    const tool = createWebSearchTool({ apiKey: API_KEY });
    expect(tool.readOnly).toBe(true);
    expect(tool.approval).toBeUndefined();
  });

  it('description 里不含任何凭证', () => {
    const tool = createWebSearchTool({ apiKey: API_KEY });
    expect(tool.description).not.toContain(API_KEY);
    expect(tool.description.length).toBeGreaterThan(0);
  });
});

describe('agent/web-search: EXA_API_KEY 解析', () => {
  it('有值 → 解析出 config', () => {
    expect(resolveWebSearchConfig({ EXA_API_KEY: 'k' })).toEqual({
      apiKey: 'k',
    });
  });

  it('两端空白被 trim 掉', () => {
    expect(resolveWebSearchConfig({ EXA_API_KEY: '  k  ' })).toEqual({
      apiKey: 'k',
    });
  });

  it('缺席 / 空串 / 纯空白 一律视为未配置', () => {
    expect(resolveWebSearchConfig({})).toBeUndefined();
    expect(resolveWebSearchConfig({ EXA_API_KEY: '' })).toBeUndefined();
    expect(resolveWebSearchConfig({ EXA_API_KEY: '   ' })).toBeUndefined();
  });

  it('createWebSearchToolFromEnv：没配 key 返回 undefined（= 这个工具根本不注册）', () => {
    expect(createWebSearchToolFromEnv({})).toBeUndefined();
    expect(createWebSearchToolFromEnv({ EXA_API_KEY: 'k' })).toBeDefined();
  });
});
