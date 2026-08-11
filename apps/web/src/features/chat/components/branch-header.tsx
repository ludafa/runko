/**
 * 会话页的页眉：**分支是这一页的标题**（docs/app/chat-ui/feature.md「分支是这一页的标题」）。
 *
 * **主位是会话标题，分支名退到行尾。** 这一条改过两次，值得记下为什么：
 *
 * 改版前 H1 是会话标题（衬线斜体）、分支名是角落小字，当时判断层级反了——分支
 * 才是这一页真正在生产的东西（要拿它 `git checkout`、开 PR），于是把分支升成
 * H1。这个判断对**有语义的分支名**成立（`feature/login-fix` 那种，人会去读它、
 * 打它），但这里的分支名是 `nimbo/chat-<uuid>`：没人读得出、记得住，只会被复制。
 * 用版面最大的位置放一串没人读的字符，等于把主位给了噪音；而唯一能一眼认出这
 * 是哪个会话的东西——用户自己起的标题——反被压成行尾最小的灰字。
 *
 * 所以现在：状态点 + 会话标题居左当主位，分支名**中间省略**（`nimbo/chat-8430…5fb1`）
 * 退到行尾，配复制钮——复制才是它的真实用途，阅读不是。仓库名整个删掉：它来自
 * 全局 `GITHUB_REPO`，每个会话都一样，在会话级功能条里是零区分度的噪音。
 *
 * 整条只有一行、底部一条细线与对话流分开；侧栏把手不在这里，在顶栏左端
 * （`AppLayout` 的槽位，见 app-layout.tsx）。
 */
import type { NimboUIMessage } from '@nimbo/core';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

import type { Conversation } from '../schema';
import { ConversationDetailsDialog } from './conversation-details-dialog';
import { StatusDot } from './conversation-status-badge';

const COPIED_RESET_MS = 1600;

/** 短于这个长度就原样显示——`main` / `feature/login-fix` 这类本来就读得懂，没必要省略。 */
const BRANCH_ABBREVIATE_THRESHOLD = 24;
const BRANCH_HEAD_CHARS = 15;
const BRANCH_TAIL_CHARS = 4;

/**
 * `nimbo/chat-84302082-770a-4dd3-aa7f-edcf60125fb1` → `nimbo/chat-8430…5fb1`。
 *
 * 中间省略而不是 CSS `truncate`（那是截尾）：尾号是这串里唯一能区分两条会话
 * 分支的部分，截掉它等于让所有分支名长得一模一样。前缀留着是为了一眼看出这是
 * 条 nimbo 会话分支。复制的始终是完整名字，不是这里显示的缩写。
 */
export function abbreviateBranchName(name: string): string {
  if (name.length <= BRANCH_ABBREVIATE_THRESHOLD) return name;
  return `${name.slice(0, BRANCH_HEAD_CHARS)}…${name.slice(-BRANCH_TAIL_CHARS)}`;
}

export function BranchHeader({
  conversation,
  messages,
}: {
  conversation: Conversation;
  /** 透传给详情弹窗的「统计」tab——会话级用量从账本 metadata 现算，不额外请求。 */
  messages?: readonly NimboUIMessage[];
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => {
      setCopied(false);
    }, COPIED_RESET_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);

  function handleCopy() {
    // 复制失败（无剪贴板权限/非安全上下文）就什么都不发生——分支名就在旁边，
    // 用户随时可以手选，为此弹一条错误提示是过度反应。
    navigator.clipboard.writeText(conversation.branchName).then(
      () => {
        setCopied(true);
      },
      () => {
        /* 见上 */
      },
    );
  }

  return (
    <header className="group border-border flex items-center gap-2 border-b pb-2">
      <StatusDot status={conversation.status} />
      <h1 className="font-label min-w-0 truncate text-[0.9375rem] tracking-normal">
        {conversation.title ?? '未命名会话'}
      </h1>

      {/* 分支名退到行尾：它的用途是复制，不是阅读。 */}
      <div className="text-muted-foreground ml-auto flex shrink-0 items-center gap-1">
        {/* tooltip 而不是原生 `title`：缩写后的 `nimbo/chat-8430…5fb1` 看不出是
            什么，光给全名还是看不出——得先说清「这是 git 分支」，再给全名。 */}
        {/* Provider 就近包一层——项目里没有全局的，ai-elements/message.tsx 也是这么用的 */}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="hidden cursor-default font-mono text-[0.6875rem] sm:inline" />
              }
            >
              {abbreviateBranchName(conversation.branchName)}
            </TooltipTrigger>
            <TooltipContent className="flex flex-col gap-0.5">
              <span className="text-background/70 text-[0.6875rem]">
                这个会话的 git 分支
              </span>
              <span className="font-mono">{conversation.branchName}</span>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={handleCopy}
          className="text-muted-foreground hover:text-foreground shrink-0"
          aria-label={copied ? '分支名已复制' : '复制分支名'}
          title={copied ? '已复制' : '复制分支名'}
        >
          {copied ?
            <CheckIcon className="size-3" aria-hidden="true" />
          : <CopyIcon className="size-3" aria-hidden="true" />}
        </Button>
        <ConversationDetailsDialog
          conversation={conversation}
          messages={messages}
        />
      </div>
    </header>
  );
}
