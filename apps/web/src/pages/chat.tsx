import { ChatLayout } from '@/layouts/chat-layout';

export function ChatIndexPage() {
  return (
    <ChatLayout activeSessionId={undefined}>
      <div className="border-foreground/10 text-muted-foreground flex flex-col items-start gap-2 rounded-2xl border border-dashed px-6 py-10">
        <p className="font-display text-foreground text-2xl leading-tight italic">
          选择或新建一个会话
        </p>
        <p className="text-sm">
          从左侧列表选一个已有会话，或者用上面的输入框新建一个。
        </p>
      </div>
    </ChatLayout>
  );
}
