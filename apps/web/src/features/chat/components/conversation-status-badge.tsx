import { cn } from '@/lib/utils';

import type { ConversationProvider, ConversationStatus } from '../schema';

/**
 * 会话状态：一个点，不是徽标。
 *
 * 改版前是三枚英文等宽药丸（`active` / `sleeping` / `expired`）。在一列会话里
 * 那是三个和标题争抢的色块，而它要传达的信息只有一档二值：**这个沙盒还热着吗**。
 * 一个点就够——实心=活跃、空心=休眠、淡空心=过期，语义靠 `title`/`aria-label`
 * 兜底，不靠颜色单独承载（色盲可读）。
 */
const STATUS_META: Record<
  ConversationStatus,
  { label: string; className: string }
> = {
  active: { label: '活跃', className: 'bg-foreground border-foreground' },
  sleeping: { label: '休眠', className: 'border-foreground/45' },
  expired: { label: '已过期', className: 'border-foreground/20' },
};

/** 状态的中文说法——点本身只用 `title`/`aria-label` 承载它，会话详情弹窗要把它写成正文。逐项列出而不是从 `STATUS_META` 映射：后者要么得 `as` 断言、要么丢掉「三档都覆盖到」的编译期保证。 */
export const CONVERSATION_STATUS_LABEL: Record<ConversationStatus, string> = {
  active: STATUS_META.active.label,
  sleeping: STATUS_META.sleeping.label,
  expired: STATUS_META.expired.label,
};

/**
 * 展示层看到的状态——[本地沙盒](../../../../../../docs/terms.md)不会休眠，`sleeping`
 * 在这里就地折回 `active`，不管服务端实际给的是什么。三处读状态的地方
 * （这里、`branch-header.tsx`、`conversation-details-dialog.tsx`）都要过这一层，
 * 不能只改点、漏了详情弹窗里的文字。
 */
export function displayConversationStatus(
  status: ConversationStatus,
  provider: ConversationProvider,
): ConversationStatus {
  if (provider === 'local' && status === 'sleeping') {
    return 'active';
  }
  return status;
}

export function StatusDot({
  status,
  provider,
}: {
  status: ConversationStatus;
  provider: ConversationProvider;
}) {
  const meta = STATUS_META[displayConversationStatus(status, provider)];
  return (
    <span
      className={cn('size-1.5 shrink-0 rounded-full border', meta.className)}
      title={meta.label}
      aria-label={meta.label}
      role="img"
    />
  );
}

/** 旧名保留：`conversation-list.tsx` 是唯一使用处，改名只会让 diff 变大。 */
export { StatusDot as SessionStatusBadge };
