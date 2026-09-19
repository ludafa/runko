/**
 * 给 `materialize.ts` 产出的那份 `RunkoUIMessage[]` [账本](../../../../../docs/terms.md)
 * 做渲染整形（docs/logic/orchestration/tech/single-ledger.md §5/§6）。这里只管两件事：
 *
 * - **交错**：把 `use-chat-messages.ts` 那些短命的乐观用户回显按发出时的位置插进物化
 *   出来的消息里（`buildRenderEntries`；它们为什么是短命的，见那个 hook 的文件头）。
 * - **收窄**：工具部件的 `input`/`output` 类型是 `unknown`，这里把它们收成各个工具卡片
 *   要的形状（`bash` 的命令、`ask-user` 的问题）。之所以是 `unknown`：
 *   `RunkoUIMessage` 的 `TOOLS` 类型参数只能是通用的 `UITools`，没有编译期已知的工具
 *   名联合可用（理由见 `@runko/core` 的 `state.ts` 里 `RunkoUIMessage` 的注释）。
 */
import type {
  RunkoDataParts,
  RunkoUIMessage,
  ToolTimingData,
} from '@runko/core';
import type { ToolUIPart, UIMessagePart, UITools } from 'ai';
import { getToolName, isToolUIPart } from 'ai';
import { z } from 'zod';

import type { JsonValue } from './schema';
import { jsonValueSchema } from './schema';

// ---- 乐观用户回显的交错 ----

export interface PendingUserEcho {
  /** 按发送顺序分配（`use-chat-messages.ts` 的 `nextEchoIdRef`）——下面 `buildRenderEntries` 给同锚点的回显排序时用它做平手判定。 */
  id: number;
  text: string;
  /** 这条回显发出时的 `messages.length`（`use-chat-messages.ts` 的 `sendMessage`）——它自己暂时还没有 wire 上的位置（要等真实 `MessageFrame` 到达把它弹掉，见那个 hook 的文件头），所以用这个锚点决定它相对于已物化账本渲染在哪。 */
  afterMessageCount: number;
  /**
   * 这条回显来自 [steer 中途插话](../../../../../docs/terms.md)（而不是「起新一轮」）。
   *
   * 两者的等待含义不同，界面要说清：起新一轮的回显几乎立刻就被真实消息顶替；
   * 插话的真实注入点是 core 的**下一个 step 边界**，当前工具跑得久就可能等上
   * 几十秒。所以插话回显要标成「待注入」并压暗——它还没被 agent 看到，画成
   * 一条正常指令是在撒谎。
   */
  steered?: boolean;
}

export type RenderEntry =
  | { kind: 'message'; message: RunkoUIMessage }
  | { kind: 'pending-echo'; echo: PendingUserEcho };

/**
 * 把 `pendingEchoes` 按各自的 `afterMessageCount` 锚点插进 `messages`。
 *
 * 锚点在 `messages` 变长时是稳定的：新消息追加在锚点索引之后，不会把已锚定的回显推走。
 * 所以第 1 轮中途发的一条回显，在第 2 轮开始追加自己的消息之后，仍然渲染在第 1 轮与
 * 第 2 轮之间。
 *
 * **同锚点回显的平手判定是防御性的。** 正常流程下同时最多只有一条回显在等
 * （`use-chat-messages.ts` 那边保证），但万一闭包过期之类的竞态产生了两条，这里也不能
 * 乱序——「连发两条消息乱序」正是这么来的。
 *
 * 为什么按 `id` **降序**破平手：`Array.prototype.sort` 是稳定排序，只按 `b - a`
 * （锚点降序）比较的话，平手时先处理的是**先发**的那条；而下面每次
 * `splice(index, 0, …)` 都会把原本在 `index` 上的东西往右推一格，于是先插先发的那条，
 * 结果反而排到了后发那条的**后面**。改成按 `id` 降序：后发的先处理、先插入，先发的那条
 * 随后插在同一个索引上、把后发的顶回右边，最终顺序就成了 `id` 升序（= 发送顺序），
 * 与 `messages` 自身恒按发送顺序排列一致。
 */
export function buildRenderEntries(
  messages: readonly RunkoUIMessage[],
  pendingEchoes: readonly PendingUserEcho[],
): RenderEntry[] {
  const entries: RenderEntry[] = messages.map((message) => ({
    kind: 'message',
    message,
  }));
  // 从锚点最大的那条开始往下插：这样先插入的不会挪动后面（锚点更小的）那条要用的
  // 索引。平手时按 `id` 降序（见上面的注释）。
  const sorted = [...pendingEchoes].sort(
    (a, b) => b.afterMessageCount - a.afterMessageCount || b.id - a.id,
  );
  for (const echo of sorted) {
    const index = Math.min(Math.max(echo.afterMessageCount, 0), entries.length);
    entries.splice(index, 0, { kind: 'pending-echo', echo });
  }
  return entries;
}

// ---- 工具部件的收窄（`input`/`output` 是 `unknown`，见文件头） ----

export type RunkoToolPart = ToolUIPart<UITools>;

/** `ai` 自带的 `isToolUIPart` 还会放过 `DynamicToolUIPart`，而 runko 从不产生这种部件（每个工具部件都是静态的 `tool-${name}`，见 `@runko/core` 的 `loop.ts`），所以这里再往下收一步，只留这个应用的卡片真正会渲染的那个形状。 */
export function isRunkoToolPart(
  part: UIMessagePart<RunkoDataParts, UITools>,
): part is RunkoToolPart {
  return isToolUIPart(part) && part.type.startsWith('tool-');
}

export function toolPartName(part: RunkoToolPart): string {
  return getToolName(part);
}

function parseUnknownJsonValue(value: unknown): JsonValue {
  const parsed = jsonValueSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** `bash` 自己的入参形状（docs/logic/engine/tech/builtin-tools.md）：`{ command: string, timeout_ms？ }`。 */
export function bashCommandFromInput(input: unknown): string | undefined {
  const value = parseUnknownJsonValue(input);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const { command } = value;
  return typeof command === 'string' ? command : undefined;
}

const askUserInputSchema = z.object({
  question: z.string(),
  options: z.array(z.string()).optional(),
});

export type AskUserInput = z.infer<typeof askUserInputSchema>;

/** `ask-user` 自己的入参形状（`apps/node-server/src/agent/chat-agent.ts` 的 `askUserInputSchema`）：`{ question, options？ }`。 */
export function askUserInputFrom(input: unknown): AskUserInput | undefined {
  const result = askUserInputSchema.safeParse(input);
  return result.success ? result.data : undefined;
}

/** `ask-user` 的 `execute()` 返回一个普通字符串（真实回答，或超时那句固定文案）——`output: unknown` 的收窄方式与 `bashCommandFromInput` 一样防御性。 */
export function askUserAnswerFromOutput(output: unknown): string | undefined {
  return typeof output === 'string' ? output : undefined;
}

export function prettyJson(value: unknown): string {
  return JSON.stringify(parseUnknownJsonValue(value), null, 2);
}

export function summarizeJson(value: unknown): string {
  const json = JSON.stringify(parseUnknownJsonValue(value));
  return json.length > 120 ? `${json.slice(0, 120)}…` : json;
}

// ---- [挂起](../../../../../docs/terms.md)之后还在等人的调用（docs/ingress/tech/chat-webapp.md §6.2） ----

const NO_WAITING_CALLS: ReadonlySet<string> = new Set();

/**
 * 部件还停在等人的状态，与 `@runko/core` 的 `pendingCallIds` 认的一致：`approval-responded`
 * 只有批准了才算（被拒的不会再执行）。
 *
 * 不直接 import 那个函数：web 只从 core 拿类型，引一个运行时函数会把整个 core 打进前端包。
 */
function isAwaitingHuman(part: RunkoToolPart): boolean {
  if (part.state === 'approval-responded') {
    return part.approval.approved;
  }
  return (
    part.state === 'approval-requested' || part.state === 'input-available'
  );
}

/**
 * 挂起之后还在等人答的调用，全从账本读出来：
 *
 * - 只看**最后一条**收尾消息，它的 `status` 必须是 `suspended`；
 * - 调用要列在它的 `metadata.suspended.callIds` 里；
 * - 部件还停在等人的状态。
 *
 * 第三条不能省：恢复那一轮会原地改写这条消息（同一个 id），但 `callIds` 是挂起那一刻记下的，
 * 改写之后还留着。只看 metadata，答过的调用也会被算成「在等」。
 */
export function findWaitingCallIds(
  messages: readonly RunkoUIMessage[],
): ReadonlySet<string> {
  let turnEnd: RunkoUIMessage | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.metadata?.status !== undefined) {
      turnEnd = messages[index];
      break;
    }
  }
  const metadata = turnEnd?.metadata;
  if (turnEnd === undefined || metadata?.status !== 'suspended') {
    return NO_WAITING_CALLS;
  }
  const listed = new Set(metadata.suspended?.callIds);
  const waiting = new Set<string>();
  for (const part of turnEnd.parts) {
    if (
      isRunkoToolPart(part) &&
      listed.has(part.toolCallId) &&
      isAwaitingHuman(part)
    ) {
      waiting.add(part.toolCallId);
    }
  }
  return waiting;
}

// ---- 工具耗时（`data-tool-timing`，见 `@runko/core` 的 `state.ts`——它会落盘，
// 与 `data-tool-progress` 不同） ----

/**
 * 按 `toolCallId` 找出对应的 `data-tool-timing` 部件（匹配它的 `id`，见 `@runko/core`
 * 的 `loop.ts` 里 `upsertToolTimingPart`）。
 *
 * 这个部件**从不**单独渲染成一张卡片：`message-entry.tsx` 的 switch 里没有它的 case，
 * 会掉到通用的工具部件判定上被拒掉；它只是被并进对应那次工具调用自己的卡片里
 * （`tool-call-card.tsx`）。
 *
 * 两种情况下它不存在：工具部件的入参还在流式产出（`startToolTiming` 要等
 * `tool-input-available` 之后才触发，见 `loop.ts`），或者这条消息是在这个部件出现之前
 * 落盘的。
 */
export function findToolTiming(
  message: RunkoUIMessage,
  toolCallId: string,
): ToolTimingData | undefined {
  for (const part of message.parts) {
    if (part.type === 'data-tool-timing' && part.id === toolCallId) {
      return part.data;
    }
  }
  return undefined;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** `HH:MM:SS`，本地时间。刻意不用 `toLocaleTimeString()`（沿用本仓库 `turn-stats-dialog.tsx` 里 `count` 的先例）：让渲染出来的文本不依赖 ICU 数据是否可用、也不随 locale 变。 */
export function formatClockTime(epochMs: number): string {
  const date = new Date(epochMs);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** 不到 1 秒显示毫秒，不到 60 秒显示一位小数的秒，再长显示 `Xm Ys`。`tool-call-card.tsx` 无论是已结束的耗时还是还在跑的计时，都用这一套。负数输入（两次 `Date.now()` 之间的时钟回拨）夹到 0，而不是渲染出一个没有意义的负耗时。 */
export function formatDuration(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < 1000) {
    return `${String(Math.round(clamped))}ms`;
  }
  // 先按下面渲染时用的同一个「一位小数」精度四舍五入，再去和 60 秒的边界比。否则
  // 59999ms 会显示成没有意义的「60.0s」，而不是进位成「1m 0s」。
  const roundedSeconds = Math.round(clamped / 100) / 10;
  if (roundedSeconds < 60) {
    return `${roundedSeconds.toFixed(1)}s`;
  }
  const totalSeconds = Math.round(clamped / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes)}m ${String(seconds)}s`;
}
