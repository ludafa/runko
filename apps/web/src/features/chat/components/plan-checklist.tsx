import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';

export interface PlanUpdateLike {
  items: { text: string; completed: boolean }[];
}

export function PlanChecklist({ items }: PlanUpdateLike) {
  return (
    <ul
      className="border-foreground/8 bg-card/30 space-y-1.5 rounded-xl border px-3 py-2.5"
      data-testid="plan-checklist"
    >
      {items.map((planItem, index) => (
        <li
          key={`${String(index)}-${planItem.text}`}
          className="flex items-start gap-2"
        >
          <Checkbox checked={planItem.completed} disabled className="mt-0.5" />
          <span
            className={cn(
              'text-sm leading-snug',
              planItem.completed && 'text-muted-foreground line-through',
            )}
          >
            {planItem.text}
          </span>
        </li>
      ))}
    </ul>
  );
}
