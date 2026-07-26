/**
 * 打 `/` 后弹出的 [skill 清单](../../../../../docs/terms.md)菜单
 * （docs/tech/composer-skill-mention.md §6.1/§6.2）。
 *
 * 由 tiptap 的 suggestion 工具经 `ReactRenderer` 挂载，**键盘事件不走 React 的
 * onKeyDown**：suggestion 插件在 ProseMirror 层先拿到按键，再转调这里
 * `useImperativeHandle` 暴露的 `onKeyDown`。返回 `true` = 这个键归菜单、别再冒泡
 * （↑↓ 不移动光标、Enter 不发消息）；返回 `false` = 菜单不管，交还给编辑器。
 *
 * 这个「菜单开着时 Enter 归菜单」的优先级是本功能回归风险最高的一处——
 * [composer](../../../../../docs/terms.md) 的 Enter 平时是[排队](../../../../../docs/terms.md)
 * 发送，绝不能因为菜单开着就把消息发出去。
 */
import type { SuggestionKeyDownProps } from '@tiptap/suggestion';
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';

import type { SkillSummary } from '@/features/chat/schema';
import { cn } from '@/lib/utils';

export interface SkillSuggestionListProps {
  items: SkillSummary[];
  /** tiptap 注入：把选中的 skill 写回编辑器（替换掉 `/` 与已打的筛选词）。 */
  command: (item: { id: string; label: string }) => void;
}

export interface SkillSuggestionListHandle {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
}

export const SkillSuggestionList = forwardRef<
  SkillSuggestionListHandle,
  SkillSuggestionListProps
>(function SkillSuggestionList({ items, command }, ref) {
  const [selected, setSelected] = useState(0);

  // 筛选词一变，候选集就变了——选中位得回到第一个，否则会停在一个已经不存在的下标上。
  useEffect(() => {
    setSelected(0);
  }, [items]);

  function pick(index: number): void {
    const item = items[index];
    if (item === undefined) return;
    command({ id: item.name, label: item.name });
  }

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }: SuggestionKeyDownProps): boolean => {
      if (items.length === 0) return false;
      if (event.key === 'ArrowUp') {
        setSelected((prev) => (prev + items.length - 1) % items.length);
        return true;
      }
      if (event.key === 'ArrowDown') {
        setSelected((prev) => (prev + 1) % items.length);
        return true;
      }
      if (event.key === 'Enter') {
        pick(selected);
        return true;
      }
      return false;
    },
  }));

  // 一个都没匹配上时整个菜单不渲染——用户多半只是在打一条普通路径，
  // 别拿一个「无结果」的空框挡住他。
  if (items.length === 0) return null;

  return (
    <div
      className="bg-popover text-popover-foreground border-border z-50 max-h-64 w-72 overflow-y-auto rounded-md border p-1 shadow-md"
      role="listbox"
      aria-label="可用的 skill"
    >
      {items.map((item, index) => (
        <button
          key={item.name}
          type="button"
          role="option"
          aria-selected={index === selected}
          className={cn(
            'flex w-full flex-col items-start gap-0.5 rounded-sm px-2 py-1.5 text-left text-sm',
            index === selected ?
              'bg-accent text-accent-foreground'
            : 'text-foreground',
          )}
          // 用 mouseDown 而非 click：click 之前编辑器会先失焦，
          // 那一瞬 suggestion 已经 onExit 把菜单拆了，命令就发不出去了。
          onMouseDown={(e) => {
            e.preventDefault();
            pick(index);
          }}
          onMouseEnter={() => setSelected(index)}
        >
          <span className="font-medium">/{item.name}</span>
          <span className="text-muted-foreground line-clamp-2 text-xs">
            {item.description}
          </span>
        </button>
      ))}
    </div>
  );
});
