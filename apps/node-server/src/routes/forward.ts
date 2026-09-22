/**
 * **[应用层转发](../../../../docs/terms.md)**——多副本部署下，请求打到哪个副本都要能被送到
 * [归属](../../../../docs/terms.md)持有者手上。
 *
 * 框架只给一个**不透明的 `holder`**（这里存的是副本的可达地址），转发是宿主写的。
 * 判据只有一条：**这件事的状态在数据库里，还是在持有者的进程内存里。**
 *
 * | 端点 | 状态在哪 | 转不转 |
 * |---|---|---|
 * | `POST …/messages` | 归属在库里，但**起轮要在持有者那儿发生** | 转（拿 `held_by_other` 带回来的 `holder`） |
 * | `POST …/abort` | 持有者的 `AbortController` | **必须转** |
 * | `POST …/approvals/:callId` · `…/questions/:callId` | 有持有者：它内存里那个正在 `await` 的 promise；已[挂起](../../../../docs/terms.md)：裁决表 | 有持有者就**必须转**；没有就本副本直接答 |
 * | `GET …/stream` | [进行中草稿](../../../../docs/terms.md)在持有者内存里 | 有轮在跑且不在本地时转 |
 * | `DELETE …/queue[/:id]` | 库改完之后要广播一帧新快照，而订阅者都在持有者那侧 | 转 |
 * | `GET …/messages` · `GET …/queue` | 数据库 | 不转 |
 *
 * **队列那两条容易判错**：判据「状态在库里就不转」只对**读**成立。写完队列框架会广播
 * 一帧新的队列快照，那一帧只进本进程的流分发；而所有订阅者都挂在持有者那一侧（`stream`
 * 是转过去的）。不转的话，库改了、用户自己的流上却收不到，界面停在旧队列上。
 *
 * 审批与提问最容易漏：内存窗口里待裁决项挂在持有者**那一轮的对象**上，打错副本会拿到「没有
 * 这条待定裁决」；挂起之后没有持有者，收到答复的副本自己恢复（挂起与恢复 · 技术方案 §9.1）。
 *
 * 三道防护缺一不可，见下面各自的注释：**环路**、**副本间令牌**、**背压**。
 *
 * **用户身份靠 cookie 原样转过去**，持有者照常自己查一遍登录态与会话归属——转发进来的请求
 * 和用户直连的请求在它眼里没有区别。副本间令牌只防「伪造转发标记、逼副本在本地答」，
 * 越不过登录。
 */
import type { Context } from 'hono';

import type { Logger } from '../logger.js';
import { logger as defaultLogger } from '../logger.js';

const LOG_SCOPE = 'forward';

/** 转发标记。带着它进来的请求**一律不再转发**——见 `shouldForward`。 */
export const FORWARDED_HEADER = 'x-runko-forwarded';
/** 副本之间的内部令牌。用户凭据不透传，节点间自己认自己。 */
export const PEER_TOKEN_HEADER = 'x-runko-peer-token';

/**
 * 「持有者这会儿够不着，稍后再试」统一回 **503 + `Retry-After`**，**不能回 421**。
 *
 * 421（Misdirected Request）看着更贴切，但 Fetch 标准规定：客户端收到 421 要**自动换一条连接
 * 把请求再发一遍**（undici `lib/web/fetch/index.js` 照此实现，浏览器同理），带 JSON 正文的
 * POST 也照发不误。于是每次等待翻倍，发消息的请求还会被悄悄重发。多副本验证环境里这条是实测
 * 出来的：同一个请求 curl 2 秒拿到结果，Node `fetch` 要 4 秒。503 不会被自动重发。
 */
export const RETRY_LATER_STATUS = 503;
/** 建议客户端多久之后重试（秒）。持有者刚死时要等到接管阈值才有人接手，重试间隔短一点也只是多问几次。 */
export const RETRY_AFTER_SECONDS = '1';

/** 转发时最多等多久对方开口（收到响应头）。见 `forward` 里「持有者可能不响应」那段。 */
export const DEFAULT_FORWARD_TIMEOUT_MS = 10_000;

export interface NodeIdentity {
  /**
   * 本副本的**可达地址**（`http://10.1.2.3:3910`），原样进 `holder`。
   * 框架存它、传它、不解释它。
   */
  url: string;
  /** 副本之间的内部令牌；不配就不校验（本机联调用）。 */
  peerToken?: string;
  /** 转发时等对方开口的上限，缺省 `DEFAULT_FORWARD_TIMEOUT_MS`。**只管响应头，不管响应体**。 */
  forwardTimeoutMs?: number;
}

export interface Forwarder {
  /** 这条请求是别的副本转过来的吗。 */
  isForwarded(c: Context): boolean;
  /**
   * 内部令牌闸门：配了令牌而转发请求没带对，返回一个 401；其余情况返回 `undefined`。
   * **只管转发进来的请求**——终端用户的请求不该被要求带这个。
   */
  reject(c: Context): Response | undefined;
  /** 把当前请求原样转给 `holder`，返回上游的响应。 */
  forward(c: Context, holder: string): Promise<Response>;
  /** 本副本的可达地址；没配多副本时是 `undefined`。 */
  readonly url: string | undefined;
}

/**
 * 没配 `RUNKO_NODE_URL` 时给一个「什么都不转」的实现——单副本跑法一行代码都不用改。
 */
export function createForwarder(
  node?: NodeIdentity,
  logger: Logger = defaultLogger,
): Forwarder {
  return {
    url: node?.url,

    isForwarded(c: Context): boolean {
      return c.req.header(FORWARDED_HEADER) !== undefined;
    },

    reject(c: Context): Response | undefined {
      const token = node?.peerToken;
      if (token === undefined || token === '') {
        return undefined;
      }
      if (c.req.header(FORWARDED_HEADER) === undefined) {
        return undefined;
      }
      if (c.req.header(PEER_TOKEN_HEADER) === token) {
        return undefined;
      }
      logger.warn(
        LOG_SCOPE,
        'rejected a forwarded request with a bad peer token',
        { method: c.req.method, path: c.req.path },
      );
      return new Response(JSON.stringify({ error: 'bad peer token' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    },

    async forward(c: Context, holder: string): Promise<Response> {
      const target = new URL(c.req.path, holder);
      target.search = new URL(c.req.url).search;

      const headers = new Headers();
      const contentType = c.req.header('content-type');
      if (contentType !== undefined) {
        headers.set('content-type', contentType);
      }
      const accept = c.req.header('accept');
      if (accept !== undefined) {
        headers.set('accept', accept);
      }
      // **把 cookie 带过去**：持有者要知道这是谁发的请求，它会照常自己查一遍登录态。
      // 另一条路是转发方写一个「可信的用户 id 头」，那样安全就全押在副本间的令牌上——
      // 令牌一旦为空或泄露，谁都能冒充任何用户。带 cookie 则与用户直连没有区别。
      const cookie = c.req.header('cookie');
      if (cookie !== undefined) {
        headers.set('cookie', cookie);
      }
      // **环路防护**：带着这个头进去，对面就绝不会再转一次。没有它，两个副本在归属
      // 刚好易主的那一瞬间会互相认为对方是持有者，然后打成死循环。
      headers.set(FORWARDED_HEADER, '1');
      if (node?.peerToken !== undefined && node.peerToken !== '') {
        headers.set(PEER_TOKEN_HEADER, node.peerToken);
      }

      // 正文很小（都是几十字节的 JSON），读成字符串最省事；GET 没有正文。
      const body =
        c.req.method === 'GET' || c.req.method === 'HEAD' ?
          undefined
        : await c.req.text();

      // **背压**：`fetch` 的响应体是一条流，原样交回去即可。千万别在这里 `await res.text()`
      // 再重新包一个响应——SSE 会退化成「一轮跑完才一次性出现」，而这个 bug 在单副本
      // 本地测试里永远复现不了。
      //
      // **持有者可能已经不在了**：进程崩溃之后，租约在库里还「活着」最长一个接管阈值
      // （缺省 60 秒）。这段窗口里 `inspect` 照样报它持有，于是这里会吃一个
      // `ECONNREFUSED`。放任它抛就是一条 500——而这不是服务器的错，是「稍后再试」。
      // 回 503 并带上 `holder`，客户端据此重试即可（为什么不是 421 见 `RETRY_LATER_STATUS`）。
      //
      // **持有者也可能活着但不响应**（长时间 GC、虚机被挂起、被冻住）。那时 TCP 握手由它的
      // 内核完成、连接照样建立，`fetch` 不抛，只是一直等——等到 Node 内置 HTTP 客户端默认的
      // 300 秒响应头超时。所以要自己设一个「等对方开口」的上限，超时同样回 503。
      //
      // 计时器**拿到响应头就撤**（`finally`）：`fetch` 在响应头到达时就返回，响应体仍是一条流。
      // 它只管「对方开没开口」，不管「说了多久」——否则 SSE 这种一连几分钟的流会被拦腰切断。
      const forwardTimeoutMs =
        node?.forwardTimeoutMs ?? DEFAULT_FORWARD_TIMEOUT_MS;
      const startedAt = Date.now();
      logger.info(LOG_SCOPE, 'forwarding to holder', {
        method: c.req.method,
        path: c.req.path,
        holder,
      });
      const timeout = new AbortController();
      const timer = setTimeout(() => {
        timeout.abort();
      }, forwardTimeoutMs);
      let upstream: Response;
      try {
        upstream = await fetch(target, {
          method: c.req.method,
          headers,
          ...(body === undefined ? {} : { body }),
          // 客户端断开时把上游那条也收掉，别让转发出去的订阅悬着。
          signal: AbortSignal.any([c.req.raw.signal, timeout.signal]),
        });
      } catch (error) {
        if (c.req.raw.signal.aborted) {
          throw error;
        } // 客户端自己走的，不是持有者的问题
        // 连不上与等超时是同一件事：「持有者这会儿够不着，结果未知，稍后重试」。
        logger.warn(LOG_SCOPE, 'holder unreachable, answering 503', {
          method: c.req.method,
          path: c.req.path,
          holder,
          cause:
            timeout.signal.aborted ?
              `no response headers within ${String(forwardTimeoutMs)}ms`
            : error instanceof Error ? error.message
            : String(error),
          elapsedMs: Date.now() - startedAt,
        });
        return new Response(
          JSON.stringify({
            reason: 'holder_unreachable',
            holder,
            message: `Could not reach the holder ${holder}; it may have just died or stopped responding. Retry shortly.`,
          }),
          {
            status: RETRY_LATER_STATUS,
            headers: {
              'content-type': 'application/json',
              'retry-after': RETRY_AFTER_SECONDS,
            },
          },
        );
      } finally {
        clearTimeout(timer);
      }
      // 这里的耗时只到「响应头回来」：SSE 的响应体此后还会流很久，不算在里面。
      logger.info(LOG_SCOPE, 'holder answered', {
        method: c.req.method,
        path: c.req.path,
        holder,
        status: upstream.status,
        headersMs: Date.now() - startedAt,
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: upstream.headers,
      });
    },
  };
}

/**
 * 从环境变量读本副本的身份。**`RUNKO_NODE_URL` 是总开关**：配了才开多副本（租约仲裁 +
 * 转发），不配就是单进程跑法，行为与从前一字不差。
 */
export function resolveNodeIdentity(
  env: NodeJS.ProcessEnv = process.env,
): NodeIdentity | undefined {
  const url = env.RUNKO_NODE_URL?.trim();
  if (url === undefined || url.length === 0) {
    return undefined;
  }
  const peerToken = env.RUNKO_PEER_TOKEN?.trim();
  const timeout = Number(env.RUNKO_FORWARD_TIMEOUT_MS?.trim());
  return {
    url,
    ...(peerToken !== undefined && peerToken.length > 0 ? { peerToken } : {}),
    ...(Number.isFinite(timeout) && timeout > 0 ?
      { forwardTimeoutMs: timeout }
    : {}),
  };
}
