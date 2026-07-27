/**
 * [通知触发点](../../../../docs/terms.md)白名单（docs/tech/push-notification.md §5.1）。
 *
 * `CHAT_PUSH_EVENTS`，逗号分隔，默认四类全开。这一期刻意**不做**按事件类型的
 * 用户设置界面——理由见 docs/features/push-notification.md 附录 A.2（真正的问题
 * 是"哪一类是噪音"现在纯靠猜，先全开跑一阵）。这个环境变量是给"确实被某一类吵
 * 到了"的人留的口子，改配置重启即生效。
 */
import type { Logger } from '../logger.js';
import type { PushKind } from './types.js';
import { isPushKind, PUSH_KINDS } from './types.js';

const LOG_SCOPE = 'push';

/**
 * 解析白名单。**无法识别的值忽略并 warn**（不是报错也不是整条作废）：写错一个
 * 词就让所有通知消失，是最难排查的那种失败。
 *
 * 变量未设置/全是空白 ⇒ 四类全开。显式设成空字符串以外的、一个合法值都不含的
 * 内容（比如 `CHAT_PUSH_EVENTS=typo`）⇒ 空集合，即全部关闭——这是用户明确表达
 * 过意图的情况，不该被"兜底成全开"覆盖掉。
 */
export function resolveEnabledEvents(log?: Logger): ReadonlySet<PushKind> {
  const raw = process.env.CHAT_PUSH_EVENTS?.trim();
  if (raw === undefined || raw.length === 0) return new Set(PUSH_KINDS);

  const enabled = new Set<PushKind>();
  const unknown: string[] = [];
  for (const part of raw.split(',')) {
    const value = part.trim();
    if (value.length === 0) continue;
    if (isPushKind(value)) enabled.add(value);
    else unknown.push(value);
  }
  if (unknown.length > 0) {
    log?.warn(LOG_SCOPE, 'CHAT_PUSH_EVENTS 里有认不出的值，已忽略', {
      unknown: unknown.join(','),
      allowed: PUSH_KINDS.join(','),
    });
  }
  return enabled;
}

/** 热路径上的问法（`notifier.ts` 的第一道闸门）——不打日志，见 `resolveEnabledEvents`。 */
export function isEventEnabled(kind: PushKind): boolean {
  return resolveEnabledEvents().has(kind);
}
