/**
 * 计划清单（`data-plan-update` 部件）——用 ai-elements 的 `Task`：一个可折叠的
 * 「任务组」，触发行显示标题、内容区是带左侧引导线的条目列表，正好对上 update-plan
 * 的形状。完成项打勾并变淡由这里补（`TaskItem` 本身只是一行文字）。
 */
import { CheckIcon, ListChecksIcon } from 'lucide-react';

import {
  Task,
  TaskContent,
  TaskItem,
  TaskTrigger,
} from '@/components/ai-elements/task';
import { cn } from '@/lib/utils';

export interface PlanUpdateLike {
  items: { text: string; completed: boolean }[];
}

export function PlanChecklist({ items }: PlanUpdateLike) {
  const done = items.filter((item) => item.completed).length;

  return (
    <Task className="mb-2 w-full" defaultOpen data-testid="plan-checklist">
      <TaskTrigger
        title={`计划 ${String(done)}/${String(items.length)}`}
        icon={<ListChecksIcon className="size-4" />}
      />
      <TaskContent>
        {items.map((planItem, index) => (
          <TaskItem
            key={`${String(index)}-${planItem.text}`}
            className="flex items-start gap-2"
          >
            <span
              aria-hidden="true"
              className={cn(
                'mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border',
                planItem.completed ? 'border-foreground/30' : 'border-border',
              )}
            >
              {planItem.completed && <CheckIcon className="size-2.5" />}
            </span>
            <span className={cn(planItem.completed && 'line-through')}>
              {planItem.text}
            </span>
          </TaskItem>
        ))}
      </TaskContent>
    </Task>
  );
}
