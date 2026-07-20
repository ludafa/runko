import { Link, useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';

import { authClient } from '../lib/auth-client';

export function AppLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { data: session } = authClient.useSession();

  async function handleSignOut() {
    await authClient.signOut();
    await navigate({ to: '/login' });
  }

  // 应用外壳是「一屏高的 flex 列」：header 定高，main 是唯一的滚动容器。这样文档
  // 本身永远不滚动——此前 min-h-screen + sticky header + 子页面
  // h-[calc(100vh-8rem)] 三者相加比视口高 45px，于是窗口自己也出一条滚动条（和
  // 会话滚动条并排成「双滚动条」），并且能把整页向下拖出一片空白。main 拿到确定
  // 高度后，子页面用 flex-1/min-h-0 撑满即可，不必再猜 header 和内边距的像素数。
  return (
    <div className="bg-background text-foreground flex h-screen flex-col overflow-hidden">
      <header className="border-foreground/8 bg-background/75 z-20 shrink-0 border-b backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3.5 sm:px-8">
          <Link
            to="/"
            className="flex items-baseline gap-1.5 text-base tracking-tight"
          >
            <span className="font-display text-lg leading-none italic">
              hono
            </span>
            <span className="text-muted-foreground/70 leading-none">·</span>
            <span className="text-muted-foreground leading-none lowercase">
              mono
            </span>
          </Link>
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
        <div className="animate-in fade-in slide-in-from-bottom-1 fill-mode-backwards mx-auto flex min-h-full w-full max-w-6xl flex-col px-6 py-10 duration-500 sm:px-8 sm:py-14">
          {children}
        </div>
      </main>
    </div>
  );
}
