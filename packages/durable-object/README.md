# @runko/durable-object

让 `@runko/agent` 的运行时跑在 **Cloudflare Durable Object** 里。

一个会话对应一个对象：[账本](../../docs/terms.md)、待发队列、裁决表都存在对象自带的 SQLite（`ctx.storage.sql`）里，agent 的轮也在对象里跑。平台保证同一个对象同一时刻只有一个实例，所以不需要租约、不需要 Redis、不需要转发。

```sh
pnpm add @runko/durable-object @runko/agent
```

## 它解决什么

把运行时搬进 Durable Object，要补上四件 Node 版不用操心的事：

| 问题 | 本包怎么做 |
| --- | --- |
| 持久化要落在对象自带的 SQLite 上 | `durableObjectKysely(ctx.storage.sql)`：一个 Kysely 方言，交给 `@runko/persist-kysely` |
| 对象被平台重启后，没收尾的轮要补「已中断」 | `durableObjectArbitration`：[起轮标记](../../docs/terms.md)写进 SQLite 并记上实例 id，新实例一眼认出上一辈子的残留 |
| 没人发请求时，对象被回收了也要有人收尾 | 一轮开始时设一个 alarm，到点还在跑就再设；对象被回收了，alarm 会把它重新叫醒、补收尾 |
| RPC 传不了 `AsyncIterable` | `framesToStream` / `readFrames`：把直播帧编成字节流过 RPC，再解回来 |

## 在 DO 类里怎么用

```ts
// conversation.ts —— 一个会话一个对象
import { DurableObject } from "cloudflare:workers";
import type { DurableObjectRuntime } from "@runko/durable-object";
import { createDurableObjectRuntime, framesToStream } from "@runko/durable-object";

export class Conversation extends DurableObject<Env> {
  private readonly agent: DurableObjectRuntime;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 构造函数里只做装配。建表 → 崩溃恢复 → 推一把排队的消息，都在 agent.ready 里，
    // 已经用 ctx.blockConcurrencyWhile 包好了：恢复做完之前，这个对象不会处理任何请求。
    this.agent = createDurableObjectRuntime(ctx, {
      agent: { model: myModel, instructions: "你是一个编程助手。" },
      // 每一轮的执行面：本地 MemoryFS + bash，或者 Cloudflare 沙盒。
      prepareTurn: () => ({ fs, exec }),
    });
  }

  // alarm 必须转给运行时：对象被回收后，就是它把对象叫醒、补收尾。
  async alarm(): Promise<void> {
    await this.agent.alarm();
  }

  // ---- 下面是给 Worker 调的 RPC 方法 ----

  send(conversationId: string, text: string, userId?: string) {
    return this.agent.runtime.enqueue(conversationId, { text, ...(userId ? { userId } : {}) });
  }

  stop(conversationId: string) {
    return this.agent.runtime.abort(conversationId);
  }

  approve(conversationId: string, callId: string, outcome: "allow" | "deny") {
    return this.agent.runtime.submitDecision(conversationId, callId, { outcome });
  }

  history(conversationId: string) {
    return this.agent.runtime.readLedger(conversationId);
  }

  /** 直播：RPC 只能传字节流，所以把 subscribe 编成 NDJSON。Worker 那边 cancel 流，这里的 signal 就 abort。 */
  live(conversationId: string, after?: number): ReadableStream<Uint8Array> {
    return framesToStream((signal) =>
      this.agent.runtime.subscribe(conversationId, { signal, ...(after !== undefined ? { after } : {}) }),
    );
  }
}
```

Worker 这一侧拿到字节流，用 `readFrames` 解回帧，想怎么发给浏览器都行。下面是转成 SSE：

```ts
// worker.ts
import type { Frame } from "@runko/agent";
import { readFrames } from "@runko/durable-object";

export { Conversation } from "./conversation.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const conversationId = new URL(request.url).searchParams.get("conversation") ?? "";
    const stub = env.CONVERSATION.get(env.CONVERSATION.idFromName(conversationId));

    if (request.method === "POST") {
      const { text } = await request.json<{ text: string }>();
      return Response.json(await stub.send(conversationId, text));
    }
    return new Response(toSse(readFrames(await stub.live(conversationId))), {
      headers: { "content-type": "text/event-stream" },
    });
  },
};

/** 帧 → SSE。浏览器断开时 cancel 一路传回对象，对象那边的订阅随之收线。 */
function toSse(frames: AsyncIterable<Frame>): ReadableStream<Uint8Array> {
  const iterator = frames[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  return new ReadableStream({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(next.value)}\n\n`));
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}
```

wrangler 配置：对象必须是 **SQLite 存储**的那种（`new_sqlite_classes`），并开 `nodejs_compat`（`@runko/core` 用到了 `node:*` 模块）。

```jsonc
{
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": { "bindings": [{ "name": "CONVERSATION", "class_name": "Conversation" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Conversation"] }]
}
```

## 缺省值与 Node 版不一样的地方

`createDurableObjectRuntime` 的选项就是 `createAgentRuntime` 的那一套，去掉了 `persistence`、`arbitration`、`stream`、`handover`（这四样本包定死），多一个 `watchdogInterval`。三处缺省值改了，你传了就用你的：

| 选项 | 缺省 | 为什么 |
| --- | --- | --- |
| `suspend.memoryWindow` | `"30s"`（Node 版 5 分钟） | 对象没人连着、也没有进行中的 I/O 时会被回收，内存里等人的 promise 就没了。所以一轮停下来等人时，很快就[挂起](../../docs/terms.md)落盘 |
| `sweep.interval` | `0`，即不开定时器（Node 版 10 秒） | workerd 里挂着的 `setTimeout` / `setInterval` 会让对象一直回收不掉（实测）。[定时回捞](../../docs/terms.md)改在 `alarm()` 里做 |
| `watchdogInterval` | `"1m"` | 一轮在跑时，每隔这么久靠 alarm 醒一次；`0` = 不设 alarm |

## 已知限制

1. **不支持事务。** DO 的 SQL 不允许 `BEGIN` / `SAVEPOINT`，所以 `db.transaction()` 会直接报错。要原子地写几条，用 `ctx.storage.transactionSync(() => { ... })`（回调必须是同步的）。runko 自己在这一档用不到事务。
2. **一行最多 2 MB。** DO 的 SQLite 里一个字符串或二进制值最多 2 MB，账本一条消息存一行。一轮里工具调用很多、输出很大时，这一轮的助手消息可能超过它，写账本就会失败。自己注册的工具若可能返回大块数据，先截断，或者存到别处、只把引用交给模型。
3. **只有这个对象自己看得到它的数据。** 每个会话的账本存在它自己的对象里，没有办法一条 SQL 查所有会话。会话列表、按用户找会话这类跨会话的查询，要在外面自己建索引（比如 D1 里一张会话表），在建会话、每轮收尾时顺手写一笔。

## 接入时要知道的几件事

- **alarm 归运行时用。** 一个对象只有一个 alarm。你自己也要用 alarm 的话，在 `alarm()` 里先做你的事，再调 `this.agent.alarm()`；并且要知道运行时会改写它的时间。
- **跨 RPC 的 cancel 有延迟。** 调用方 cancel 流之后，对象那一侧要等下一次往流里写才发现对面没了。为此 `framesToStream` 在等帧时每 10 秒写一个空行（`readFrames` 会跳过它），可用 `framesToStream(source, { keepAlive })` 调整。设成 `0` 的话，一条闲着的订阅会把对象钉在内存里，直到这个会话来了下一帧。
- **参数类型。** 方言把 `boolean` 存成 1/0，把安全范围内的 `bigint` 换成 number；超出范围的 `bigint` 和 `Date` 当场报错（DO 的 SQL 会把 `Date` 静默存成一串英文日期）。整数读回来都是 JS number，超过 2⁵³ 会丢精度。
- **不需要自己调 `migrateDurableObject`。** `createDurableObjectRuntime` 在 `ready` 里调了。只用方言或仲裁、自己装配运行时的话，要在 `blockConcurrencyWhile` 里先调一次。

设计背景见 [Cloudflare 版 chat 应用 · 技术方案](../../docs/host/cloudflare/tech/chat-on-cloudflare.md)。
