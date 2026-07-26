/**
 * 推理块——直接用 ai-elements 的 `Reasoning`：它自带「流式时自动展开、结束后
 * 自动收起、显示思考了多少秒」这套行为，正是这里原本手写的那一套（原实现的
 * 三段式 effect 注释见 git 历史）。
 *
 * 唯一的本地化：`ReasoningTrigger` 的默认文案是英文（Thinking… / Thought for
 * N seconds），用它的 `getThinkingMessage` 勾子换成中文，不改组件本体。
 */
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from '@/components/ai-elements/reasoning';
import { Shimmer } from '@/components/ai-elements/shimmer';

function thinkingMessage(isStreaming: boolean, duration?: number) {
  if (isStreaming || duration === 0)
    return <Shimmer duration={1}>思考中…</Shimmer>;
  if (duration === undefined) return <p>思考过程</p>;
  return <p>思考了 {duration} 秒</p>;
}

export function ReasoningBlock({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  return (
    <Reasoning isStreaming={streaming} className="mb-2 w-full">
      <ReasoningTrigger getThinkingMessage={thinkingMessage} />
      <ReasoningContent>{text}</ReasoningContent>
    </Reasoning>
  );
}
