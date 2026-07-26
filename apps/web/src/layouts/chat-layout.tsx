/**
 * 聊天页外壳：可收起的会话侧栏 + 占满剩余宽度的会话区。
 *
 * 布局用 shadcn `Sidebar`（`SidebarProvider` / `Sidebar` / `SidebarInset`）替掉
 * 原来的 `grid md:grid-cols-[220px_minmax(0,1fr)]`——原来的栅格宽度写死、不能
 * 收起，而聊天页是个工作台：读长代码块、宽表格、文件 diff 时想把左边那 220px
 * 让出来。收起状态由组件自己持久化到 cookie（`sidebar_state`），刷新后保持；
 * `⌘B` / `Ctrl+B` 是它内置的快捷键。
 *
 * `SidebarProvider` 放在这里而不是 `AppLayout`：侧栏是聊天页的东西，Notes 那类
 * 页面共用同一个壳但不该有它。
 */
import { useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import {
  Sidebar,
  SidebarContent,
  SidebarInset,
  SidebarProvider,
} from '@/components/ui/sidebar';
import { createConversation, listConversations } from '@/features/chat/api';
import { SessionList } from '@/features/chat/components/conversation-list';
import {
  ProvisioningError,
  ProvisioningView,
} from '@/features/chat/components/provisioning-view';
import type {
  Conversation,
  ConversationProvider,
} from '@/features/chat/schema';
import { HeaderSidebarTrigger } from '@/layouts/app-layout';

/** 一次建会话请求：从点击那一刻起就存在，不等服务端。 */
interface PendingCreate {
  title: string;
  provider: ConversationProvider;
  startedAt: number;
}

export function ChatLayout({
  children,
  activeSessionId,
}: {
  children: ReactNode;
  activeSessionId: string | undefined;
}) {
  const navigate = useNavigate();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  // 「建会话中」不再只是一个 boolean：会话区要立刻显示是哪个会话在准备、准备了
  // 多久，失败后还要能原样重试，所以整份输入都留着。
  const [pending, setPending] = useState<PendingCreate | undefined>(undefined);
  const [failed, setFailed] = useState<
    { input: PendingCreate; message: string } | undefined
  >(undefined);

  useEffect(() => {
    const controller = new AbortController();
    listConversations(controller.signal)
      .then(setConversations)
      .catch(() => {
        /* left as an empty list; SessionList already handles the empty state */
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  async function runCreate(input: PendingCreate) {
    // 点击的同一帧就切到准备中视图——不等 201。建一个会话要开沙盒 + clone +
    // 装 skill + 建分支（实测 9 秒起），干等一个静止的按钮是这次要修的。
    setFailed(undefined);
    setPending(input);
    try {
      const conversation = await createConversation({
        ...(input.title.length > 0 ? { title: input.title } : {}),
        provider: input.provider,
      });
      setConversations((prev) => [conversation, ...prev]);
      setPending(undefined);
      await navigate({
        to: '/chat/$conversationId',
        params: { conversationId: conversation.id },
      });
    } catch (error) {
      // 此前这里没有 catch，只有 finally：请求一挂错误就被吞掉，按钮弹回可点、
      // 界面毫无变化，用户只会以为自己没点上。
      setPending(undefined);
      setFailed({
        input,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function handleCreate(title: string, provider: ConversationProvider) {
    void runCreate({ title, provider, startedAt: Date.now() });
  }

  // 准备中/失败都要占住会话区（children 是上一个会话或空态，留着会让人以为没点上）。
  const sessionArea =
    pending !== undefined ?
      // key: 重试是一次新的等待，重挂让计时从 0 开始（见 ProvisioningView 的 useElapsedMs）
      <ProvisioningView
        key={pending.startedAt}
        title={pending.title}
        provider={pending.provider}
        startedAt={pending.startedAt}
      />
    : failed !== undefined ?
      <ProvisioningError
        title={failed.input.title}
        message={failed.message}
        onRetry={() => {
          void runCreate({ ...failed.input, startedAt: Date.now() });
        }}
        onDismiss={() => {
          setFailed(undefined);
        }}
      />
    : children;

  return (
    <SidebarProvider
      // shadcn 的 Sidebar 默认假设自己是**整页**布局：wrapper 撑 `min-h-svh`、
      // 侧栏本体是 `fixed inset-y-0 h-svh`。但这里它装在 AppLayout 的 main 里、
      // 上面还有一条 header，照搬会让侧栏顶到视口顶端、被 header 盖掉标题和
      // 「新会话」。所以把它就地化：wrapper 改 `relative` 提供定位上下文 +
      // `!min-h-full` 吃掉 main 给的确定高度（而不是自己撑一屏，那会顶出第二条
      // 滚动条——正是 app-layout.tsx 注释里记的那个「双滚动条」旧账）。
      className="relative !min-h-full min-h-0 flex-1 overflow-hidden"
    >
      {/* absolute + h-full 覆盖组件默认的 fixed + h-svh，让它相对上面那个 wrapper 定位 */}
      <Sidebar collapsible="offcanvas" className="absolute h-full">
        <SidebarContent className="p-2">
          {loading ?
            <p className="text-muted-foreground px-1 py-4 text-xs">加载中…</p>
          : <SessionList
              conversations={conversations}
              activeSessionId={activeSessionId}
              onCreate={handleCreate}
              pendingTitle={pending?.title}
            />
          }
        </SidebarContent>
      </Sidebar>

      <HeaderSidebarTrigger />

      <SidebarInset className="min-h-0 min-w-0 overflow-hidden px-4 py-3 sm:px-6">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
          {sessionArea}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
