/**
 * **[应用层转发](../../../docs/terms.md)**——多副本部署下，请求打到哪个副本都要能被送到
 * [归属](../../../docs/terms.md)持有者手上。
 *
 * 框架只给一个**不透明的 `holder`**（这里存的是副本的可达地址），转发是宿主写的。
 * 判据只有一条：**这件事的状态在数据库里，还是在持有者的进程内存里。**
 *
 * | 端点 | 状态在哪 | 转不转 |
 * |---|---|---|
 * | `POST …/messages` | 归属在库里，但**起轮要在持有者那儿发生** | 转（拿 `held_by_other` 带回来的 `holder`） |
 * | `POST …/abort` | 持有者的 `AbortController` | **必须转** |
 * | `POST …/approvals/:callId` · `…/questions/:callId` | 持有者内存里那个正在 `await` 的 promise | **必须转** |
 * | `GET …/stream` | [进行中草稿](../../../docs/terms.md)在持有者内存里 | 有轮在跑且不在本地时转 |
 * | `DELETE …/queue[/:id]` | 库改完之后要广播一帧新快照，而订阅者都在持有者那侧 | 转 |
 * | `GET …/messages` · `GET …/queue` | 数据库 | 不转 |
 *
 * **队列那两条容易判错**：判据「状态在库里就不转」只对**读**成立。写完队列框架会广播
 * 一帧新的队列快照，那一帧只进本进程的流分发；而所有订阅者都挂在持有者那一侧（`stream`
 * 是转过去的）。不转的话，库改了、用户自己的流上却收不到，界面停在旧队列上。
 *
 * 审批与提问这两条最容易漏：人在回路桥把待裁决项挂在**那一轮的对象**上，不是数据库里。
 * 裁决打到别的副本会拿到「没有这条待定裁决」，而用户看到的是提交成功。
 *
 * 三道防护缺一不可，见下面各自的注释：**环路**、**鉴权**、**背压**。
 */
import type { Context } from "hono";

/** 转发标记。带着它进来的请求**一律不再转发**——见 `shouldForward`。 */
export const FORWARDED_HEADER = "x-runko-forwarded";
/** 副本之间的内部令牌。用户凭据不透传，节点间自己认自己。 */
export const PEER_TOKEN_HEADER = "x-runko-peer-token";

export interface NodeIdentity {
  /**
   * 本副本的**可达地址**（`http://10.1.2.3:3910`），原样进 `holder`。
   * 框架存它、传它、不解释它。
   */
  url: string;
  /** 副本之间的内部令牌；不配就不校验（本机联调用）。 */
  peerToken?: string;
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
export function createForwarder(node?: NodeIdentity): Forwarder {
  return {
    url: node?.url,

    isForwarded(c: Context): boolean {
      return c.req.header(FORWARDED_HEADER) !== undefined;
    },

    reject(c: Context): Response | undefined {
      const token = node?.peerToken;
      if (token === undefined || token === "") {return undefined;}
      if (c.req.header(FORWARDED_HEADER) === undefined) {return undefined;}
      if (c.req.header(PEER_TOKEN_HEADER) === token) {return undefined;}
      return new Response(JSON.stringify({ error: "bad peer token" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    },

    async forward(c: Context, holder: string): Promise<Response> {
      const target = new URL(c.req.path, holder);
      target.search = new URL(c.req.url).search;

      const headers = new Headers();
      const contentType = c.req.header("content-type");
      if (contentType !== undefined) {headers.set("content-type", contentType);}
      const accept = c.req.header("accept");
      if (accept !== undefined) {headers.set("accept", accept);}
      // **环路防护**：带着这个头进去，对面就绝不会再转一次。没有它，两个副本在归属
      // 刚好易主的那一瞬间会互相认为对方是持有者，然后打成死循环。
      headers.set(FORWARDED_HEADER, "1");
      if (node?.peerToken !== undefined && node.peerToken !== "") {
        headers.set(PEER_TOKEN_HEADER, node.peerToken);
      }

      // 正文很小（都是几十字节的 JSON），读成字符串最省事；GET 没有正文。
      const body = c.req.method === "GET" || c.req.method === "HEAD" ? undefined : await c.req.text();

      // **背压**：`fetch` 的响应体是一条流，原样交回去即可。千万别在这里 `await res.text()`
      // 再重新包一个响应——SSE 会退化成「一轮跑完才一次性出现」，而这个 bug 在单副本
      // 本地测试里永远复现不了。
      //
      // **持有者可能已经不在了**：进程崩溃之后，租约在库里还「活着」最长一个接管阈值
      // （缺省 60 秒）。这段窗口里 `inspect` 照样报它持有，于是这里会吃一个
      // `ECONNREFUSED`。放任它抛就是一条 500——而这不是服务器的错，是「稍后再试」。
      // 回 421 并带上 `holder`，客户端据此重试即可。
      let upstream: Response;
      try {
        upstream = await fetch(target, {
          method: c.req.method,
          headers,
          ...(body === undefined ? {} : { body }),
          // 客户端断开时把上游那条也收掉，别让转发出去的订阅悬着。
          signal: c.req.raw.signal,
        });
      } catch (error) {
        if (c.req.raw.signal.aborted) {throw error;} // 客户端自己走的，不是持有者的问题
        return new Response(
          JSON.stringify({
            reason: "holder_unreachable",
            holder,
            message: `Could not reach the holder ${holder}; it may have just died. Retry shortly.`,
          }),
          { status: 421, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(upstream.body, {
        status: upstream.status,
        headers: upstream.headers,
      });
    },
  };
}
