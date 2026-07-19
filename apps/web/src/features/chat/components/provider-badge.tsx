import { Badge } from '@/components/ui/badge';

import type { ConversationProvider } from '../schema';

/**
 * 沙盒 provider 徽标（docs/features/sandbox-provider.md）——让用户一眼看清这次
 * 会话跑在哪家云沙盒上。与[会话状态徽标](./conversation-status-badge.tsx)并列
 * 展示，但用 `outline` 变体 + 品牌色圆点区分开「状态」与「provider」两类信息。
 */
const PROVIDER_META: Record<
  ConversationProvider,
  { label: string; dotClassName: string }
> = {
  vercel: { label: 'Vercel', dotClassName: 'bg-foreground' },
  e2b: { label: 'E2B', dotClassName: 'bg-orange-500' },
};

export function ProviderBadge({
  provider,
}: {
  provider: ConversationProvider;
}) {
  const meta = PROVIDER_META[provider];
  return (
    <Badge variant="outline" className="gap-1 font-mono">
      <span className={`size-1.5 rounded-full ${meta.dotClassName}`} />
      {meta.label}
    </Badge>
  );
}
