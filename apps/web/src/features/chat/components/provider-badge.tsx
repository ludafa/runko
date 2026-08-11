import { cn } from '@/lib/utils';

import type { ConversationProvider } from '../schema';

/**
 * 沙盒 provider 标记（docs/host/sandbox-provider/feature.md）——让用户一眼看清这次
 * 会话跑在哪家云沙盒上。
 *
 * 改版后不再是描边药丸：这是**恒定不变的一项事实**（会话创建时选定即固定），
 * 不是状态，不该有徽标那种「值得一看」的分量。降成一段小号等宽文字 + 一个品牌
 * 色点，和分支名同一层。
 */
const PROVIDER_META: Record<
  ConversationProvider,
  { label: string; dotClassName: string }
> = {
  vercel: { label: 'vercel', dotClassName: 'bg-foreground/70' },
  e2b: { label: 'e2b', dotClassName: 'bg-orange-500' },
};

export function ProviderBadge({
  provider,
  className,
}: {
  provider: ConversationProvider;
  className?: string;
}) {
  const meta = PROVIDER_META[provider];
  return (
    <span
      className={cn(
        'text-muted-foreground inline-flex items-center gap-1.5 font-mono text-[0.6875rem]',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn('size-1.5 rounded-full', meta.dotClassName)}
      />
      {meta.label}
    </span>
  );
}
