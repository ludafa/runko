/**
 * 测试用的小工具：经 Worker 的 `fetch` 打接口（与浏览器走同一条路），注册拿登录态，读直播流。
 */
import { exports } from 'cloudflare:workers';
import { expect, vi } from 'vitest';

export const ORIGIN = 'http://runko.test';

export async function api(
  path: string,
  init: RequestInit & { cookie?: string } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.cookie !== undefined) {
    headers.set('cookie', init.cookie);
  }
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return exports.default.fetch(
    new Request(`${ORIGIN}${path}`, { ...init, headers }),
  );
}

export async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** 注册一个新用户，返回它的登录 cookie。 */
export async function signUp(label: string): Promise<string> {
  const response = await api('/api/auth/sign-up/email', {
    method: 'POST',
    body: JSON.stringify({
      name: label,
      email: `${label}-${crypto.randomUUID()}@example.com`,
      password: 'password1234',
    }),
  });
  expect(response.status).toBe(200);
  const cookies = response.headers.getSetCookie();
  const session = cookies
    .map((cookie) => cookie.split(';')[0] ?? '')
    .filter((pair) => pair.startsWith('better-auth.'));
  expect(session.length).toBeGreaterThan(0);
  return session.join('; ');
}

export async function createConversation(
  cookie: string,
  title: string,
): Promise<string> {
  const response = await api('/api/chat/conversations', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ title, provider: 'local' }),
  });
  expect(response.status).toBe(201);
  return (await json<{ id: string }>(response)).id;
}

export async function send(
  cookie: string,
  conversationId: string,
  text: string,
  intent?: 'queue' | 'steer',
): Promise<string> {
  const response = await api(
    `/api/chat/conversations/${conversationId}/messages`,
    {
      method: 'POST',
      cookie,
      body: JSON.stringify(intent === undefined ? { text } : { text, intent }),
    },
  );
  expect(response.status).toBe(202);
  return (await json<{ mode: string }>(response)).mode;
}

export interface ConversationDetail {
  turnInProgress: boolean;
  pendingDecisions: number;
  queuedMessages: { id: string; text: string }[];
}

export async function detail(
  cookie: string,
  conversationId: string,
): Promise<ConversationDetail> {
  const response = await api(`/api/chat/conversations/${conversationId}`, {
    cookie,
  });
  expect(response.status).toBe(200);
  return json<ConversationDetail>(response);
}

export interface ListedConversation extends ConversationDetail {
  id: string;
  title: string;
}

/** 列表读的是会话对象回写到 D1 的副本，所以「列表跟上了」要等一等。 */
export async function listed(
  cookie: string,
  conversationId: string,
): Promise<ListedConversation | undefined> {
  const response = await api('/api/chat/conversations', { cookie });
  expect(response.status).toBe(200);
  const rows = await json<ListedConversation[]>(response);
  return rows.find((row) => row.id === conversationId);
}

export async function waitIdle(
  cookie: string,
  conversationId: string,
): Promise<void> {
  await vi.waitFor(
    async () => {
      expect((await detail(cookie, conversationId)).turnInProgress).toBe(false);
    },
    { timeout: 10_000, interval: 50 },
  );
}

export interface UIPart {
  type: string;
  state?: string;
  text?: string;
  toolCallId?: string;
  approval?: { id: string };
}

export interface UIMessage {
  role: string;
  parts: UIPart[];
  metadata?: { status?: string };
}

/**
 * 读一次直播流到它自己关上（没有轮在跑时回放完就关），只留成品消息。
 * 有轮在跑时流会一直开着，所以要读的人先等这一轮停下来。
 */
export async function replay(
  cookie: string,
  conversationId: string,
): Promise<UIMessage[]> {
  const response = await api(
    `/api/chat/conversations/${conversationId}/stream`,
    { cookie },
  );
  expect(response.status).toBe(200);
  const body = await response.text();
  const messages: UIMessage[] = [];
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) {
      continue;
    }
    const frame = JSON.parse(line.slice('data: '.length)) as {
      message?: UIMessage;
    };
    if (frame.message !== undefined) {
      messages.push(frame.message);
    }
  }
  return messages;
}

export function textOf(message: UIMessage | undefined): string {
  return (message?.parts ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('');
}

export interface WireFrame {
  message?: UIMessage;
  chunk?: { type: string; [key: string]: unknown };
}

/**
 * 读直播流，直到某一帧让 `match` 给出值，返回它；流里一直没有就等到超时。找到就 cancel 流
 * （有轮在等人时流不会自己关）。一轮还在跑时它的内容是一帧帧 chunk，收尾后才是成品消息，
 * 所以 `match` 两种帧都要看。
 */
export async function waitForFrame<T>(
  cookie: string,
  conversationId: string,
  match: (frame: WireFrame) => T | undefined,
): Promise<T> {
  return vi.waitFor(
    async () => {
      const response = await api(
        `/api/chat/conversations/${conversationId}/stream`,
        { cookie },
      );
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      const deadline = Date.now() + 1_000;
      try {
        while (Date.now() < deadline) {
          const next = await Promise.race([
            reader.read(),
            new Promise<undefined>((resolve) => setTimeout(resolve, 200)),
          ]);
          if (next === undefined) {
            continue;
          }
          if (next.done) {
            break;
          }
          buffered += decoder.decode(next.value, { stream: true });
          // 最后一段可能是半行，留到下一次再解。
          const lines = buffered.split('\n');
          buffered = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) {
              continue;
            }
            const found = match(
              JSON.parse(line.slice('data: '.length)) as WireFrame,
            );
            if (found !== undefined) {
              return found;
            }
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      throw new Error('frame not in the stream yet');
    },
    { timeout: 10_000, interval: 100 },
  );
}
