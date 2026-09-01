import { Link, useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { createContext, useContext, useState } from 'react';
import { createPortal } from 'react-dom';

import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { NotificationBell } from '@/features/notifications/notification-bell';

import { authClient } from '../lib/auth-client';

/**
 * header 左端的槽位：页面把自己的控件 portal 进来。`null` = 还没挂载/本页没有
 * header（`/design` 自带一份同构的，见 design-preview.tsx）。
 */
const HeaderLeadingSlotContext = createContext<HTMLElement | null>(null);

/** 提供槽位 DOM 给子树。用 `ref` 回调而不是 effect 里 `getElementById`：回调在 DOM 挂载时同步触发，没有「首帧空一下」，也不触发 `react-hooks/set-state-in-effect`。 */
export function useHeaderLeadingSlot(): [
  HTMLElement | null,
  (node: HTMLElement | null) => void,
] {
  return useState<HTMLElement | null>(null);
}

export const HeaderLeadingSlot = HeaderLeadingSlotContext;

/**
 * 把侧栏把手渲染进 header 左端。**必须在 `SidebarProvider` 内部调用。**
 *
 * 位置的理由：把手原本夹在侧栏与会话区之间，两边都不属——功能条的下划线从它
 * 右边才开始，看着像块飞来的浮标；而 header 本就是全局控件区，放那儿它有归属，
 * 且展开/收起时位置恒定（跟着侧栏走会让肌肉记忆失效）。
 *
 * 用 portal 而不是把 `SidebarProvider` 提到这里：侧栏在语义上属于聊天页，Notes
 * 那类页面不该被塞一个空 provider（还会白占 `⌘B`）。React 的 portal 保留 React
 * 树，所以 portal 出去的 `SidebarTrigger` 照样拿得到调用处的 sidebar context。
 */
export function HeaderSidebarTrigger() {
  const slot = useContext(HeaderLeadingSlotContext);

  if (slot === null) {
    return null;
  }
  return createPortal(
    <SidebarTrigger className="text-muted-foreground hover:text-foreground -ml-1.5" />,
    slot,
  );
}

export function AppLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { data: session } = authClient.useSession();
  const [headerSlot, setHeaderSlot] = useHeaderLeadingSlot();

  async function handleSignOut() {
    await authClient.signOut();
    await navigate({ to: '/login' });
  }

  // 应用外壳是「一屏高的 flex 列」：header 定高，main 是唯一的滚动容器。这样文档
  // 本身永远不滚动——此前 min-h-screen + sticky header + 子页面
  // h-[calc(100vh-8rem)] 三者相加比视口高 45px，于是窗口自己也出一条滚动条（和
  // 会话滚动条并排成「双滚动条」），并且能把整页向下拖出一片空白。main 拿到确定
  // 高度后，子页面用 flex-1/min-h-0 撑满即可，不必再猜 header 和内边距的像素数。
  //
  // **宽度归页面自己管**（原来这里写死 `mx-auto max-w-6xl px-6 py-10`）：聊天页要
  // 占满整屏——它是个工作台，左边会话列表右边时间线，1440px 屏上被夹在 1152px 里
  // 两侧各空 144px，而中间的代码块和表格反而在横向滚动。但同一个壳还装着 Notes 这
  // 类读文档的页面，那里满宽的长文本行反而难读。一刀切去掉约束会伤后者，所以约束
  // 下放：`DashboardPage` 自己包 `mx-auto max-w-6xl`，聊天页不包即满宽。
  return (
    <div className="bg-background text-foreground flex h-screen flex-col overflow-hidden">
      <header className="bg-background/80 z-20 shrink-0 border-b backdrop-blur-xl">
        <div className="flex items-center justify-between gap-2 px-4 py-3 sm:px-6">
          {/* 槽位与 logo 同属「左端」一组，`justify-between` 才仍是三段（左 / 导航 /
              账号）——不包一层的话槽位会变成第四段、把 logo 挤到中间去。 */}
          <div className="flex items-center gap-2">
            {/* 页面级控件的挂载点：聊天页把侧栏把手 portal 进来（chat-layout.tsx）。
                header 本就是放全局控件的地方——把手夹在侧栏与会话区的缝隙里时两边
                都不属，收起/展开还会跟着位移；放这儿它位置恒定。`empty:hidden` 让
                没人往里放东西的页面（Notes）的 header 与从前逐像素一致。 */}
            <div
              ref={setHeaderSlot}
              className="flex items-center empty:hidden"
            />
            {/* 脚手架留下的 `hono · mono` 换成这个应用自己的身份。 */}
            <Link
              to="/"
              className="flex items-baseline gap-1.5 font-mono text-sm"
            >
              <span className="font-medium">nimbo</span>
              <span className="text-muted-foreground/50">/</span>
              <span className="text-muted-foreground">chat</span>
            </Link>
          </div>
          <nav className="flex items-center gap-4 text-sm">
            <Link
              to="/chat"
              className="text-muted-foreground hover:text-foreground [&.active]:text-foreground transition-colors"
            >
              Chat
            </Link>
          </nav>
          <div className="flex items-center gap-2 sm:gap-3">
            {session?.user && (
              <span className="text-muted-foreground hidden text-xs sm:inline">
                {session.user.email}
              </span>
            )}
            {/* 推送开关（docs/features/push-notification.md §3.1）。放在主题键
                左边、只在登录后显示——订阅是挂在人身上的，未登录时点它没有意义。
                服务端没配 VAPID 时它自己什么都不渲染。 */}
            {session?.user && <NotificationBell />}
            <ThemeToggle />
            {session?.user && (
              <Button variant="outline" size="sm" onClick={handleSignOut}>
                Sign out
              </Button>
            )}
          </div>
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {/* min-h-full（而不是 flex-1）是刻意的，它同时满足两类页面：
            · 普通页面（如 Notes）内容超过一屏时照常把 main 撑高、由 main 滚动；
              若写成 flex-1，子元素会被 flex 压缩成一屏高而不是滚动。
            · 聊天页把栅格设为 flex-1 + min-h-0，其假想高度为 0，于是这里由
              min-h-full 兜底成恰好一屏，栅格再撑满——拿到确定高度，内部滚动生效。*/}
        <div className="animate-in fade-in slide-in-from-bottom-1 fill-mode-backwards flex min-h-full w-full flex-col duration-500">
          <HeaderLeadingSlot value={headerSlot}>{children}</HeaderLeadingSlot>
        </div>
      </main>
    </div>
  );
}
