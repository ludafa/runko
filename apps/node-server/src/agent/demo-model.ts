/**
 * [演示模型](../../../../docs/terms.md)——没配模型 key 时的替身。不联网、不花钱。
 *
 * 它存在的理由：这个应用要能**零配置跑起来**。没有它，clone 下来的人第一句话就撞上
 * 「请先配 DEEPSEEK_API_TOKEN」，审批、提问、挂起、排队这些真正要展示的东西一个都看不到。
 *
 * **它不冒充 AI，按指令办事**：
 *
 * | 你发的消息里有 | 它做什么 |
 * |---|---|
 * | `run: <命令>` | 调 bash 跑这条命令，拿到结果再说一句话收尾 |
 * | `ask: <问题>` | 调 ask-user 问你这个问题 |
 * | 都没有 | 把你的话复述一遍，一小段一小段地流出来 |
 *
 * **每一步看的是「上一条是不是工具结果」，不是调用次数**：一轮可能被[挂起](../../../../docs/terms.md)、
 * 几小时后在另一个进程里[恢复](../../../../docs/terms.md)，那时模型是新造的，计数从零开始。
 * 看提示词的最后一条就没有这个问题——是工具结果就收尾，不会又调一次工具。
 */
import { randomUUID } from 'node:crypto';

import type { LanguageModel } from 'ai';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

/** 假的用量数字：账本里那一行 metadata 要有值，看起来才像一次真的调用。 */
const USAGE = {
  inputTokens: {
    total: 8,
    noCache: 8,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 4, text: 4, reasoning: undefined },
} as const;

/** 复述时每小段之间的间隔（毫秒）。留着可调是为了让一轮能跑得足够久——多副本测试要在中途杀进程。 */
function chunkDelayMs(): number {
  const raw = process.env.CHAT_DEMO_DELAY_MS?.trim();
  if (raw === undefined || raw.length === 0) {
    return 30;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30;
}

/** 指令：一行以 `run:` 或 `ask:` 开头（前后空格不计，大小写不计）。 */
interface DemoCommand {
  tool: 'bash' | 'ask-user';
  argument: string;
}

export function parseDemoCommand(text: string): DemoCommand | undefined {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    const lower = trimmed.toLowerCase();
    if (lower.startsWith('run:')) {
      const argument = trimmed.slice('run:'.length).trim();
      if (argument.length > 0) {
        return { tool: 'bash', argument };
      }
    }
    if (lower.startsWith('ask:')) {
      const argument = trimmed.slice('ask:'.length).trim();
      if (argument.length > 0) {
        return { tool: 'ask-user', argument };
      }
    }
  }
  return undefined;
}

/**
 * 从提示词里取出**最后一条用户消息**的文字。
 *
 * 逐层判形状而不是断言：这串东西由 AI SDK 组装，内容部件的形状随版本演化，认不出来就当
 * 没有文字（模型退回复述空串），不该让一轮崩在这里。
 */
function lastUserText(
  prompt: readonly { role: string; content: unknown }[],
): string {
  for (let index = prompt.length - 1; index >= 0; index -= 1) {
    const message = prompt[index];
    if (message === undefined || message.role !== 'user') {
      continue;
    }
    const { content } = message;
    if (typeof content === 'string') {
      return content;
    }
    if (!Array.isArray(content)) {
      return '';
    }
    const texts: string[] = [];
    for (const part of content) {
      if (
        typeof part === 'object' &&
        part !== null &&
        'type' in part &&
        part.type === 'text' &&
        'text' in part &&
        typeof part.text === 'string'
      ) {
        texts.push(part.text);
      }
    }
    return texts.join('\n');
  }
  return '';
}

/** 把一段话切成小块，好让它一小段一小段地流出来。 */
function chunksOf(text: string, size = 12): string[] {
  const pieces: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    pieces.push(text.slice(index, index + size));
  }
  return pieces.length > 0 ? pieces : [''];
}

function textStream(text: string): ReadableStream {
  const deltas = chunksOf(text).map((delta) => ({
    type: 'text-delta' as const,
    id: 't1',
    delta,
  }));
  return simulateReadableStream({
    chunks: [
      { type: 'stream-start' as const, warnings: [] },
      { type: 'text-start' as const, id: 't1' },
      ...deltas,
      { type: 'text-end' as const, id: 't1' },
      {
        type: 'finish' as const,
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: USAGE,
      },
    ],
    initialDelayInMs: null,
    chunkDelayInMs: chunkDelayMs(),
  });
}

function toolCallStream(
  tool: 'bash' | 'ask-user',
  argument: string,
): ReadableStream {
  const input =
    tool === 'bash' ? { command: argument } : { question: argument };
  return simulateReadableStream({
    chunks: [
      { type: 'stream-start' as const, warnings: [] },
      {
        type: 'tool-call' as const,
        toolCallId: `call-${randomUUID()}`,
        toolName: tool,
        input: JSON.stringify(input),
      },
      {
        type: 'finish' as const,
        finishReason: { unified: 'tool-calls' as const, raw: undefined },
        usage: USAGE,
      },
    ],
    initialDelayInMs: null,
    chunkDelayInMs: null,
  });
}

const HINT =
  '（这是演示模型，没配模型 key。想看工具调用就发 "run: ls -la"，想看提问卡片就发 "ask: 你的问题"。）';

/**
 * 这一步该产出什么。**单独一个函数**，测试直接喂提示词给它，不必绕过 AI SDK 的类型去
 * 拼一次假调用。
 */
export function demoStreamFor(
  prompt: readonly { role: string; content: unknown }[],
): ReadableStream {
  // 上一条是工具结果 = 这次调用已经有人答过了：说一句收尾，别再调一次工具。
  if (prompt.at(-1)?.role === 'tool') {
    return textStream('好了，上面那步的结果我拿到了。');
  }
  const text = lastUserText(prompt);
  const command = parseDemoCommand(text);
  if (command !== undefined) {
    return toolCallStream(command.tool, command.argument);
  }
  return textStream(text.length > 0 ? `你说：${text}\n\n${HINT}` : HINT);
}

export function createDemoModel(): LanguageModel {
  return new MockLanguageModelV4({
    doStream: ({ prompt }) =>
      Promise.resolve({ stream: demoStreamFor(prompt) }),
  });
}
