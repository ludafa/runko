/**
 * `streaming` 不禁用输入框——一[轮](../../../../../docs/terms.md)进行中照样能发消息，
 * 只是多了一个「去哪」的选择（docs/features/steer-and-queue.md §2）：
 *
 * - **Enter = [排队](../../../../../docs/terms.md)**（默认）：不打扰当前这一轮，
 *   本轮收尾后由服务端自动作为下一轮发出。
 * - **Alt/Option + Enter，或工具条上的插话按钮 = [steer 中途插话](../../../../../docs/terms.md)**：
 *   注入当前这一轮，在下一个 step 边界生效。
 *
 * 没有进行中的一轮时两条路没有分别（服务端都会起新一轮），所以插话按钮只在
 * `streaming` 时出现——空闲时界面回到「一个输入框 + 一个发送键」的最简形态。
 *
 * **发送键在 `streaming` 时是[停止](../../../../../docs/terms.md)键**（方块图标，
 * docs/tech/turn-abort.md §4.2）：点它停止这一轮。所以流式期间那颗按钮**不再**是排队
 * 入口——排队走 Enter、插话走 ⌥⏎/插话按钮，placeholder 里明说了这两条。两处易踩的细节：
 * `type` 必须显式改成 `button`（默认 `submit` 会被 `PromptInput` 的 form 提交吃掉，
 * 那条路是排队），`disabled` 换成 `stopping`（流式期间输入框里有字也要能停）。
 *
 * 外壳是 ai-elements 的 `PromptInput`（InputGroup：输入区 + 底部工具条）。它的
 * `onSubmit` 给的是 `PromptInputMessage`（带附件），本应用不用附件，只取 `text`。
 * 键盘处理走 textarea 的 `onKeyDown` 而不是 PromptInput 自己的——因为要区分
 * Alt+Enter，官方那套只认 Enter/Shift+Enter。
 */
import { ZapIcon } from 'lucide-react';
import { useState } from 'react';

import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTools,
} from '@/components/ai-elements/prompt-input';
import type { SkillSummary } from '@/features/chat/schema';
import type { SendIntent } from '@/features/chat/use-chat-messages';

import { ComposerEditor } from './composer-editor';

export function MessageComposer({
  onSend,
  onStop,
  streaming,
  stopping = false,
  skills = [],
}: {
  onSend: (text: string, intent: SendIntent) => void;
  /** 停止这一轮（`streaming` 时那颗按钮的语义）——见文件头。 */
  onStop: () => void;
  streaming: boolean;
  /** 已按下停止、还没真正停住：按钮进禁用态，避免连点。 */
  stopping?: boolean;
  /**
   * 这个会话可选的 [skill 清单](../../../../../docs/terms.md)——打 `/` 时列的就是它
   * （docs/features/composer-skill-mention.md）。缺省空数组：清单没到（或这个会话
   * 一个 skill 都没装）时 `/` 就是个普通斜杠，composer 一切照旧。
   */
  skills?: readonly SkillSummary[];
}) {
  const [text, setText] = useState('');
  const empty = text.trim().length === 0;

  function submit(intent: SendIntent) {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    onSend(trimmed, intent);
    setText('');
  }

  return (
    <PromptInput
      onSubmit={() => {
        submit('queue');
      }}
    >
      <PromptInputBody>
        {/*
          输入区是 tiptap 而不是 ai-elements 的 `PromptInputTextarea`
          （docs/tech/composer-skill-mention.md §2.4）——换引擎只为拿到 skill 提及
          那枚原子标记块，打字体验仍是纯文本档。Enter/⌥⏎/Shift+Enter 三条键位由
          `ComposerEditor` 内部的快捷键扩展接管，语义与换引擎之前逐条一致。
        */}
        <ComposerEditor
          value={text}
          onChange={setText}
          onSubmit={submit}
          skills={skills}
          placeholder={
            streaming ?
              '本轮进行中——Enter 排到下一轮，⌥⏎ 插进本轮'
            : '让 agent 做点什么…'
          }
        />
      </PromptInputBody>
      <PromptInputFooter>
        <PromptInputTools>
          {streaming && (
            <PromptInputButton
              onClick={() => {
                submit('steer');
              }}
              disabled={empty}
              title="插入当前这一轮，在下一个 step 边界生效"
              aria-label="插入当前轮"
            >
              <ZapIcon className="size-3.5" aria-hidden="true" />
              插话
              <span className="text-muted-foreground font-mono text-[0.6875rem]">
                ⌥⏎
              </span>
            </PromptInputButton>
          )}
        </PromptInputTools>
        {streaming ?
          <PromptInputSubmit
            type="button"
            status="streaming"
            onClick={onStop}
            disabled={stopping}
            aria-label="停止本轮"
            title="停止这一轮（待发队列会一起清空）"
          />
        : <PromptInputSubmit disabled={empty} aria-label="发送" />}
      </PromptInputFooter>
    </PromptInput>
  );
}
