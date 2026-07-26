import { ChatLayout } from '@/layouts/chat-layout';

export function ChatIndexPage() {
  return (
    <ChatLayout activeSessionId={undefined}>
      <div className="flex flex-col items-start gap-2 pt-2">
        <p className="text-muted-foreground text-[0.6875rem] font-medium tracking-[0.02em]">
          没有打开的会话
        </p>
        <p className="text-foreground text-base">
          从左边挑一个会话，或者新建一个。
        </p>
        <p className="text-muted-foreground max-w-[52ch] text-sm leading-relaxed">
          每个会话独占一条分支和一个沙盒，多轮改动在同一条分支上累积。
        </p>
      </div>
    </ChatLayout>
  );
}
