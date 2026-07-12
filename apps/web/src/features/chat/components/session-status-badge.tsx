import { Badge } from '@/components/ui/badge';

import type { ChatSessionStatus } from '../schema';

const STATUS_META: Record<
  ChatSessionStatus,
  { label: string; variant: 'default' | 'secondary' | 'outline' }
> = {
  active: { label: 'active', variant: 'default' },
  sleeping: { label: 'sleeping', variant: 'secondary' },
  expired: { label: 'expired', variant: 'outline' },
};

export function SessionStatusBadge({ status }: { status: ChatSessionStatus }) {
  const meta = STATUS_META[status];
  return (
    <Badge variant={meta.variant} className="font-mono">
      {meta.label}
    </Badge>
  );
}
