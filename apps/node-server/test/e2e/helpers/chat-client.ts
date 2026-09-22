/**
 * chat 应用的 HTTP 客户端——起会话、发消息、读账本、审批/回答。所有请求都走
 * `/api/chat/*`，登录靠调用方传进来的 cookie 字符串（`helpers/auth.ts` 换出来的那份）。
 *
 * 响应体一律用 zod 校验后再用（`helpers/schemas.ts`），不做类型断言、不让 `res.json()`
 * 的 `any` 泄漏出这个文件。
 */
import type { Replica } from './process.js';
import type {
  Activity,
  LedgerFrame,
  LedgerMessage,
  MessagePart,
  StartTurnAck,
} from './schemas.js';
import {
  activitySchema,
  createdConversationSchema,
  ledgerResponseSchema,
  startTurnAckSchema,
} from './schemas.js';
import { sleep, waitFor } from './wait.js';

function jsonHeaders(cookie: string): Record<string, string> {
  return { 'content-type': 'application/json', cookie };
}

interface ParsableSchema<T> {
  parse(value: unknown): T;
}

/** `Response.json()` 没有类型签名——立刻交给 zod 校验，这个函数是这份 `any` 唯一能落脚的地方。 */
async function parseJson<T>(
  res: Response,
  schema: ParsableSchema<T>,
): Promise<T> {
  const body: unknown = await res.json();
  return schema.parse(body);
}

export async function createConversation(
  replica: Replica,
  cookie: string,
  title: string,
): Promise<string> {
  const res = await fetch(`${replica.url}/api/chat/conversations`, {
    method: 'POST',
    headers: jsonHeaders(cookie),
    body: JSON.stringify({ title }),
  });
  if (!res.ok) {
    throw new Error(
      `createConversation(${replica.name}) failed: ${String(res.status)} ${await res.text()}`,
    );
  }
  const { id } = await parseJson(res, createdConversationSchema);
  return id;
}

export interface SendMessageOptions {
  readonly intent?: 'queue' | 'steer';
}

/**
 * 起轮 / 排队 / 插话——都是同一个端点，服务端按有没有轮在跑自己分流（见
 * `routes/chat.ts` 的 `POST .../messages`）。返回原始 `Response`：有的调用方只要状态码
 * （比如判断是不是 503），有的要 `parseStartTurnAck` 解出 `mode`。
 */
export async function sendMessage(
  replica: Replica,
  cookie: string,
  conversationId: string,
  text: string,
  opts: SendMessageOptions = {},
): Promise<Response> {
  return fetch(
    `${replica.url}/api/chat/conversations/${conversationId}/messages`,
    {
      method: 'POST',
      headers: jsonHeaders(cookie),
      body: JSON.stringify({
        text,
        ...(opts.intent !== undefined ? { intent: opts.intent } : {}),
      }),
    },
  );
}

export async function parseStartTurnAck(res: Response): Promise<StartTurnAck> {
  return parseJson(res, startTurnAckSchema);
}

export async function getActivity(
  replica: Replica,
  cookie: string,
  conversationId: string,
): Promise<Activity> {
  const res = await fetch(
    `${replica.url}/api/chat/conversations/${conversationId}/activity`,
    {
      headers: { cookie },
    },
  );
  return parseJson(res, activitySchema);
}

export async function readLedger(
  replica: Replica,
  cookie: string,
  conversationId: string,
): Promise<LedgerFrame[]> {
  const res = await fetch(
    `${replica.url}/api/chat/conversations/${conversationId}/messages`,
    {
      headers: { cookie },
    },
  );
  const { frames } = await parseJson(res, ledgerResponseSchema);
  return frames;
}

/**
 * 按消息 id 折叠：位置取第一次出现，内容取最后一次——恢复轮把同一个 id 的成品消息
 * 以新的 seq 重新写一遍（挂起卡片原地改写成有结果的样子），折叠之后读到的才是
 * 「这条消息现在长什么样」而不是「它半路上长过什么样」。
 */
export function foldMessages(frames: readonly LedgerFrame[]): LedgerMessage[] {
  const order: string[] = [];
  const latest = new Map<string, LedgerMessage>();
  for (const frame of frames) {
    if (!latest.has(frame.message.id)) {
      order.push(frame.message.id);
    }
    latest.set(frame.message.id, frame.message);
  }
  return order.flatMap((id) => {
    const message = latest.get(id);
    return message === undefined ? [] : [message];
  });
}

/** 折叠后的账本里，最后一条带 `metadata.status` 的消息——即最近一轮的收尾状态。 */
export function lastTurnEnd(
  messages: readonly LedgerMessage[],
): LedgerMessage | undefined {
  return [...messages]
    .reverse()
    .find((message) => message.metadata?.status !== undefined);
}

export function findToolPart(
  message: LedgerMessage | undefined,
  callId: string,
): MessagePart | undefined {
  return message?.parts.find((part) => part.toolCallId === callId);
}

export async function postApproval(
  replica: Replica,
  cookie: string,
  conversationId: string,
  callId: string,
  behavior: 'allow' | 'allow-session' | 'deny',
): Promise<Response> {
  return fetch(
    `${replica.url}/api/chat/conversations/${conversationId}/approvals/${callId}`,
    {
      method: 'POST',
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ behavior }),
    },
  );
}

export async function postAnswer(
  replica: Replica,
  cookie: string,
  conversationId: string,
  callId: string,
  answer: string,
): Promise<Response> {
  return fetch(
    `${replica.url}/api/chat/conversations/${conversationId}/questions/${callId}`,
    {
      method: 'POST',
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ answer }),
    },
  );
}

/**
 * 持有者刚死 / 刚被冻住时，请求会先撞上「转发目标够不着」的 503（`Retry-After`）——这是
 * 设计好的正常路径，不是错误（见 `routes/forward.ts` 的 `RETRY_LATER_STATUS`）。按秒级
 * 间隔重试，直到状态不再是 503，或者等到 `maxWaitMs` 放弃。
 *
 * 用轮询而不是「先死等接管阈值、再试一次」：接管阈值哪天被接上环境变量、变快了，
 * 用这个函数的用例会自动跟着变快，不需要跟着改等待时长（见 `helpers/env.ts` 的说明）。
 */
export async function retryWhile503(
  attempt: () => Promise<Response>,
  maxWaitMs: number,
): Promise<Response> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const res = await attempt();
    if (res.status !== 503) {
      return res;
    }
    if (Date.now() > deadline) {
      return res;
    }
    await sleep(1_000);
  }
}

/**
 * 从直播流上抓这一轮**第一张**审批卡片的 `toolCallId`。只有这一处需要真的读 SSE——
 * 内存窗口内待裁决的调用不落账本（收尾才落盘），要拿 callId 只能读流（见
 * docs/logic/orchestration/tech/suspend-resume.md §9.1）。
 *
 * 只做够用的解析：找 `"type":"tool-approval-request"` 那一段 JSON，正则抠出
 * `toolCallId`——不引入 SSE 解析库，这条流的分帧规则简单到没必要。
 */
export async function waitForApprovalCallId(
  replica: Replica,
  cookie: string,
  conversationId: string,
  timeoutMs: number,
): Promise<string> {
  const res = await fetch(
    `${replica.url}/api/chat/conversations/${conversationId}/stream`,
    {
      headers: { cookie },
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  const reader = res.body?.getReader();
  if (reader === undefined) {
    throw new Error(
      `stream response from ${replica.name} has no readable body`,
    );
  }
  const decoder = new TextDecoder();
  let buffered = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffered += decoder.decode(value, { stream: true });
      const match =
        /"type":"tool-approval-request"[^}]*"toolCallId":"([^"]+)"/.exec(
          buffered,
        );
      if (match?.[1] !== undefined) {
        return match[1];
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  throw new Error(
    `stream from ${replica.name} closed before a tool-approval-request appeared`,
  );
}

/** 这条会话此刻是不是「没有轮在跑」——归属放没放掉、轮收没收尾，都体现在这一个字段上。 */
export async function waitUntilInactive(
  replica: Replica,
  cookie: string,
  conversationId: string,
  timeoutMs = 20_000,
): Promise<void> {
  await waitFor(
    async () => !(await getActivity(replica, cookie, conversationId)).active,
    timeoutMs,
    `${replica.name} 上会话 ${conversationId} 不再有轮在跑`,
  );
}

/** 等最近一轮以 `completed` 收尾，返回那一刻折叠后的账本。 */
export async function waitUntilCompleted(
  replica: Replica,
  cookie: string,
  conversationId: string,
  timeoutMs = 20_000,
): Promise<LedgerMessage[]> {
  let messages: LedgerMessage[] = [];
  await waitFor(
    async () => {
      messages = foldMessages(
        await readLedger(replica, cookie, conversationId),
      );
      return lastTurnEnd(messages)?.metadata?.status === 'completed';
    },
    timeoutMs,
    `${replica.name} 上会话 ${conversationId} 的这一轮以 completed 收尾`,
  );
  return messages;
}

export interface SuspendedTurn {
  readonly callId: string;
  readonly message: LedgerMessage;
}

/**
 * 等这一轮以[挂起](../../../../../docs/terms.md)收尾，交回那次悬着的调用。
 *
 * 用一个内部变量在 `waitFor` 的探测闭包里赋值、探测成功后立刻返回——这样调用方拿到的
 * `callId` 是一个真正的 `const string`，可以放心地被任何后续闭包（重试循环、断言）捕获，
 * 不会撞上「窄化过的 `let` 在嵌套函数里失效」这条 TypeScript 的已知限制。
 */
export async function waitForSuspended(
  replica: Replica,
  cookie: string,
  conversationId: string,
  timeoutMs = 20_000,
): Promise<SuspendedTurn> {
  let found: SuspendedTurn | undefined;
  await waitFor(
    async () => {
      const messages = foldMessages(
        await readLedger(replica, cookie, conversationId),
      );
      const suspended = lastTurnEnd(messages);
      const callId = suspended?.metadata?.suspended?.callIds[0];
      if (suspended !== undefined && callId !== undefined) {
        found = { callId, message: suspended };
        return true;
      }
      return false;
    },
    timeoutMs,
    `${replica.name} 上会话 ${conversationId} 的这一轮以挂起收尾`,
  );
  if (found === undefined) {
    throw new Error('挂起那一轮没记下悬着的调用');
  }
  return found;
}
