import { Loader2Icon, SendIcon } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

/**
 * `streaming` no longer disables the composer (STEER-3B, docs/tech/chat-webapp.md §2.2
 * "契约细化" #3): a send while a turn is already in progress steers it
 * instead of starting a new one (`use-chat-messages.ts`'s `sendMessage`
 * picks the branch — this component doesn't need to know which). The
 * placeholder is the one piece of UI that still reacts to `streaming`,
 * following the icon swap that already existed — signaling "this inserts
 * into the current turn" rather than adding a new, separate hint element.
 */
export function MessageComposer({
  onSend,
  streaming,
}: {
  onSend: (text: string) => void;
  streaming: boolean;
}) {
  const [text, setText] = useState('');

  function submit() {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    onSend(trimmed);
    setText('');
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    submit();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="border-foreground/10 bg-card/70 flex items-end gap-2 rounded-2xl border p-3"
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={2}
        placeholder={
          streaming ?
            '插入到当前回合…（Enter 发送，Shift+Enter 换行）'
          : '给 agent 发消息…（Enter 发送，Shift+Enter 换行）'
        }
        className="placeholder:text-muted-foreground w-full flex-1 resize-none border-0 bg-transparent py-1.5 text-sm leading-relaxed focus:ring-0 focus:outline-none"
      />
      <Button
        type="submit"
        size="icon"
        disabled={text.trim().length === 0}
        aria-label="发送"
      >
        {streaming ?
          <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
        : <SendIcon className="size-4" aria-hidden="true" />}
      </Button>
    </form>
  );
}
