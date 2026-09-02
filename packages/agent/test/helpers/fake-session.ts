/**
 * 一对假的 `stream()`/`toJSON()`——`DrivenSession` 刻意比真 `Session` 窄，正是为了这个：
 * 整条轮编排链路（起轮 → 装配 → 驱动 → 收尾 → 出队）可以在**零模型、零沙盒**下跑完，
 * 而且测试能精确控制每个 chunk 什么时候到、这一轮怎么结束。
 */
import { randomUUID } from "node:crypto";
import type { RunkoChunk, RunkoUIMessage, SessionOptions, SessionState, TurnResult } from "@runko/core";

import type { DrivenSession, SessionFactory } from "../../src/index.js";

export interface FakeSession extends DrivenSession {
  /** `stream()` 被调用（这一轮真正开跑）时 resolve，带上喂给模型的文本。 */
  readonly started: Promise<string>;
  emit(chunk: RunkoChunk): void;
  /** 往内部账本追加一条成品消息——收尾时框架会把它落进[账本](../../../../docs/terms.md)。 */
  push(message: RunkoUIMessage): void;
  /** 正常收尾。 */
  finish(result?: TurnResult): void;
  /** 让 `stream()` 抛出——模拟「生成器自己炸了」那条路。 */
  fail(error: Error): void;
  readonly signal: AbortSignal | undefined;
}

const EMPTY_RESULT: TurnResult = { finalResponse: "", usage: {} };

export function createFakeSession(options: SessionOptions = {}): FakeSession {
  const resume = options.resume;
  const messages: RunkoUIMessage[] = resume === undefined ? [] : [...resume.messages];
  const id = resume?.id ?? randomUUID();
  const createdAt = resume?.createdAt ?? Date.now();
  let turn = resume?.turn ?? 0;

  const queued: RunkoChunk[] = [];
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

  async function* stream(input: string, opts?: { signal?: AbortSignal }): AsyncGenerator<RunkoChunk, TurnResult> {
    active = true;
    signal = opts?.signal;
    turn += 1;
    // core 自己也是这么干的：`stream()` 一进门就同步把这条 user 消息 push 进账本，
    // 所以框架的 `slice(priorMessageCount + 1)` 才跳得过它。
    messages.push({ id: randomUUID(), role: "user", parts: [{ type: "text", text: input }] });
    markStarted(input);
    try {
      for (;;) {
        const chunk = queued.shift();
        if (chunk !== undefined) {
          yield chunk;
          continue;
        }
        if (failure !== undefined) {throw failure;}
        if (finished) {return result;}
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
    stream,
    toJSON(): SessionState {
      return { id, turn, messages: [...messages], createdAt };
    },
    steer(input: string): boolean {
      if (!active) {return false;}
      messages.push({ id: randomUUID(), role: "user", parts: [{ type: "text", text: input }], metadata: { steered: true } });
      return true;
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
    fail(error: Error): void {
      failure = error;
      bump();
    },
  };
}

/** 把每一轮造出来的假 session 收集起来，测试再逐个驱动。 */
export function createFakeSessionFactory(): { factory: SessionFactory; sessions: FakeSession[]; next(): Promise<FakeSession> } {
  const sessions: FakeSession[] = [];
  const waiters: ((session: FakeSession) => void)[] = [];

  const factory: SessionFactory = (_agent, options) => {
    const session = createFakeSession(options);
    sessions.push(session);
    const waiter = waiters.shift();
    waiter?.(session);
    return session;
  };

  return {
    factory,
    sessions,
    /** 等下一个 session 被造出来（已经造好的先给出去）。 */
    next(): Promise<FakeSession> {
      const pending = sessions.find((session) => !claimed.has(session));
      if (pending !== undefined) {
        claimed.add(pending);
        return Promise.resolve(pending);
      }
      return new Promise<FakeSession>((resolve) => {
        waiters.push((session) => {
          claimed.add(session);
          resolve(session);
        });
      });
    },
  };
}

const claimed = new WeakSet<FakeSession>();

/** 一条最小的收尾帧——`status` 决定这一轮算怎么结束的。 */
export function endTurnChunk(turn: number, status: "completed" | "failed" | "interrupted" = "completed"): RunkoChunk {
  return { type: "message-metadata", messageMetadata: { turn, usage: {}, status } };
}

/** 一条最小的 assistant 成品消息。 */
export function assistantMessage(text: string, metadata?: RunkoUIMessage["metadata"]): RunkoUIMessage {
  return {
    id: randomUUID(),
    role: "assistant",
    parts: [{ type: "text", text }],
    ...(metadata !== undefined ? { metadata } : {}),
  };
}
