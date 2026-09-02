/**
 * 通知决策层（docs/tech/push-notification.md §5、§6.1）——四个[通知触发点](../../../../docs/terms.md)
 * 各自拼一条载荷，过三道闸门，交给 `sender.ts` 投出去。
 *
 * **这一层是整个功能唯一"想事情"的地方**：`sender.ts` 只管怎么发、SW 只管怎么显示。
 *
 * 三条接口姿态（与 `@runko/agent` 的钩子一致，理由也一样）：
 *
 * 1. **同步返回 `void`** —— 调用点在一轮的关键路径上（审批卡片正要上线），不能 await。
 * 2. **绝不抛错** —— 每个方法整体 try/catch，异步部分 `void` 掉并自带 catch。
 * 3. **绝不排在用户可见的事情前面** —— 调用方必须先把审批请求挂上（`requestReview`），
 *    再调这里。顺序反了会让一条通知发得慢一点变成"审批卡片来得慢一点"。
 *
 * 依赖方向：`push/` 不认识 `@runko/agent`（那是运行内核）。它只从
 * `agent/store.ts` 取数据——那是数据访问层，`push/store.ts` 也从那里拿 `Db` 类型。
 */
import type { JsonValue } from '@runko/core';

import { parseQueuedInputs } from '../agent/persistence.js';
import type { Db } from '../agent/store.js';
import { getConversation, getConversationById } from '../agent/store.js';
import type { Logger } from '../logger.js';
import { logger as defaultLogger } from '../logger.js';
import { isEventEnabled } from './events.js';
import { isPresent } from './presence.js';
import type { PushTransport } from './sender.js';
import { sendToUser, tagFor } from './sender.js';
import type { PushAction, PushKind, PushPayload } from './types.js';
import { isPushEnabled } from './vapid.js';

const LOG_SCOPE = 'push';

/** 正文里各段的长度上限（技术方案 §6.1）：通知栏显示得下，也少往外送内容。 */
const MAX_TITLE = 60;
const MAX_COMMAND = 100;
const MAX_QUESTION = 80;

/**
 * 一轮是怎么结束的。
 *
 * **必须与 `@runko/agent` 的 `TurnStatus` 保持一致**——刻意各自声明而不是从那边
 * import：`push/` 不认识运行内核（见文件头的依赖方向）。两者若长歪了，接线处
 * （`agent/runtime.ts`）会立刻编译不过，不会静默漂移。
 */
export type TurnEndStatus =
  'completed' | 'failed' | 'interrupted' | 'suspended' | 'crashed';

export interface ChatNotifierDeps {
  db: Db;
  logger?: Logger;
  /** 测试注入的假投递口；生产不传，`sender.ts` 自己用 web-push。 */
  transport?: PushTransport;
}

export interface ApprovalPendingInput {
  conversationId: string;
  /** 会话属主——通知发给他。 */
  userId: string;
  /**
   * 这次工具调用的 `callId`（`@runko/core` 的 `ApprovalContext.callId`）——通知上的
   * 裁决按钮靠它拼出 `POST .../approvals/{callId}`。
   */
  callId: string;
  toolName: string;
  input: JsonValue;
  /**
   * 这次审批多久没人应答就自动拒绝（毫秒）。通知的存活时长跟着它走
   * （技术方案 §6.3）：送不到人手上就已经自动拒绝了的通知，不如别送。
   *
   * 由调用方传入而不是这里自己读 env，是为了让"通知存活时长"与"审批超时"这两个
   * 值**在同一处**决定，不会各读一遍环境变量然后悄悄对不上（技术方案 §8）。
   */
  timeoutMs: number;
}

export interface QuestionPendingInput {
  conversationId: string;
  userId: string;
  question: string;
  timeoutMs: number;
}

export interface TurnSettledNotifyInput {
  conversationId: string;
  userId: string;
  status: TurnEndStatus;
}

export interface ChatNotifier {
  approvalPending(input: ApprovalPendingInput): void;
  questionPending(input: QuestionPendingInput): void;
  turnSettled(input: TurnSettledNotifyInput): void;
}

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

/**
 * bash 调用的命令行——有就用它，没有就退回工具名。
 *
 * 用 `in` 守卫逐层收窄而不是断言：`input` 是 `JsonValue`，任何工具的任何入参形状
 * 都可能进来，这里只想在"恰好是 `{command: string}`"时多说一句人话。
 */
function describeToolCall(toolName: string, input: JsonValue): string {
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    const command = input['command'];
    if (typeof command === 'string' && command.trim().length > 0) {
      return `要跑 ${truncate(command, MAX_COMMAND)}`;
    }
  }
  return `要用 ${toolName}`;
}

/**
 * 哪几类[挂住不消失](../../../../docs/terms.md)（docs/tech/push-notification.md §6.4）。
 *
 * 判据是**「错过它会不会卡住什么」**：要审批、agent 提问这两类停着一整轮，人不处理
 * agent 就一直等到超时自动拒绝——必须挂住。一轮完成/失败只是告知，事情已经结束了，
 * 挂住它们只会让通知栏攒一摞要你一条条点掉。
 */
const STICKY: Record<PushKind, boolean> = {
  approval: true,
  question: true,
  'turn-done': false,
  'turn-failed': false,
};

/**
 * 审批通知上的按钮（docs/tech/push-notification.md §6.5）。
 *
 * **顺序就是取舍**：浏览器只渲染前 `Notification.maxActions` 个，Chrome 是 2，多的
 * 静默丢弃。所以「允许」「拒绝」这对基本盘排前面——少了任何一个这功能就残废；
 * 「会话内都允许」是纯便利，排第三，在 Chrome 上看不到（想用它就点开页面，卡片上
 * 三个按钮齐全）。平台哪天放开到 3 个，它自己就出来了，不用改代码。
 */
const APPROVAL_ACTIONS: PushAction[] = [
  { id: 'allow', title: '允许', behavior: 'allow' },
  { id: 'deny', title: '拒绝', behavior: 'deny' },
  { id: 'allow-session', title: '本会话都允许', behavior: 'allow-session' },
];

const TURN_END_TEXT: Record<TurnEndStatus, { title: string; suffix?: string }> =
  {
    completed: { title: '跑完了' },
    failed: { title: '这一轮没跑完', suffix: '出错了' },
    interrupted: { title: '这一轮没跑完', suffix: '已停止' },
    // 挂起是**主动且可恢复**的，不是「没跑完」——文案刻意不跟上面三条同形。
    // 目前没有产出方（等 K3 挂起与恢复落地）。届时要顺带定一个产品问题：
    // 挂起前必然已经发过一条「等你审批」的推送，这条会不会变成重复打扰。
    suspended: { title: '这一轮先挂起了', suffix: '在等你' },
    crashed: { title: '这一轮没跑完', suffix: '中断了' },
  };

export function createChatNotifier(deps: ChatNotifierDeps): ChatNotifier {
  const log = deps.logger ?? defaultLogger;

  /**
   * 两道对所有触发点都成立的闸门 + 取会话标题。返回 undefined = 不发。
   *
   * 闸门顺序是按"越便宜越靠前"排的：总闸（读三个 env）→ 事件白名单（读一个 env）
   * → 在场（读内存 Map）→ 会话标题（查库）。最后才碰数据库。
   */
  function prepare(
    kind: PushKind,
    conversationId: string,
    userId: string,
  ): string | undefined {
    if (!isPushEnabled()) {
      return undefined;
    }
    if (!isEventEnabled(kind)) {
      return undefined;
    }
    // [前台抑制](../../../../docs/terms.md)：人就盯着这条会话，审批卡片已经在他
    // 眼前了，再弹一条系统通知纯属打扰。
    if (isPresent(userId, conversationId)) {
      return undefined;
    }
    const row = getConversation(deps.db, conversationId, userId);
    if (row === undefined) {
      return undefined;
    } // 会话已删/易主，没有可通知的对象
    return truncate(row.title, MAX_TITLE);
  }

  /** 拼载荷 + 投递。整体包 try/catch，异步部分 `void` 掉——绝不把错抛回一轮里。 */
  function dispatch(
    kind: PushKind,
    conversationId: string,
    userId: string,
    title: string,
    body: string,
    ttlSeconds?: number,
    /** 审批类才有：带上它，通知上就会挂出裁决按钮（`APPROVAL_ACTIONS`）。 */
    callId?: string,
  ): void {
    const payload: PushPayload = {
      v: 1,
      kind,
      conversationId,
      title,
      body,
      url: `/chat/${conversationId}`,
      tag: tagFor(kind, conversationId),
      sticky: STICKY[kind],
      ...(callId !== undefined ? { callId, actions: APPROVAL_ACTIONS } : {}),
    };
    void sendToUser(deps.db, userId, payload, {
      logger: log,
      ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
      ...(deps.transport !== undefined ? { transport: deps.transport } : {}),
    }).catch((error: unknown) => {
      // `sendToUser` 自己已经不 reject 了，这一层纯属防御——它是"通知绝不影响
      // 一轮"这条不变量的最后一道兜底。
      log.warn(LOG_SCOPE, '投递意外抛出', {
        kind,
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /** 把整个方法体包起来：闸门查询、查库、拼串里任何一步抛错都不该影响一轮。 */
  function guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      log.error(LOG_SCOPE, '通知决策抛错，已忽略', {
        what,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    approvalPending(input) {
      guard('approvalPending', () => {
        const title = prepare('approval', input.conversationId, input.userId);
        if (title === undefined) {
          return;
        }
        dispatch(
          'approval',
          input.conversationId,
          input.userId,
          '等你批准',
          `${title} · ${describeToolCall(input.toolName, input.input)}`,
          // 向下取整：宁可比审批超时早一点失效，也不要晚一点。
          Math.max(1, Math.floor(input.timeoutMs / 1000)),
          input.callId,
        );
      });
    },

    questionPending(input) {
      guard('questionPending', () => {
        const title = prepare('question', input.conversationId, input.userId);
        if (title === undefined) {
          return;
        }
        dispatch(
          'question',
          input.conversationId,
          input.userId,
          'agent 有话问你',
          `${title} · ${truncate(input.question, MAX_QUESTION)}`,
          Math.max(1, Math.floor(input.timeoutMs / 1000)),
        );
      });
    },

    turnSettled(input) {
      guard('turnSettled', () => {
        const kind: PushKind =
          input.status === 'completed' ? 'turn-done' : 'turn-failed';
        const title = prepare(kind, input.conversationId, input.userId);
        if (title === undefined) {
          return;
        }

        // 队列抑制（技术方案 §5.3）：[待发队列](../../../../docs/terms.md)非空意味着
        // 下一轮马上就开始——这不是"活干完了"，只是一轮的分界。不抑制的话用户会被
        // 连着叫醒五次，每次回来都发现它又开始跑下一条了。
        const row = getConversationById(deps.db, input.conversationId);
        const queued =
          row === undefined ?
            []
          : parseQueuedInputs(row.queuedMessagesJson, row.id, log);
        if (queued.length > 0) {
          return;
        }

        const text = TURN_END_TEXT[input.status];
        dispatch(
          kind,
          input.conversationId,
          input.userId,
          text.title,
          text.suffix === undefined ? title : `${title} · ${text.suffix}`,
        );
      });
    },
  };
}
