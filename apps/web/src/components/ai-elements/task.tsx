/* ---------------------------------------------------------------------------
 * 本项目的「sm 档」密度调校（2026-07-25）
 *
 * ai-elements 出厂密度是给「一屏几条消息」的通用聊天场景设的。runko chat 一轮
 * 动辄十几个工具调用，出厂间距下一屏放不下几行、要一直滚。所以在**组件本体**里
 * 统一收一档（gap-8→gap-4、p-4→p-2.5、px-4 py-3→px-3 py-2 等），而不是在每个
 * 调用点覆盖 className——后者会让密度散落各处、下次 re-add 组件就全丢了。
 *
 * 改动只涉及间距与字号，不动结构与 API；升级组件时对着这段注释重做即可。
 * ------------------------------------------------------------------------- */

import { ChevronDownIcon, SearchIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

export type TaskItemFileProps = ComponentProps<'div'>;

export const TaskItemFile = ({
  children,
  className,
  ...props
}: TaskItemFileProps) => (
  <div
    className={cn(
      'bg-secondary text-foreground inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs',
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

export type TaskItemProps = ComponentProps<'div'>;

export const TaskItem = ({ children, className, ...props }: TaskItemProps) => (
  <div className={cn('text-muted-foreground text-sm', className)} {...props}>
    {children}
  </div>
);

export type TaskProps = ComponentProps<typeof Collapsible>;

export const Task = ({
  defaultOpen = true,
  className,
  ...props
}: TaskProps) => (
  <Collapsible className={cn(className)} defaultOpen={defaultOpen} {...props} />
);

export type TaskTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  title: string;
  /** 本项目加的：默认图标是放大镜（官方按「搜索任务」设计），但 Task 在这里还
   *  用来装「计划」「文件改动」，放大镜语义不对。 */
  icon?: ReactNode;
};

export const TaskTrigger = ({
  children,
  className,
  title,
  icon,
  ...props
}: TaskTriggerProps) => (
  <CollapsibleTrigger className={cn('group', className)} {...props}>
    {children ?? (
      <div className="text-muted-foreground hover:text-foreground flex w-full cursor-pointer items-center gap-2 text-sm transition-colors">
        {icon ?? <SearchIcon className="size-4" />}
        <p className="text-sm">{title}</p>
        <ChevronDownIcon className="size-4 transition-transform group-data-[panel-open]:rotate-180" />
      </div>
    )}
  </CollapsibleTrigger>
);

export type TaskContentProps = ComponentProps<typeof CollapsibleContent>;

export const TaskContent = ({
  children,
  className,
  ...props
}: TaskContentProps) => (
  <CollapsibleContent
    className={cn(
      'data-[closed]:fade-out-0 data-[closed]:slide-out-to-top-2 data-[open]:slide-in-from-top-2 text-popover-foreground data-[closed]:animate-out data-[open]:animate-in outline-none',
      className,
    )}
    {...props}
  >
    <div className="border-muted mt-2 space-y-1 border-l-2 pl-3">
      {children}
    </div>
  </CollapsibleContent>
);
