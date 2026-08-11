/**
 * header 右端的铃铛（docs/app/push-notification/feature.md §3.1）——这台设备的推送
 * 开关。样式与 `ThemeToggle` 逐像素同构（同一组尺寸/悬停色/圆角），它们并排站在
 * header 里，长得不一样会很显眼。
 *
 * 状态机在 `use-push-toggle.ts`，这里只管画。
 */
import { Icon } from '@iconify/react';

import { usePushToggle } from './use-push-toggle';

const ICON = {
  off: 'solar:bell-linear',
  on: 'solar:bell-bold',
  unsupported: 'solar:bell-off-linear',
  blocked: 'solar:bell-off-linear',
} as const;

const LABEL = {
  off: '开启通知',
  on: '关闭通知（仅本设备）',
  unsupported: '这台设备不支持网页推送',
  blocked: '通知权限被浏览器拒了',
} as const;

export function NotificationBell() {
  const { state, busy, error, hint, toggle } = usePushToggle();

  // `loading` = 还在问服务端；`disabled` = 服务端没配 VAPID。两种情况都什么都不
  // 显示——尤其是后者：用户不该看到一个点了也没用的按钮（产品文档 §3.8）。
  if (state === 'loading' || state === 'disabled') return null;

  const interactive = state === 'off' || state === 'on';
  const label = LABEL[state];

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={!interactive || busy}
      aria-label={label}
      // 失败原因优先显示（"点了没生效"时用户最需要知道为什么），其次是不支持/
      // 被拒的指引，最后是普通标签。
      title={error ?? hint ?? label}
      className={
        'inline-flex size-8 items-center justify-center rounded-md transition-colors ' +
        (interactive ?
          'text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground'
        : 'text-muted-foreground/40 cursor-not-allowed') +
        (busy ? ' animate-pulse' : '') +
        (error !== undefined && interactive ? ' text-destructive' : '')
      }
    >
      <Icon icon={ICON[state]} className="size-4" />
    </button>
  );
}
