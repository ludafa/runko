/**
 * 一对假的 `stream()`/`toJSON()`（`@nimbo/agent` 的 `DrivenSession`），塞给运行时的
 * `sessionFactory`——于是整条轮编排链路（起轮 → 装配 → 驱动 → 收尾 → [出队](../../../../docs/terms.md)）
 * 可以在**零模型**下跑完，而且测试能精确控制每个 chunk 什么时候到、这一轮怎么结束。
 *
 * 取代了迁移前的 `controllable-session.ts`：那时测试直接调 `startTurn(session, …)` 把
 * session 递进去；现在 session 由框架自己造，所以接缝挪到了工厂上。
 */
import type { DrivenSession, SessionFactory } from '@nimbo/agent';
import type {
  NimboChunk,
  NimboUIMessage,
  SessionOptions,
  SessionState,
  TurnResult,
} from '@nimbo/core';

const EMPTY_RESULT: TurnResult = { finalResponse: '', usage: {} };

export interface FakeTurnSession extends DrivenSession {
  /** `stream()` 被调用（这一轮真正开跑）时 resolve，带上喂给模型的文本。 */
  readonly started: Promise<string>;
  /** 这一轮拿到的中止信号——[停止](../../../../docs/terms.md)用例据此断言。 */
  readonly signal: AbortSignal | undefined;
  /** 框架注入的[人审通道](../../../../docs/terms.md)——测试用它模拟 core「解析出 review 就 await 它」。 */
  readonly onReview: SessionOptions['onReview'];
  /** 框架装配好的工具表——用来断言 `ask-user`/`web-search` 有没有注册上。 */
  readonly tools: Record<string, unknown>;
  emit(chunk: NimboChunk): void;
  push(message: NimboUIMessage): void;
  finish(result?: TurnResult): void;
  fail(error: Error): void;
}

function createFakeTurnSession(
  options: SessionOptions,
  tools: Record<string, unknown>,
): FakeTurnSession {
  const resume = options.resume;
  const messages: NimboUIMessage[] =
    resume === undefined ? [] : [...resume.messages];
  const id = resume?.id ?? 'fake-session';
  const createdAt = resume?.createdAt ?? Date.now();
  let turn = resume?.turn ?? 0;

  const queued: NimboChunk[] = [];
  let finished = false;
  let failure: Error | undefined;
  let result: TurnResult = EMPTY_RESULT;
  let active = false;
  let signal: AbortSignal | undefined;

  let wake: () => void = () => undefined;
  let waiter = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const bump = (): void => {
    const resolve = wake;
    waiter = new Promise<void>((next) => {
      wake = next;
    });
    resolve();
  };

  let markStarted: (text: string) => void = () => undefined;
  const started = new Promise<string>((resolve) => {
    markStarted = resolve;
  });

  async function* stream(
    input: string,
    opts?: { signal?: AbortSignal },
  ): AsyncGenerator<NimboChunk, TurnResult> {
    active = true;
    signal = opts?.signal;
    turn += 1;
    // core 自己也是这么干的：`stream()` 一进门就同步把这条 user 消息 push 进账本，
    // 框架的 `slice(priorMessageCount + 1)` 才跳得过它。
    messages.push({
      id: `core-user-${String(turn)}`,
      role: 'user',
      parts: [{ type: 'text', text: input }],
    });
    markStarted(input);
    try {
      for (;;) {
        const chunk = queued.shift();
        if (chunk !== undefined) {
          yield chunk;
          continue;
        }
        if (failure !== undefined) {
          throw failure;
        }
        if (finished) {
          return result;
        }
        await waiter;
      }
    } finally {
      active = false;
    }
  }

  return {
    started,
    get signal() {
      return signal;
    },
    onReview: options.onReview,
    tools,
    stream,
    toJSON(): SessionState {
      return { id, turn, messages: [...messages], createdAt };
    },
    steer(input: string): boolean {
      if (!active) {
        return false;
      }
      messages.push({
        id: `steer-${String(messages.length)}`,
        role: 'user',
        parts: [{ type: 'text', text: input }],
        metadata: { steered: true },
      });
      return true;
    },
    emit(chunk: NimboChunk): void {
      queued.push(chunk);
      bump();
    },
    push(message: NimboUIMessage): void {
      messages.push(message);
    },
    finish(next?: TurnResult): void {
      result = next ?? EMPTY_RESULT;
      finished = true;
      bump();
    },
    fail(error: Error): void {
      failure = error;
      bump();
    },
  };
}

export interface FakeSessions {
  factory: SessionFactory;
  /** 已经造出来的全部 session，按顺序。 */
  readonly all: FakeTurnSession[];
  /** 等下一个还没被认领的 session（已经造好的先给出去）。 */
  next(): Promise<FakeTurnSession>;
}

export function createFakeSessions(): FakeSessions {
  const all: FakeTurnSession[] = [];
  const claimed = new WeakSet<FakeTurnSession>();
  const waiters: ((session: FakeTurnSession) => void)[] = [];

  const factory: SessionFactory = (agent, options) => {
    const session = createFakeTurnSession(options, agent.tools ?? {});
    all.push(session);
    waiters.shift()?.(session);
    return session;
  };

  return {
    factory,
    all,
    next(): Promise<FakeTurnSession> {
      const pending = all.find((session) => !claimed.has(session));
      if (pending !== undefined) {
        claimed.add(pending);
        return Promise.resolve(pending);
      }
      return new Promise<FakeTurnSession>((resolve) => {
        waiters.push((session) => {
          claimed.add(session);
          resolve(session);
        });
      });
    },
  };
}
