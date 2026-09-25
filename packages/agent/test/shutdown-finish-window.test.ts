/**
 * `runtime.shutdown({ finishWindowMs })` —— 交权先等再中止，见
 * docs/host/node/tech/cluster-console.md §5、docs/host/node/plans/cluster-console.md O1。
 *
 * 全程假 session（`helpers/fake-session.ts`），零模型——这样能精确控制每个轮「什么时候跑完」
 * 「什么时候中止」，不必跟真模型的流式时序赛跑。「等人」那两条（构造/调用参数优先级之外的
 * 挂起细节）改在 `suspend.test.ts` 的「交权」一组里补，那边用真 core + mock 模型，`onReview`
 * 是框架自己的通道，假 session 绕不过它——这里只用一个「拦截 `onReview`、测试自己按需调用」的
 * 工厂来制造「正在等人」这个前提条件，不验证审批链本身。
 */
import type { AgentDefinition } from "@runko/core";
import type { ApprovalReviewer } from "@runko/core";
import { describe, expect, it, vi } from "vitest";

import { createAgentRuntime, memoryPersistence } from "../src/index.js";
import type { Persistence } from "../src/index.js";
import type { FakeSession } from "./helpers/fake-session.js";
import { assistantMessage, createFakeSessionFactory, endTurnChunk } from "./helpers/fake-session.js";

const agent: AgentDefinition = { model: "test/model" };

type RuntimeOptions = Parameters<typeof createAgentRuntime>[0];

function setup(overrides: Partial<RuntimeOptions> = {}) {
  const sessions = createFakeSessionFactory();
  const persistence = overrides.persistence ?? memoryPersistence();
  const runtime = createAgentRuntime({
    agent,
    persistence,
    sessionFactory: sessions.factory,
    prepareTurn: () => ({}),
    ...overrides,
  });
  return { runtime, sessions, persistence };
}

/** 同 `setup`，另外拦下框架注入给每个新 session 的 `onReview`，按造出顺序收集。 */
function setupWithReviewCapture() {
  const sessions = createFakeSessionFactory();
  const persistence = memoryPersistence();
  const reviewers: ApprovalReviewer[] = [];
  const runtime = createAgentRuntime({
    agent,
    persistence,
    prepareTurn: () => ({}),
    sessionFactory: (agentDef, options) => {
      if (options.onReview !== undefined) {reviewers.push(options.onReview);}
      return sessions.factory(agentDef, options);
    },
  });
  return { runtime, sessions, persistence, reviewers };
}

/** 跑完一轮：等 session 起来 → 发几个 chunk → 落一条成品消息 → 收尾。 */
async function runOneTurn(session: FakeSession, text: string, turn = 1): Promise<void> {
  await session.started;
  session.emit({ type: "start", messageId: `m-${String(turn)}` });
  session.emit({ type: "text-start", id: "t1" });
  session.emit({ type: "text-delta", id: "t1", delta: text });
  session.emit({ type: "text-end", id: "t1" });
  session.emit({ type: "finish" });
  session.push(assistantMessage(text, { turn, usage: {}, status: "completed" }));
  session.emit(endTurnChunk(turn));
  session.finish();
}

async function ledgerMessages(persistence: Persistence, conversationId: string) {
  const entries = await persistence.ledger.read(conversationId);
  return entries.map((entry) => entry.message);
}

describe("shutdown({ finishWindowMs })：先等再中止", () => {
  it("窗口内自然跑完：不中止，finished 计数对，账本是完整的成品消息", async () => {
    const { runtime, sessions, persistence } = setup();
    await runtime.enqueue("conv-finish", { text: "hello" });
    const session = await sessions.next();
    await session.started;

    const shutdownPromise = runtime.shutdown({ finishWindowMs: 2_000, graceMs: 2_000 });
    await runOneTurn(session, "done naturally", 1);

    await expect(shutdownPromise).resolves.toEqual({ aborted: 0, suspended: 0, finished: 1, settled: true, pending: 0 });

    const messages = await ledgerMessages(persistence, "conv-finish");
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      parts: [{ type: "text", text: "done naturally" }],
      metadata: { status: "completed" },
    });
  });

  it("窗口内被用户停止的轮：不算 finished（它不是自然跑完的），也不算这次关闭中止的", async () => {
    const { runtime, sessions } = setup();
    await runtime.enqueue("conv-user-stop", { text: "hello" });
    const session = await sessions.next();
    await session.started;

    const shutdownPromise = runtime.shutdown({ finishWindowMs: 2_000, graceMs: 2_000 });
    await runtime.abort("conv-user-stop");
    await vi.waitFor(() => {
      expect(session.signal?.aborted).toBe(true);
    });
    session.emit(endTurnChunk(1, "interrupted"));
    session.finish();

    await expect(shutdownPromise).resolves.toEqual({ aborted: 0, suspended: 0, finished: 0, settled: true, pending: 0 });
  });

  it("窗口到点还在跑的轮：按 ABORT_REASON_SHUTDOWN 中止，不是提前动手；finished 计 0", async () => {
    const { runtime, sessions } = setup();
    await runtime.enqueue("conv-abort", { text: "hello" });
    const session = await sessions.next();
    await session.started;

    const start = Date.now();
    const shutdownPromise = runtime.shutdown({ finishWindowMs: 150, graceMs: 3_000 });
    await vi.waitFor(() => {
      expect(session.signal?.aborted).toBe(true);
    });
    // 中止发生在窗口关掉之后，不是收到关闭请求立刻动手——这正是 finishWindowMs 新加的等待。
    expect(Date.now() - start).toBeGreaterThanOrEqual(100);

    session.emit(endTurnChunk(1, "interrupted"));
    session.finish();
    await expect(shutdownPromise).resolves.toEqual({ aborted: 1, suspended: 0, finished: 0, settled: true, pending: 0 });
  });

  it("finishWindowMs 小于轮询间隔（100ms < 500ms）时仍正确进入中止分支", async () => {
    const { runtime, sessions } = setup();
    await runtime.enqueue("conv-short-window", { text: "hello" });
    const session = await sessions.next();
    await session.started;

    const start = Date.now();
    const shutdownPromise = runtime.shutdown({ finishWindowMs: 100, graceMs: 2_000 });
    await vi.waitFor(
      () => {
        expect(session.signal?.aborted).toBe(true);
      },
      { timeout: 2_000 },
    );
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(80);
    // 没有卡在下一次 500ms 轮询上——窗口一到点，中止立刻发生。
    expect(elapsed).toBeLessThan(1_000);

    session.emit(endTurnChunk(1, "interrupted"));
    session.finish();
    await expect(shutdownPromise).resolves.toEqual({ aborted: 1, suspended: 0, finished: 0, settled: true, pending: 0 });
  });

  it("混合三轮同时 shutdown：finished / aborted / suspended 三个计数互不干扰", async () => {
    const { runtime, sessions, reviewers } = setupWithReviewCapture();

    await runtime.enqueue("conv-mix-finish", { text: "a" });
    const sessionFinish = await sessions.next();
    await sessionFinish.started;

    await runtime.enqueue("conv-mix-abort", { text: "b" });
    const sessionAbort = await sessions.next();
    await sessionAbort.started;

    await runtime.enqueue("conv-mix-suspend", { text: "c" });
    const sessionSuspend = await sessions.next();
    await sessionSuspend.started;

    const shutdownPromise = runtime.shutdown({ finishWindowMs: 200, graceMs: 3_000 });

    // 窗口期间转入等人——发出请求但先不等它（等的话会卡到 shutdown 的轮询逮到它才继续，
    // 那时下面「让第一个轮自然跑完」就来不及在窗口内发生了）。
    const reviewSuspend = reviewers[2];
    expect(reviewSuspend).toBeDefined();
    const pendingSuspend = reviewSuspend?.({
      toolName: "danger",
      input: { cmd: "x" },
      ctx: { callId: "call-mix", toolName: "danger", session: { id: "s", turn: 1 } },
    });

    // 窗口内让第一个轮自然跑完——要与上面那次「转入等人」同一时间发生，才测得出三者互不干扰。
    await runOneTurn(sessionFinish, "done", 1);

    // 等 shutdown 的轮询逮到「转入等人」的那个轮并把它挂起。
    await expect(pendingSuspend).resolves.toMatchObject({ behavior: "suspend", reason: "handover" });
    // 假 session 不会自己响应这个决定——手动补一条挂起收尾，模拟 core 真实会做的事。
    sessionSuspend.push(
      assistantMessage("(suspended)", { turn: 1, usage: {}, status: "suspended", suspended: { callIds: ["call-mix"], reason: "handover" } }),
    );
    sessionSuspend.emit({
      type: "message-metadata",
      messageMetadata: { turn: 1, usage: {}, status: "suspended", suspended: { callIds: ["call-mix"], reason: "handover" } },
    });
    sessionSuspend.finish();

    // 第三个轮撑到窗口结束才被中止。
    await vi.waitFor(() => {
      expect(sessionAbort.signal?.aborted).toBe(true);
    });
    sessionAbort.emit(endTurnChunk(1, "interrupted"));
    sessionAbort.finish();

    await expect(shutdownPromise).resolves.toEqual({ aborted: 1, suspended: 1, finished: 1, settled: true, pending: 0 });
  });

  it("窗口期间 enqueue 一律被拒 shutting_down——闸门先立，不等窗口关掉", async () => {
    const { runtime, sessions } = setup();
    await runtime.enqueue("conv-gate", { text: "first" });
    const session = await sessions.next();
    await session.started;

    const shutdownPromise = runtime.shutdown({ finishWindowMs: 300, graceMs: 2_000 });
    expect(runtime.isShuttingDown()).toBe(true);
    // 同一个会话、以及一个全新的会话，都立刻被拒——不因为还在等待窗口里就放行。
    await expect(runtime.enqueue("conv-gate", { text: "nope" })).resolves.toMatchObject({ mode: "rejected", reason: "shutting_down" });
    await expect(runtime.enqueue("conv-gate-other", { text: "nope2" })).resolves.toMatchObject({ mode: "rejected", reason: "shutting_down" });

    await runOneTurn(session, "done", 1);
    await shutdownPromise;
  });

  it("`options.shutdown.finishWindowMs` 是构造时缺省值：调用不传就用它，调用传了就覆盖", async () => {
    // 不传 —— 用构造时的 150ms。
    const { runtime: runtimeDefault, sessions: sessionsDefault } = setup({ shutdown: { finishWindowMs: 150 } });
    await runtimeDefault.enqueue("conv-ctor-default", { text: "hello" });
    const sessionDefault = await sessionsDefault.next();
    await sessionDefault.started;

    const start = Date.now();
    const shutdownDefault = runtimeDefault.shutdown({ graceMs: 3_000 });
    await vi.waitFor(() => {
      expect(sessionDefault.signal?.aborted).toBe(true);
    });
    expect(Date.now() - start).toBeGreaterThanOrEqual(100);
    sessionDefault.emit(endTurnChunk(1, "interrupted"));
    sessionDefault.finish();
    await shutdownDefault;

    // 调用显式传 0 —— 覆盖构造时的缺省，回到「立刻中止」的老行为。
    const { runtime: runtimeOverride, sessions: sessionsOverride } = setup({ shutdown: { finishWindowMs: 150 } });
    await runtimeOverride.enqueue("conv-call-override", { text: "hello" });
    const sessionOverride = await sessionsOverride.next();
    await sessionOverride.started;

    const shutdownOverride = runtimeOverride.shutdown({ finishWindowMs: 0, graceMs: 2_000 });
    await vi.waitFor(
      () => {
        expect(sessionOverride.signal?.aborted).toBe(true);
      },
      { timeout: 200, interval: 5 },
    );
    sessionOverride.emit(endTurnChunk(1, "interrupted"));
    sessionOverride.finish();
    await expect(shutdownOverride).resolves.toEqual({ aborted: 1, suspended: 0, finished: 0, settled: true, pending: 0 });
  });
});
