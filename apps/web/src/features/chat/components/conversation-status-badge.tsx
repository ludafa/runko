import { Badge } from '@/components/ui/badge';

import type { ConversationStatus } from '../schema';

const STATUS_META: Record<
  ConversationStatus,
  { label: string; variant: 'default' | 'secondary' | 'outline' }
> = {
  active: { label: 'active', variant: 'default' },
  sleeping: { label: 'sleeping', variant: 'secondary' },
  expired: { label: 'expired', variant: 'outline' },
};

export function SessionStatusBadge({ status }: { status: ConversationStatus }) {
  const meta = STATUS_META[status];
  return (
    <Badge variant={meta.variant} className="font-mono">
      {meta.label}
    </Badge>
  );
}
