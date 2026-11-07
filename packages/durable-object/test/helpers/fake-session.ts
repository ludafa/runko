/**
 * 假 session：零模型跑通一轮，测试精确控制每个 chunk 什么时候到、这一轮怎么结束。
 * 从 `@runko/agent` 的测试辅助抄的最小一份（跨包不 import 测试文件）。
 */
import type { DrivenSession, DrivenTurnOptions, SessionFactory } from "@runko/agent";
import type { RunkoChunk, RunkoUIMessage, SessionOptions, SessionState, TurnResult } from "@runko/core";

export interface FakeSession extends DrivenSession {
  /** `stream()` 被调用（这一轮真正开跑）时 resolve，带上喂给模型的文本。 */
  readonly started: Promise<string>;
  emit(chunk: RunkoChunk): void;
  /** 往内部账本追加一条成品消息——收尾时框架会把它落进账本。 */
  push(message: RunkoUIMessage): void;
  finish(result?: TurnResult): void;
}

const EMPTY_RESULT: TurnResult = { finalResponse: "", usage: {} };

export function createFakeSession(options: SessionOptions = {}): FakeSession {
  const resume = options.resume;
  const messages: RunkoUIMessage[] = resume === undefined ? [] : [...resume.messages];
  const id = resume?.id ?? crypto.randomUUID();
  const createdAt = resume?.createdAt ?? Date.now();
  let turn = resume?.turn ?? 0;

  const queued: RunkoChunk[] = [];
  let finished = false;
  let result: TurnResult = EMPTY_RESULT;

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

  function stream(input: string, opts?: DrivenTurnOptions): AsyncGenerator<RunkoChunk, TurnResult> {
    // core 一进门就同步把这条 user 消息 push 进自己的账本，框架据此跳过它。
    messages.push({ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: input }] });
    return run(input, opts);
  }

  async function* run(input: string, opts?: DrivenTurnOptions): AsyncGenerator<RunkoChunk, TurnResult> {
    turn += 1;
    markStarted(input);
    for (;;) {
      const chunk = queued.shift();
      if (chunk !== undefined) {
        yield chunk;
        continue;
      }
      if (finished) {
        return result;
      }
      if (opts?.signal?.aborted === true) {
        throw new Error("aborted");
      }
      await waiter;
    }
  }

  return {
    started,
    stream,
    toJSON(): SessionState {
      return { id, turn, messages: [...messages], createdAt };
    },
    emit(chunk: RunkoChunk): void {
      queued.push(chunk);
      bump();
    },
    push(message: RunkoUIMessage): void {
      messages.push(message);
    },
    finish(next?: TurnResult): void {
      result = next ?? EMPTY_RESULT;
      finished = true;
      bump();
    },
  };
}

export interface FakeSessions {
  factory: SessionFactory;
  sessions: FakeSession[];
  /** 等下一个 session 被造出来（已经造好、还没被领走的先给出去）。 */
  next(): Promise<FakeSession>;
}

export function createFakeSessionFactory(): FakeSessions {
  const sessions: FakeSession[] = [];
  const claimed = new WeakSet<FakeSession>();
  const waiters: ((session: FakeSession) => void)[] = [];

  const factory: SessionFactory = (_agent, options) => {
    const session = createFakeSession(options);
    sessions.push(session);
    const waiter = waiters.shift();
    if (waiter !== undefined) {
      claimed.add(session);
      waiter(session);
    }
    return session;
  };

  return {
    factory,
    sessions,
    next(): Promise<FakeSession> {
      const pending = sessions.find((session) => !claimed.has(session));
      if (pending !== undefined) {
        claimed.add(pending);
        return Promise.resolve(pending);
      }
      return new Promise<FakeSession>((resolve) => {
        waiters.push(resolve);
      });
    },
  };
}

/** 跑完一轮：等 session 起来 → 发几个 chunk → 落一条成品消息 → 收尾。 */
export async function runOneTurn(session: FakeSession, text: string, turn = 1): Promise<void> {
  await session.started;
  session.emit({ type: "start", messageId: `m-${String(turn)}` });
  session.emit({ type: "text-start", id: "t1" });
  session.emit({ type: "text-delta", id: "t1", delta: text });
  session.emit({ type: "text-end", id: "t1" });
  session.emit({ type: "finish" });
  session.push({
    id: crypto.randomUUID(),
    role: "assistant",
    parts: [{ type: "text", text }],
    metadata: { turn, usage: {}, status: "completed" },
  });
  session.emit({ type: "message-metadata", messageMetadata: { turn, usage: {}, status: "completed" } });
  session.finish();
}
