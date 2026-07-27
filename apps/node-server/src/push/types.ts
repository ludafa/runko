/**
 * 推送通知的共享类型（docs/tech/push-notification.md §6.1）。
 *
 * 这一层刻意只有类型、没有逻辑：`vapid.ts`（总闸）、`events.ts`（白名单）、
 * `sender.ts`（投递）、`notifier.ts`（决策）四个模块都要用 `PushKind`，把它放在
 * 任何一个里都会让另外三个反向依赖那一个的实现。
 */

/**
 * [通知触发点](../../../../docs/terms.md)——值得打扰用户的四个时刻，除此之外一律不发。
 *
 * 字符串值同时是三处的对外契约：`CHAT_PUSH_EVENTS` 白名单的取值、
 * [通知合并标签](../../../../docs/terms.md)的前缀（`approval:<会话 id>`）、
 * 以及推送载荷里 [Service Worker](../../../../docs/terms.md) 读到的 `kind`。改这些
 * 字面量等于改 wire 契约。
 */
export type PushKind = 'approval' | 'question' | 'turn-done' | 'turn-failed';

export const PUSH_KINDS: readonly PushKind[] = [
  'approval',
  'question',
  'turn-done',
  'turn-failed',
];

export function isPushKind(value: string): value is PushKind {
  // `includes` 在 `readonly PushKind[]` 上要求参数已经是 `PushKind`，这里的输入
  // 恰恰是「还不知道是不是」的字符串——用 `some` 做逐项比较，避免为了绕类型而
  // 写一次 `as`（根 CLAUDE.md 的 TypeScript 规范）。
  return PUSH_KINDS.some((kind) => kind === value);
}

/**
 * 一条推送的完整载荷（JSON 序列化后加密投出）。
 *
 * **文案在服务端拼好**：`title`/`body` 是最终显示的中文字符串，Service Worker
 * 原样显示、不做任何判断。理由见 docs/tech/push-notification.md 附录 B.1——那份
 * SW 是没有构建、没有类型检查的裸 JS，逻辑越少越好。
 */
export interface PushPayload {
  /** 载荷版本。SW 认不出的版本走兜底文案，不是崩溃——新旧 SW 会在用户设备上并存一段时间。 */
  v: 1;
  kind: PushKind;
  conversationId: string;
  /** 已按 docs/tech/push-notification.md §6.1 截断。 */
  title: string;
  /** 同上。 */
  body: string;
  /** 站内路径（`/chat/<conversationId>`），SW 用它 focus 或 openWindow。 */
  url: string;
  /** [通知合并标签](../../../../docs/terms.md)：`<kind>:<conversationId>`。 */
  tag: string;
  /**
   * [挂住不消失](../../../../docs/terms.md)——通知停在屏幕上直到人动手处理，不自动收
   * （SW 里映射成 `requireInteraction`）。
   *
   * **按类型分档，不是全局开关**（docs/tech/push-notification.md §6.4）：要审批、
   * agent 提问这两类**卡着一轮**，错过就等于把 agent 晾在那儿，必须挂住；一轮完成/
   * 失败只是告知，挂住的话跑十轮就攒十条要你一条条点掉，反而更烦。
   *
   * 由服务端决定而不是 SW 自己按 `kind` 推断：SW 是没有类型检查的裸 JS，一切判断
   * 都留在这边（同 `title`/`body` 的理由）。
   */
  sticky: boolean;
  /**
   * 审批类专有：这次工具调用的 `callId`。通知上的按钮靠它 +`conversationId` 拼出
   * `POST .../approvals/{callId}`。其余 kind 省略。
   */
  callId?: string;
  /**
   * 通知上的操作按钮（docs/tech/push-notification.md §6.5）。省略 = 没有按钮，
   * 点通知只跳转。
   *
   * **每一项自带 `behavior`**，SW 拿到就直接发请求，不需要自己从 `action` id 推断
   * 该调什么——判断一律留在服务端（同 `title`/`body`/`sticky` 的理由）。
   */
  actions?: PushAction[];
}

/**
 * 一个通知按钮。
 *
 * **顺序即优先级**：浏览器只渲染前 `Notification.maxActions` 个，多的**静默丢弃**
 * ——Chrome（桌面与 Android）是 **2**。所以排序时把「少了就残废」的放前面，
 * 「有更好、没有也行」的放后面（见 `notifier.ts` 的 `APPROVAL_ACTIONS`）。
 */
export interface PushAction {
  /** 按钮 id，`notificationclick` 的 `event.action` 拿到的就是它。 */
  id: string;
  /** 按钮上的字。Chrome 上空间很窄，两三个字为宜。 */
  title: string;
  /** 点它就往审批接口发这个裁决（`PostApprovalInputSchema` 的 `behavior`）。 */
  behavior: 'allow' | 'allow-session' | 'deny';
}
