/**
 * 本步动了哪些文件（`data-file-change` 部件）——用 ai-elements 的 `Task` 外壳，
 * 条目用 `TaskItemFile`（一个带边框的 inline chip，官方就是给「这一步碰过的文件」
 * 用的）。前缀 `+ / ~ / -` 沿用 git 的写法：读 diff 前缀比读中文标签快。
 *
 * 组件名保留 `FileChangeBadges`（唯一使用处是 `message-entry.tsx` 的 switch）。
 */
import { FileDiffIcon } from 'lucide-react';

import {
  Task,
  TaskContent,
  TaskItem,
  TaskItemFile,
  TaskTrigger,
} from '@/components/ai-elements/task';
import { cn } from '@/lib/utils';

export interface FileChangeLike {
  changes: { path: string; kind: 'add' | 'update' | 'delete' }[];
}

const KIND_MARK: Record<FileChangeLike['changes'][number]['kind'], string> = {
  add: '+',
  update: '~',
  delete: '−',
};

const KIND_CLASS: Record<FileChangeLike['changes'][number]['kind'], string> = {
  add: 'text-emerald-600 dark:text-emerald-400',
  update: 'text-muted-foreground',
  delete: 'text-destructive',
};

export function FileChangeBadges({ changes }: FileChangeLike) {
  return (
    <Task className="mb-2 w-full" defaultOpen data-testid="file-change-badges">
      <TaskTrigger
        title={`文件改动 ${String(changes.length)}`}
        icon={<FileDiffIcon className="size-4" />}
      />
      <TaskContent>
        {changes.map((change) => (
          <TaskItem key={change.path}>
            <TaskItemFile>
              <span
                aria-hidden="true"
                className={cn('font-mono', KIND_CLASS[change.kind])}
              >
                {KIND_MARK[change.kind]}
              </span>
              <span className="font-mono">{change.path}</span>
            </TaskItemFile>
          </TaskItem>
        ))}
      </TaskContent>
    </Task>
  );
}
