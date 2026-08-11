/**
 * nimbo 服务端跑在 Cloudflare Worker 里 —— 一份完整的参考实现（示例，非产品代码）。
 *
 * 这个 Worker 同时扮演**两个角色**，它们共用同一套 `getSandbox` 接线、同一个
 * Durable Object binding、同一份 Dockerfile：
 *
 *   ① 服务端自己驱动沙盒（进程内直连）—— `GET /sandbox-check`、`POST /agent`
 *      nimbo 会话就跑在这个 Worker 里，客户端与网关同进程，那层 HTTP 不过网络。
 *
 *   ② 对外提供 BYO 网关端点 —— `ALL /gateway/*`
 *      供**任意 Node 机器**上的 `cloudflareWorkspace({ url, token })` 连进来，
 *      这正是 examples/src/11-sandbox-cloudflare.ts 真机段需要的那个网关。
 *
 * 为什么这两件事能合成一个 Worker：
 *
 * `@nimbo/sandbox-cloudflare` 原本是**网关形态**——nimbo 的前提是「agent 跑在任意
 * 电脑上」，而 CF Sandbox 只能从 Worker 内部经 Durable Object binding 访问，所以
 * 需要自部署一个 HTTP 网关把两边接起来（docs/host/sandbox/tech.md §6）。角色 ② 就是那个
 * 网关。而角色 ① 的服务端自己就在 Worker 里，客户端与网关同进程——于是同一个
 * `createSandboxGateway` 实例既可以经 HTTP 服务外部客户端，也可以被本进程直接
 * `fetch()` 调用，把 TCP 那一跳短路掉。
 *
 * 关键接线（照搬 examples/src/11-sandbox-cloudflare.ts 已验证的进程内直连打法，
 * 只把它的 fake sandbox 换成真的 `getSandbox`）：
 *
 *   createSandboxGateway({ getSandbox: id => getSandbox(env.Sandbox, id) })
 *        ↑ 网关（./worker 入口，零 CF import，有契约测试）
 *   cloudflareWorkspace({ fetch: req => gateway.fetch(req) })
 *        ↑ 客户端（. 入口，纯 fetch），注入的 fetch 直接把请求交给同进程网关
 *
 * 这样**一行新的适配器代码都不用写**——复用的是两端都已有测试覆盖的现成实现。
 * 代价是进程内路径每次文件操作仍走一遍 JSON+base64 编解码；要省掉这层可以再抽一个
 * 直连适配器，本示例刻意不抽，以保持「与真机网关路径完全同构」。
 *
 * 明确不在范围内（见 docs/app/cloudflare-worker-server/plan.md）：
 *   - D1 替换 better-sqlite3、better-auth 移植、chat 的 conversations/messages 路由
 *   - CF 沙盒 idle 睡眠丢文件系统 与 chat「未提交改动原样还原」的语义落差
 */
import { createDeepSeek } from '@ai-sdk/deepseek';
import { getSandbox, Sandbox } from '@cloudflare/sandbox';
import { cloudflareWorkspace } from '@nimbo/sandbox-cloudflare';
import { createSandboxGateway } from '@nimbo/sandbox-cloudflare/worker';
import type { CfSandboxLike } from '@nimbo/sandbox-cloudflare/worker';
import { createSession, defineAgent } from '@nimbo/sdk';
import type { LanguageModel } from 'ai';
import { Hono } from 'hono';
import { z } from 'zod';

// Sandbox 这个 Durable Object 类必须从 Worker 入口模块导出，wrangler.jsonc 里的
// durable_objects binding 才找得到它。
export { Sandbox };

interface Env {
  // 结构上取自 getSandbox 自身的入参类型——避免为一个绑定去依赖 workers-types 的
  // 具名类型，也不用写类型断言。
  Sandbox: Parameters<typeof getSandbox>[0];
  /** 角色 ②（对外网关）的 bearer token。未配置时 /gateway/* 直接 503，不退化成弱口令。 */
  NIMBO_GATEWAY_TOKEN?: string;
  DEEPSEEK_API_BASE_URL?: string;
  DEEPSEEK_API_TOKEN?: string;
  NIMBO_MODEL?: string;
}

/**
 * 角色 ① 里客户端与网关之间的握手值。这里**不是**一道安全边界：两端在同一个
 * Worker 进程里，这个值永远不出进程、也从不上网。真正的边界是本 Worker 对外暴露的
 * 路由（其中 `/gateway/*` 用的是 `NIMBO_GATEWAY_TOKEN` 那个真 secret）。
 * 之所以还留着它，只是因为网关的协议契约要求带上（AUTH_HEADER），照给即可。
 */
const INTERNAL_TOKEN = 'in-process-not-a-secret';

/** 角色 ① 固定复用同一个沙盒实例，方便观察跨请求的文件留存行为。 */
const SERVER_SANDBOX_ID = 'nimbo-cloudflare-worker-server';

/** 对外网关端点的挂载前缀；转交给网关前会被剥掉（见 `/gateway/*` 路由）。 */
const GATEWAY_PREFIX = '/gateway';

/**
 * 把 `exec` 的 `signal` 剥掉再交给真实沙盒。
 *
 * 为什么需要：网关（`worker.ts` 的 `handleExec`）会把 HTTP 请求的 `request.signal`
 * 转发给 `sandbox.exec()`，而这里的 `sandbox` 是 `getSandbox()` 拿到的 Durable
 * Object stub——**AbortSignal 跨不过 DO RPC 边界**。CF 官方文档明说：
 *
 *   "AbortSignal objects do not persist across Durable Object RPC boundaries."
 *   "the controller must be constructed within the Durable Object itself."
 *   （developers.cloudflare.com/agents/communication-channels/chat/chat-agents）
 *
 * 不带这层包装时，`/sandbox-check` 的 exec 必然报
 * `sandbox exec failed: AbortSignal serialization is not enabled.`（已实测）。
 * 文件方法不受影响，因为它们只传字符串。
 *
 * 这是 `@nimbo/sandbox-cloudflare` 网关的一个真实缺陷。它之所以长期没被发现，是因为
 * 网关的契约测试用的是 fake sandbox（普通对象、无 RPC 边界，传 signal 自然没事），
 * 而真机路径此前从未真正跑过。**注意这层包装对两个角色都必要**——角色 ② 的外部
 * 客户端走的是同一条 `getSandbox` 接线，同样会撞上 DO RPC 边界。
 *
 * 这里刻意只在示例侧绕行、不改产品代码：包该怎么修（是彻底不转发，还是做成可选项）
 * 会改动 `protocol.test.ts` 里那条已固化的契约，属于独立决定。详见
 * docs/app/cloudflare-worker-server/plan.md「发现的缺陷」。
 *
 * 代价：客户端 abort 不再能中断沙盒内正在跑的命令，命令会一直跑到 `timeout` 为止。
 * 客户端侧的取消语义不受影响——`cloudflareWorkspace` 自己的 `raceAbort` 仍然保证
 * 及时返回、绝不永久挂起。
 */
function stripAbortSignal(real: CfSandboxLike): CfSandboxLike {
  return {
    exec: (command, options) =>
      real.exec(command, {
        cwd: options?.cwd,
        timeout: options?.timeout,
        stream: options?.stream,
        onOutput: options?.onOutput,
        // 刻意不传 signal —— 见上方说明
      }),
    readFile: (path, options) => real.readFile(path, options),
    writeFile: (path, content, options) => real.writeFile(path, content, options),
    mkdir: (path, options) => real.mkdir(path, options),
    deleteFile: (path) => real.deleteFile(path),
    listFiles: (path, options) => real.listFiles(path, options),
  };
}

/**
 * 唯一的沙盒接线，两个角色共用。
 *
 * 注意它必须在**请求作用域内**构造：`getSandbox` 依赖每请求的 `env` binding，拿不到
 * 模块级单例——这正是现有 Node 版服务端（`apps/node-server` 里模块级实例化
 * `sandboxManager`）上 Workers 时必须改造的点之一。
 */
function gatewayFor(env: Env, token: string) {
  return createSandboxGateway({
    token,
    getSandbox: (id) => stripAbortSignal(getSandbox(env.Sandbox, id)),
  });
}

/** 角色 ①：把「真实 CF Sandbox」包装成 nimbo 的 `NimboFS & NimboExec` 视图。 */
function workspaceFor(env: Env, sandboxId: string) {
  const gateway = gatewayFor(env, INTERNAL_TOKEN);

  return cloudflareWorkspace({
    url: 'http://sandbox.internal',
    token: INTERNAL_TOKEN,
    sandboxId,
    // 同进程直连：请求不经网络，直接交给上面的网关处理。
    fetch: async (input, init) => gateway.fetch(new Request(input, init)),
  });
}

/** 未配模型时返回 undefined（与 examples/shared/model.ts 的纪律一致：缺配置是「还没配」，不是崩溃）。 */
function resolveModel(env: Env): LanguageModel | undefined {
  const baseURL = env.DEEPSEEK_API_BASE_URL?.trim();
  const apiKey = env.DEEPSEEK_API_TOKEN?.trim();
  if (
    baseURL === undefined ||
    baseURL.length === 0 ||
    apiKey === undefined ||
    apiKey.length === 0
  ) {
    return undefined;
  }
  const deepseek = createDeepSeek({ baseURL, apiKey });
  return deepseek(env.NIMBO_MODEL?.trim() || 'deepseek-chat');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) =>
  c.json({
    name: 'nimbo-cloudflare-worker-server',
    what: 'nimbo 服务端跑在 CF Worker 里：进程内直连驱动真实 CF Sandbox，同时对外提供 BYO 网关端点',
    routes: {
      'GET  /health': '存活检查（不碰沙盒）',
      'GET  /sandbox-check':
        '探针：exec + 文件往返，证明 Worker 能驱动真沙盒（不需要模型）',
      'GET  /debug/exec':
        '调试：?cmd=<command> 直接在沙盒里跑一条命令（不需要模型）',
      'POST /agent':
        '跑一次真 agent 会话，body: {"prompt":"..."}（需要 DeepSeek 配置）',
      'ALL  /gateway/*':
        'BYO 网关端点：供任意 Node 机器上的 cloudflareWorkspace({url,token}) 连入（需要 NIMBO_GATEWAY_TOKEN）',
    },
  }),
);

app.get('/health', (c) => c.json({ ok: true }));

/**
 * 角色 ②：对外的 BYO 网关端点。
 *
 * 客户端 `cloudflareWorkspace({ url })` 会把 `ENDPOINTS`（`/fs/read`、`/exec` …）
 * 直接拼在 `url` 后面，而网关是按 **pathname 精确匹配**这些常量的。所以这里把
 * `/gateway` 前缀剥掉再转交——客户端配 `url: "https://<worker>/gateway"` 即可。
 *
 * 挂前缀而不是挂根路径，是为了让网关协议与本 Worker 自己的路由（`/health`、
 * `/agent`、以及那个语义完全不同的 `/debug/exec` 调试路由）各据其位、互不遮蔽。
 */
app.all(`${GATEWAY_PREFIX}/*`, async (c) => {
  const token = c.env.NIMBO_GATEWAY_TOKEN?.trim();
  if (token === undefined || token.length === 0) {
    // 刻意不退化成「无鉴权」或某个默认值：没配 secret 就是没开这个角色。
    return c.json(
      {
        ok: false,
        error:
          '未配置 NIMBO_GATEWAY_TOKEN —— 对外网关端点未启用。本地填 .dev.vars，线上用 `wrangler secret put NIMBO_GATEWAY_TOKEN`。',
      },
      503,
    );
  }

  const url = new URL(c.req.raw.url);
  url.pathname = url.pathname.slice(GATEWAY_PREFIX.length) || '/';

  return gatewayFor(c.env, token).fetch(new Request(url, c.req.raw));
});

/**
 * 探针——**不需要任何模型凭证**，只证明最大的那个未知数：
 * Worker 里到底能不能真的驱动 CF Sandbox。
 */
app.get('/sandbox-check', async (c) => {
  const workspace = workspaceFor(c.env, SERVER_SANDBOX_ID);
  const startedAt = Date.now();

  try {
    // 1) exec：证明容器真的在跑
    const uname = await workspace.exec({
      command: 'uname -a && echo "--- pwd ---" && pwd',
      signal: new AbortController().signal,
    });

    // 2) 文件往返：证明 NimboFS 七个方法经网关翻译后打得通
    const marker = `worker-server @ ${String(startedAt)}\n`;
    await workspace.writeFile('/worker-server-notes.txt', marker);
    const readBack = new TextDecoder().decode(
      await workspace.readFile('/worker-server-notes.txt'),
    );

    // 3) 同源工作区校验：bash 与文件工具读写的是不是同一个盘
    //    （注意用相对路径——虚拟根锚在沙盒默认工作目录，不是容器真实 /）
    const cat = await workspace.exec({
      command: 'cat worker-server-notes.txt',
      signal: new AbortController().signal,
    });

    return c.json({
      ok: uname.exitCode === 0 && readBack === marker && cat.exitCode === 0,
      durationMs: Date.now() - startedAt,
      exec: {
        exitCode: uname.exitCode,
        stdout: uname.stdout.trim(),
        stderr: uname.stderr.trim(),
      },
      fileRoundTrip: {
        wrote: marker,
        readBack,
        matches: readBack === marker,
      },
      sameOriginWorkspace: {
        exitCode: cat.exitCode,
        stdout: cat.stdout,
        matchesFileTools: cat.stdout === marker,
      },
    });
  } catch (error) {
    return c.json({ ok: false, error: describeError(error) }, 500);
  }
});

/**
 * 调试路由：直接在沙盒里跑一条命令，用来**独立核验** agent 的自述。
 * agent 的 finalResponse 是模型的说法；工具虽然真跑了，但「内容是否一致」这类判断
 * 出自模型，需要外部复核。仅本示例调试用——生产不该有这种任意执行入口。
 *
 * 刻意挂在 `/debug/exec` 而不是 `/exec`：后者是网关协议自己的端点名（见
 * `ENDPOINTS.exec`），避免读代码的人把两者混为一谈。
 */
app.get('/debug/exec', async (c) => {
  const command = c.req.query('cmd');
  if (command === undefined || command.length === 0) {
    return c.json({ ok: false, error: '需要 ?cmd=<command>' }, 400);
  }
  const workspace = workspaceFor(c.env, SERVER_SANDBOX_ID);
  const result = await workspace.exec({
    command,
    signal: new AbortController().signal,
  });
  return c.json({
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  });
});

const agentRequestSchema = z.object({ prompt: z.string().min(1) });

/** 角色 ①：Worker 里的 nimbo 会话，工具全部落在真实 CF Sandbox 上。 */
app.post('/agent', async (c) => {
  const model = resolveModel(c.env);
  if (model === undefined) {
    return c.json(
      {
        ok: false,
        error:
          '未配置模型 —— 请在 apps/cloudflare-worker-server/.dev.vars 里填 DEEPSEEK_API_BASE_URL 与 DEEPSEEK_API_TOKEN（见 .dev.vars.example）。',
      },
      400,
    );
  }

  const raw: unknown = await c.req.json().catch(() => undefined);
  const parsed = agentRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ ok: false, error: '请求体需要形如 {"prompt":"..."}' }, 400);
  }

  const startedAt = Date.now();
  try {
    const workspace = workspaceFor(c.env, SERVER_SANDBOX_ID);
    const agent = defineAgent({ model });
    const session = createSession(agent, { workspace });

    const result = await session.send(parsed.data.prompt);

    return c.json({
      ok: true,
      durationMs: Date.now() - startedAt,
      finalResponse: result.finalResponse,
    });
  } catch (error) {
    return c.json(
      {
        ok: false,
        durationMs: Date.now() - startedAt,
        error: describeError(error),
      },
      500,
    );
  }
});

export default app;
