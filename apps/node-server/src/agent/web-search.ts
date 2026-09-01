/**
 * `web-search`（docs/tech/web-search.md）：chat 应用注册给 agent 的[联网搜索]
 * 工具，后端是 Exa 的 `POST /search`。
 *
 * 为什么在 apps 而不在 `@nimbo/core` 的内置工具里（docs/tech/web-search.md §1）：
 * core 的内置工具有一条隐含契约——零凭证、零网络、宿主什么都不配也能用；
 * 这个工具要第三方 API key、按次计费、走公网，塞进 core 等于让每个 SDK 用户
 * 被动继承一个外部依赖和一份账单面。形态与 `ask-user`（chat-agent.ts）同构：
 * 应用侧 `defineTool` + 条件注册，core 零改动。
 *
 * 为什么不装 `exa-js`（§2）：只用一个端点，SDK 带来的是一个依赖而不是省下的
 * 代码；且它的 TS 类型只是编译期声明，字段缺失/改名在运行时照样穿透——真正
 * 挡得住线上形状漂移的是这里的 zod `safeParse`。
 *
 * 对模型暴露的工具名是 `web-search` 而非 `exa-search`：工具名会进账本
 * （部件类型 `tool-web-search`）和模型上下文，与供应商解耦，将来换家不必改
 * 历史数据与指令。配置项则照实叫 `EXA_API_KEY`——那是运维要认的东西。
 */
import type { Tool, ToolContext } from '@nimbo/sdk';
import { defineTool } from '@nimbo/sdk';
import { z } from 'zod';

const EXA_SEARCH_ENDPOINT = 'https://api.exa.ai/search';

/** 模型没指定条数时取几条——够用又不撑爆上下文（docs/features/web-search.md §6 成功标准 4）。 */
const DEFAULT_NUM_RESULTS = 5;
const MAX_NUM_RESULTS = 10;

/** 让 Exa 在服务端就把正文截短：省一次往返，也省上下文。 */
const CONTENTS_TEXT_MAX_CHARACTERS = 1200;
/** 没有 highlights 时，退回正文摘录的截断长度。 */
const TEXT_EXCERPT_MAX_CHARACTERS = 500;
/** 每条结果最多带几段 highlights。 */
const MAX_HIGHLIGHTS_PER_RESULT = 3;

const REQUEST_TIMEOUT_MS = 20_000;
/** 非 2xx 时回填给模型的响应体前缀长度（够定位问题，又不至于把一整页 HTML 灌进上下文）。 */
const ERROR_BODY_PREVIEW_CHARACTERS = 200;

const UNEXPECTED_SHAPE_MESSAGE = 'Exa returned an unexpected response shape.';

/** Exa 的内容类别过滤（docs/tech/web-search.md §3）。 */
const EXA_CATEGORIES = [
  'company',
  'people',
  'research paper',
  'news',
  'personal site',
  'financial report',
] as const;

const inputSchema = z.object({
  query: z.string().min(1),
  numResults: z.number().int().min(1).max(MAX_NUM_RESULTS).optional(),
  category: z.enum(EXA_CATEGORIES).optional(),
  includeDomains: z.array(z.string().min(1)).min(1).max(20).optional(),
});

type WebSearchInput = z.infer<typeof inputSchema>;

/**
 * 响应校验：字段一律 `.nullish()`，只认这一版真正要用的几个，其余交给 zod
 * 默认的 strip 丢掉。原则是「多给的字段不报错、少给的字段不炸」——第三方
 * 响应形状随时会变，这层的职责是保证不管它给什么，工具都能给模型一段确定
 * 形状的文本。
 */
const exaResultSchema = z.object({
  title: z.string().nullish(),
  url: z.string().nullish(),
  publishedDate: z.string().nullish(),
  author: z.string().nullish(),
  text: z.string().nullish(),
  highlights: z.array(z.string()).nullish(),
});

const exaSearchResponseSchema = z.object({
  results: z.array(exaResultSchema).nullish(),
});

type ExaResult = z.infer<typeof exaResultSchema>;

/**
 * 请求体（docs/tech/web-search.md §2）。三个已知的过时写法刻意不用（Exa 官方
 * "Common Mistakes"）：`useAutoprompt` 已废弃、`highlights.numSentences`/
 * `highlightsPerUrl` 已废弃（传 `true` 即可）、`livecrawl: "always"` 已由
 * `contents.maxAgeHours` 取代。
 */
interface ExaSearchRequestBody {
  query: string;
  type: 'auto';
  numResults: number;
  contents: {
    text: { maxCharacters: number };
    highlights: true;
  };
  category?: (typeof EXA_CATEGORIES)[number];
  includeDomains?: string[];
}

export interface WebSearchConfig {
  apiKey: string;
}

export interface CreateWebSearchToolOptions extends WebSearchConfig {
  /** 注入点：测试用假 `fetch`（零网络零凭证）。缺省用全局 `fetch`。 */
  fetchImpl?: typeof fetch;
  /** 覆盖端点（测试/自建代理）。缺省 `https://api.exa.ai/search`。 */
  endpoint?: string;
  /** 单次请求超时（毫秒），缺省 20s。可注入是为了让测试能真触发超时分支，不必等 20 秒。 */
  timeoutMs?: number;
}

/**
 * `EXA_API_KEY` 的懒解析（docs/tech/web-search.md §5）：在 `buildSession()` 里
 * 每轮调一次，不在模块加载期读——同 `model.ts` 的 `resolveModel()` 纪律，保证
 * `generate:openapi`/`typecheck` 这类只 import 不跑的场景不会因为没配凭证就炸。
 * 未配（缺席/空串/纯空白）返回 `undefined` = 这个工具根本不注册。
 */
export function resolveWebSearchConfig(
  env: NodeJS.ProcessEnv = process.env,
): WebSearchConfig | undefined {
  const apiKey = env.EXA_API_KEY?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    return undefined;
  }
  return { apiKey };
}

/** `resolveWebSearchConfig` + `createWebSearchTool` 的便利组合：没配 key 就返回 `undefined`（`chat-agent.ts` 据此决定注不注册）。 */
export function createWebSearchToolFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Tool | undefined {
  const config = resolveWebSearchConfig(env);
  return config === undefined ? undefined : createWebSearchTool(config);
}

export function createWebSearchTool(opts: CreateWebSearchToolOptions): Tool {
  return defineTool({
    description:
      'Search the public web for current information. Use this whenever the answer depends on facts you might ' +
      "not know or that may have changed since your training data: a library's current API or version, an " +
      'unfamiliar error message, recent events, pricing, documentation. Write a long, specific natural-language ' +
      'query rather than a few keywords — the engine behind this is semantic, so "how do I define reusable ' +
      'fixtures in vitest 4" beats "vitest fixtures". Returns up to `numResults` results, each with title, URL, ' +
      'publish date and an excerpt; cite the URLs in your answer. It does not fetch full page contents — if you ' +
      'need to read one of the pages in full, curl it with the bash tool.',
    inputSchema,
    // 纯读：不写工作区、不产生任何派生数据，所以同批全只读时 loop 可并行结算。
    // 注意 readOnly 说的是「对工作区无副作用」，不是「对世界无副作用」——它确实
    // 会花钱，那件事由产品文档告知用户，不由这个标志表达。
    readOnly: true,
    // 不设 approval：联网只读检索既不改仓库也不用用户的 GitHub 权限，与
    // `git push`/`rm -rf` 那类外发动作不是一个量级（docs/tech/web-search.md §3）。
    execute: (input, ctx) => runSearch(opts, input, ctx),
  });
}

async function runSearch(
  opts: CreateWebSearchToolOptions,
  input: WebSearchInput,
  ctx: ToolContext,
): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const endpoint = opts.endpoint ?? EXA_SEARCH_ENDPOINT;
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  // 超时与「本轮被停止」共用一个信号；事后靠 ctx.abortSignal.aborted 区分二者。
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([ctx.abortSignal, timeoutSignal]);

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': opts.apiKey,
      },
      body: JSON.stringify(buildRequestBody(input)),
      signal,
    });
  } catch (error) {
    // 用户停止本轮：原样上抛，让 loop 按 aborted 收尾，不伪装成搜索失败。
    if (ctx.abortSignal.aborted) {
      throw error;
    }
    if (timeoutSignal.aborted) {
      throw new Error(`Exa search timed out after ${timeoutMs / 1000}s.`, {
        cause: error,
      });
    }
    throw new Error(`Exa search failed: ${describeError(error)}`, {
      cause: error,
    });
  }

  if (!response.ok) {
    throw await httpError(response);
  }

  // `unknown` 在这里不可避免——`Response.json()` 就是序列化边界，形状由下一行的
  // zod `safeParse` 收窄，不外泄（全局 CLAUDE.md 的类型纪律：隔离在最小范围）。
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(UNEXPECTED_SHAPE_MESSAGE);
  }
  const parsed = exaSearchResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(UNEXPECTED_SHAPE_MESSAGE);
  }

  const results = parsed.data.results ?? [];
  return formatResults(input.query, results);
}

function buildRequestBody(input: WebSearchInput): ExaSearchRequestBody {
  return {
    query: input.query,
    type: 'auto',
    numResults: input.numResults ?? DEFAULT_NUM_RESULTS,
    contents: {
      text: { maxCharacters: CONTENTS_TEXT_MAX_CHARACTERS },
      highlights: true,
    },
    ...(input.category !== undefined ? { category: input.category } : {}),
    ...(input.includeDomains !== undefined ?
      { includeDomains: input.includeDomains }
    : {}),
  };
}

/**
 * 非 2xx 的分档文案（docs/tech/web-search.md §6）——全部收敛成 `Error`，因为
 * errorText 会随 `tool-output-error` 一并进模型上下文，模型看得到原因就能自救
 * （换关键词，或直说查不到）。
 */
async function httpError(response: Response): Promise<Error> {
  if (response.status === 401 || response.status === 403) {
    return new Error(
      `Exa rejected the request (HTTP ${response.status}) — the server's EXA_API_KEY is missing or invalid.`,
    );
  }
  if (response.status === 429) {
    return new Error(
      'Exa rate-limited this request (HTTP 429) — wait a moment before searching again.',
    );
  }
  const preview = await readBodyPreview(response);
  return new Error(
    preview.length === 0 ?
      `Exa search failed (HTTP ${response.status}).`
    : `Exa search failed (HTTP ${response.status}): ${preview}`,
  );
}

async function readBodyPreview(response: Response): Promise<string> {
  try {
    const body = await response.text();
    return collapseWhitespace(body).slice(0, ERROR_BODY_PREVIEW_CHARACTERS);
  } catch {
    return '';
  }
}

function formatResults(query: string, results: ExaResult[]): string {
  if (results.length === 0) {
    return `No results found for "${query}".`;
  }
  const blocks = results.map((result, index) =>
    formatResult(result, index + 1),
  );
  return `Found ${results.length} result(s) for "${query}":\n\n${blocks.join('\n\n')}`;
}

/**
 * 一条结果四行：序号+标题 / 网址 / 发表日期·作者（有才写）/ 摘录。缺字段的行
 * 整行省略而不是打印 "undefined"——残缺响应是常态（Exa 的 publishedDate/author
 * 本就可能为 null）。
 */
function formatResult(result: ExaResult, position: number): string {
  const lines = [
    `[${position}] ${collapseWhitespace(result.title ?? '') || '(untitled)'}`,
  ];

  const url = result.url?.trim();
  if (url !== undefined && url.length > 0) {
    lines.push(`    ${url}`);
  }

  const meta: string[] = [];
  const published = result.publishedDate?.trim();
  if (published !== undefined && published.length > 0) {
    meta.push(`Published: ${published}`);
  }
  const author = collapseWhitespace(result.author ?? '');
  if (author.length > 0) {
    meta.push(`Author: ${author}`);
  }
  if (meta.length > 0) {
    lines.push(`    ${meta.join(' · ')}`);
  }

  lines.push(...excerptLines(result));
  return lines.join('\n');
}

/** 摘录优先取 highlights（最相关的几段），没有才退回正文截断。 */
function excerptLines(result: ExaResult): string[] {
  const highlights = (result.highlights ?? [])
    .map(collapseWhitespace)
    .filter((highlight) => highlight.length > 0)
    .slice(0, MAX_HIGHLIGHTS_PER_RESULT);
  if (highlights.length > 0) {
    return highlights.map((highlight) => `    - ${highlight}`);
  }

  const text = collapseWhitespace(result.text ?? '');
  if (text.length === 0) {
    return [];
  }
  return [
    `    ${
      text.length > TEXT_EXCERPT_MAX_CHARACTERS ?
        `${text.slice(0, TEXT_EXCERPT_MAX_CHARACTERS)}…`
      : text
    }`,
  ];
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** `catch` 子句里从 `unknown` 安全窄化出可读消息——同款受控例外见 `@nimbo/core` 的 `loop.ts`。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
