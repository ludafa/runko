/**
 * 侧栏的会话列表 + 新建入口。
 *
 * 改版做的两件事（docs/ingress/features/chat-ui.md「其余可见变化」）：
 *
 * 1. **新建表单从侧栏挪进弹窗**。它一个会话只用一次，却常驻占着列表最显眼的
 *    位置，先收成一枚 `＋ 新会话` 点开才展开——但侧栏只有 220px 宽，展开后的
 *    表单挤在里面同样局促（输入框、provider 切换、提交钮三件套叠在一列）。
 *    现在点开的是 `Dialog`：宽度不再受侧栏约束，控件回到正常尺寸，provider
 *    也放得下一句说明。
 * 2. **行去徽标**。`active/sleeping/expired` 三枚英文药丸换成一个状态点，
 *    provider 并进分支那一行的行尾。列表回到「一行标题 + 一行标识」的两行结构，
 *    扫的时候只有标题在动。
 */
import { Link } from '@tanstack/react-router';
import { LoaderIcon, PlusIcon } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

import type { ChatConfig, Conversation, ConversationProvider } from '../schema';
import { StatusDot } from './conversation-status-badge';

/** 每档 provider 在新建表单里的说法——选项本身（有哪几档、默认选哪个）来自 `/api/chat/config`，这里只管怎么讲。 */
const PROVIDER_COPY: Record<
  ConversationProvider,
  { label: string; hint: string }
> = {
  vercel: { label: 'Vercel', hint: '按名字恢复，快照到期前一直在' },
  e2b: { label: 'E2B', hint: '空闲自动暂停，下条消息唤醒' },
  local: {
    label: '本地',
    hint: '跑在服务端进程内存里，没有 git、不联网，不需要任何云账号',
  },
};

/** 拿不到 `/api/chat/config` 时的退路：`local` 不需要任何云账号，服务端也恒保证支持它（docs/ingress/tech/unified-demo.md §4.3）。 */
const FALLBACK_CHAT_CONFIG: ChatConfig = {
  providers: ['local'],
  defaultProvider: 'local',
  model: 'demo',
};

export function SessionList({
  conversations,
  activeSessionId,
  onCreate,
  pendingTitle,
  chatConfig,
}: {
  conversations: Conversation[];
  activeSessionId: string | undefined;
  onCreate: (title: string, provider: ConversationProvider) => void;
  /** 正在建的那个会话的标题；`undefined` 表示当前没有在建。 */
  pendingTitle: string | undefined;
  /** `/api/chat/config` 的结果；`undefined` 表示还没拿到（含请求失败），此时退回 `FALLBACK_CHAT_CONFIG`。 */
  chatConfig: ChatConfig | undefined;
}) {
  const creating = pendingTitle !== undefined;
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const config = chatConfig ?? FALLBACK_CHAT_CONFIG;
  const [provider, setProvider] = useState<ConversationProvider>(
    config.defaultProvider,
  );

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    onCreate(title.trim(), provider);
    setTitle('');
    // 提交即关：会话区当帧就换成准备中视图（见 ProvisioningView），等待反馈在
    // 那儿，弹窗继续占着屏幕中央只会挡住它。
    setOpen(false);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <span className="text-muted-foreground text-[0.6875rem] font-medium tracking-[0.02em]">
          会话
        </span>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="text-muted-foreground hover:text-foreground -mr-1"
                disabled={creating}
                aria-label="新建会话"
              />
            }
          >
            <PlusIcon className="size-3" aria-hidden="true" />
            新会话
          </DialogTrigger>

          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>新建会话</DialogTitle>
              <DialogDescription>
                会话会拿到自己的分支和沙盒，多轮改动在同一条分支上累积。
              </DialogDescription>
            </DialogHeader>

            <form onSubmit={handleCreate} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="new-conversation-title"
                  className="text-[0.6875rem] font-medium tracking-[0.02em]"
                >
                  标题
                </label>
                <Input
                  id="new-conversation-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="这次要做什么？（可选）"
                  autoFocus
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-[0.6875rem] font-medium tracking-[0.02em]">
                  沙盒 provider
                </span>
                <div
                  role="group"
                  aria-label="沙盒 provider"
                  className="flex flex-col gap-2"
                >
                  {config.providers.map((value) => {
                    const copy = PROVIDER_COPY[value];
                    return (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setProvider(value)}
                        aria-pressed={provider === value}
                        className={cn(
                          'flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition-colors',
                          provider === value ?
                            'border-foreground bg-muted'
                          : 'border-border hover:bg-muted/50',
                        )}
                      >
                        <span className="font-mono text-xs">{copy.label}</span>
                        <span className="text-muted-foreground text-[0.6875rem] leading-snug">
                          {copy.hint}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setOpen(false);
                  }}
                >
                  取消
                </Button>
                <Button type="submit" size="sm">
                  建会话并开分支
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <nav
        className="-mx-1 flex flex-1 flex-col overflow-y-auto"
        aria-label="会话列表"
      >
        {/* 在建的会话先占一行：列表顶部立刻有它的位置，201 回来后原地换成真行 */}
        {pendingTitle !== undefined && (
          <div className="border-foreground bg-muted flex flex-col gap-0.5 border-l-2 py-1.5 pr-2 pl-2.5">
            <div className="flex items-center gap-1.5">
              <LoaderIcon
                className="text-muted-foreground size-2.5 shrink-0 animate-spin"
                aria-hidden="true"
              />
              <span className="truncate text-[0.8125rem] leading-snug">
                {pendingTitle.length > 0 ? pendingTitle : '新会话'}
              </span>
            </div>
            <span className="text-muted-foreground truncate pl-4 font-mono text-[0.6875rem]">
              正在准备工作区…
            </span>
          </div>
        )}

        {conversations.length === 0 && pendingTitle === undefined ?
          <p className="text-muted-foreground px-2 py-4 text-xs leading-relaxed">
            还没有会话。新建一个，它会拿到自己的分支。
          </p>
        : conversations.map((conversation) => {
            const active = conversation.id === activeSessionId;
            return (
              <Link
                key={conversation.id}
                to="/chat/$conversationId"
                params={{ conversationId: conversation.id }}
                className={cn(
                  'hover:bg-muted flex flex-col gap-0.5 border-l-2 py-1.5 pr-2 pl-2.5 transition-colors',
                  active ?
                    'border-foreground bg-muted'
                  : 'border-transparent opacity-80 hover:opacity-100',
                )}
              >
                <div className="flex items-center gap-1.5">
                  <StatusDot
                    status={conversation.status}
                    provider={conversation.provider}
                  />
                  <span className="truncate text-[0.8125rem] leading-snug">
                    {conversation.title ?? '未命名会话'}
                  </span>
                  {/* 有卡片在等人答（含已[挂起](../../../../../../docs/terms.md)的）——不点进去也看得到。 */}
                  {conversation.pendingDecisions > 0 && (
                    <span
                      className="bg-foreground text-background ml-auto shrink-0 rounded-sm px-1 text-[0.625rem] leading-4"
                      data-testid="waiting-for-you-badge"
                      title={`有 ${String(conversation.pendingDecisions)} 处在等你答复`}
                    >
                      等你
                    </span>
                  )}
                </div>
                <span className="text-muted-foreground truncate pl-3 font-mono text-[0.6875rem]">
                  {/* 本地沙盒没有分支（docs/ingress/tech/unified-demo.md §4.3）——这一行退回只显示 provider。 */}
                  {conversation.branchName !== null &&
                    `${conversation.branchName} · `}
                  {conversation.provider}
                </span>
              </Link>
            );
          })
        }
      </nav>
    </div>
  );
}
