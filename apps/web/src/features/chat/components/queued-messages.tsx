/**
 * 输入框上方的**待发区**（docs/agent/steer-and-queue/feature.md §2.3）：列出这个会话
 * [排队](../../../../../docs/terms.md)中、还没发出的消息，每条可删、可**插进本轮**，可一键清空。
 *
 * 队列是**服务端**状态（`use-chat-messages.ts` 的 `queuedMessages`，由直播流的
 * `QueueFrame` 快照驱动），所以这个组件是纯展示 + 回调：删除/清空/插入都不做本地
 * 乐观移除——服务端返回的新快照才是唯一真相，多标签才不会各显示各的。
 *
 * 队列为空时整块不渲染（不留占位），保持没排队时的界面与从前一致。
 *
 * 外壳是 ai-elements 的 `Queue`（可折叠分区 + 条目行 + 悬停出现的行内动作），
 * 语义正好对上——它本来就是给「待办/待发」这类列表设计的。
 */
import { ClockIcon, XIcon, ZapIcon } from 'lucide-react';

import {
  Queue,
  QueueItem,
  QueueItemAction,
  QueueItemActions,
  QueueItemContent,
  QueueItemIndicator,
  QueueList,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
} from '@/components/ai-elements/queue';
import { Button } from '@/components/ui/button';
import type { QueuedMessage } from '@/features/chat/schema';

export function QueuedMessages({
  messages,
  onRemove,
  onClear,
  onPromote,
  streaming,
}: {
  messages: QueuedMessage[];
  onRemove: (messageId: string) => void;
  onClear: () => void;
  /** 把这一条从队列取出、立刻插进当前这一轮（[steer](../../../../../docs/terms.md)）。 */
  onPromote?: (message: QueuedMessage) => void;
  /** 没有进行中的一轮时不显示「插进本轮」——没有「本轮」可插。 */
  streaming?: boolean;
}) {
  if (messages.length === 0) return null;

  const canPromote = onPromote !== undefined && streaming === true;

  return (
    <Queue className="mb-2" aria-label="待发送的消息">
      <QueueSection defaultOpen>
        <QueueSectionTrigger>
          <QueueSectionLabel
            count={messages.length}
            label="条待发"
            icon={<ClockIcon className="size-3.5" aria-hidden="true" />}
          />
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-muted-foreground hover:text-foreground -my-1 mr-1"
            onClick={(e) => {
              // 这枚钮嵌在折叠触发器里，点它不该顺带把分区收起来。
              e.stopPropagation();
              onClear();
            }}
          >
            清空
          </Button>
        </QueueSectionTrigger>
        <QueueSectionContent>
          <QueueList>
            {messages.map((message) => (
              <QueueItem
                key={message.id}
                className="flex-row items-start gap-2"
              >
                <QueueItemIndicator />
                <QueueItemContent className="line-clamp-none whitespace-pre-wrap">
                  {message.text}
                </QueueItemContent>
                <QueueItemActions>
                  {canPromote && (
                    <QueueItemAction
                      onClick={() => {
                        onPromote(message);
                      }}
                      title="从队列取出，立刻插进当前这一轮"
                      aria-label={`插进本轮：${message.text}`}
                      // 常驻可见（不做 hover 才现）——它是这一区唯一的正向动作。
                      className="opacity-100"
                    >
                      <ZapIcon className="size-3" aria-hidden="true" />
                    </QueueItemAction>
                  )}
                  <QueueItemAction
                    onClick={() => {
                      onRemove(message.id);
                    }}
                    aria-label={`删除待发消息：${message.text}`}
                    className="opacity-100"
                  >
                    <XIcon className="size-3" aria-hidden="true" />
                  </QueueItemAction>
                </QueueItemActions>
              </QueueItem>
            ))}
          </QueueList>
        </QueueSectionContent>
      </QueueSection>
    </Queue>
  );
}
