/**
 * 界面语言工作台的页面本体（路由见 `routes/design.tsx`）。
 *
 * 刻意**不**复用 `ConversationPage`：那条路径要连服务端、要登录态、要真沙盒。
 * 这里只组装同一批展示组件 + 固定假数据，保证「看到的就是组件本身长什么样」。
 */
import { ThemeToggle } from '@/components/theme-toggle';
import {
  Sidebar,
  SidebarContent,
  SidebarInset,
  SidebarProvider,
} from '@/components/ui/sidebar';
import { BranchHeader } from '@/features/chat/components/branch-header';
import { SessionList } from '@/features/chat/components/conversation-list';
import { MessageComposer } from '@/features/chat/components/message-composer';
import { QueuedMessages } from '@/features/chat/components/queued-messages';
import { TimelineView } from '@/features/chat/components/timeline-view';
import {
  previewConversations,
  previewFailedMessages,
  previewMessages,
  previewPendingEchoes,
  previewQueue,
  previewShutdownInterruptedMessages,
  previewSkills,
  previewStoppedMessages,
} from '@/features/chat/fixtures/design-preview-data';
import {
  HeaderLeadingSlot,
  HeaderSidebarTrigger,
  useHeaderLeadingSlot,
} from '@/layouts/app-layout';

function noop(): void {
  /* 工作台里所有交互都是空转——这里只看样子 */
}

export function DesignPreviewPage() {
  const active = previewConversations[0];
  const [headerSlot, setHeaderSlot] = useHeaderLeadingSlot();

  return (
    <div className="bg-background text-foreground flex h-screen flex-col overflow-hidden">
      <header className="bg-background/80 z-20 shrink-0 border-b backdrop-blur-xl">
        <div className="flex items-center justify-between gap-2 px-4 py-3 sm:px-6">
          {/* 与 AppLayout 同构：槽位 + logo 同属左端一组（见 app-layout.tsx） */}
          <div className="flex items-center gap-2">
            <div
              ref={setHeaderSlot}
              className="flex items-center empty:hidden"
            />
            <span className="flex items-baseline gap-1.5 font-mono text-sm">
              <span className="font-medium">runko</span>
              <span className="text-muted-foreground/50">/</span>
              <span className="text-muted-foreground">design</span>
            </span>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {/* 外壳与 ChatLayout 保持同构（可收侧栏 + 满宽会话区），否则这个工作台就
            照不出真实页面的布局了——它的用途正是「对着它迭代」。 */}
        <HeaderLeadingSlot value={headerSlot}>
          <SidebarProvider className="relative !min-h-full min-h-0 flex-1 overflow-hidden">
            <Sidebar collapsible="offcanvas" className="absolute h-full">
              <SidebarContent className="p-2">
                <SessionList
                  conversations={previewConversations}
                  activeSessionId={active.id}
                  onCreate={noop}
                  pendingTitle={undefined}
                />
              </SidebarContent>
            </Sidebar>

            <HeaderSidebarTrigger />

            <SidebarInset className="min-h-0 min-w-0 overflow-hidden px-4 py-3 sm:px-6">
              <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
                <BranchHeader
                  conversation={active}
                  messages={[...previewMessages, ...previewFailedMessages]}
                />

                <div className="flex min-h-0 flex-1 flex-col">
                  <TimelineView
                    messages={[
                      ...previewMessages,
                      ...previewFailedMessages,
                      ...previewStoppedMessages,
                      ...previewShutdownInterruptedMessages,
                    ]}
                    pendingUserEchoes={previewPendingEchoes}
                    // 「已发出、第一帧还没到」那一档也摆进工作台——这个页面的职责就是
                    // 「每一档界面状态都在同一屏」，新增一档不挂上去等于让它失效。
                    awaitingFirstEvent
                    conversationId={active.id}
                  />
                </div>

                <div className="flex flex-col">
                  <QueuedMessages
                    messages={previewQueue}
                    onRemove={noop}
                    onPromote={noop}
                    onClear={noop}
                    streaming
                  />
                  <MessageComposer
                    onSend={noop}
                    onStop={noop}
                    streaming
                    skills={previewSkills}
                  />
                </div>
              </div>
            </SidebarInset>
          </SidebarProvider>
        </HeaderLeadingSlot>
      </main>
    </div>
  );
}
