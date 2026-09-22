/**
 * [演示模型](../../../../docs/terms.md)：没配模型 key 时的替身。
 *
 * 守两件事：**指令认得准**（`run:` / `ask:` 调对工具），以及**收尾看的是上一条是不是
 * 工具结果**——一轮可能被[挂起](../../../../docs/terms.md)、几小时后在另一个进程里恢复，
 * 那时模型是新造的，按「第几次调用」记数一定会再调一次工具，把人已经批准过的命令又跑一遍。
 */
import { describe, expect, it } from 'vitest';

import { demoStreamFor, parseDemoCommand } from '../../src/agent/demo-model.js';

/** 把一次输出收成数组。 */
async function stream(
  prompt: readonly { role: string; content: unknown }[],
): Promise<Record<string, unknown>[]> {
  const chunks: ReadableStream<Record<string, unknown>> = demoStreamFor(prompt);
  const out: Record<string, unknown>[] = [];
  const reader = chunks.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    out.push(next.value);
  }
  return out;
}

function userMessage(text: string): { role: string; content: unknown }[] {
  return [{ role: 'user', content: [{ type: 'text', text }] }];
}

describe('parseDemoCommand', () => {
  it('认出 run: 与 ask:，前后空格与大小写都不计', () => {
    expect(parseDemoCommand('run: ls -la')).toEqual({
      tool: 'bash',
      argument: 'ls -la',
    });
    expect(parseDemoCommand('  RUN:  echo hi  ')).toEqual({
      tool: 'bash',
      argument: 'echo hi',
    });
    expect(parseDemoCommand('ask: 用 A 还是 B？')).toEqual({
      tool: 'ask-user',
      argument: '用 A 还是 B？',
    });
  });

  it('指令可以写在多行消息里的任意一行', () => {
    expect(parseDemoCommand('帮我看看\nrun: cat README.md\n谢谢')).toEqual({
      tool: 'bash',
      argument: 'cat README.md',
    });
  });

  it('没有指令、或冒号后面是空的 → 不算指令', () => {
    expect(parseDemoCommand('今天天气不错')).toBeUndefined();
    expect(parseDemoCommand('run:')).toBeUndefined();
    expect(parseDemoCommand('这句话里提到 run: 了吗')).toBeUndefined();
  });
});

describe('演示模型这一步产出什么', () => {
  it('run: → 调 bash，命令原样传过去', async () => {
    const chunks = await stream(userMessage('run: rm -rf dist'));
    const toolCall = chunks.find((chunk) => chunk['type'] === 'tool-call');
    expect(toolCall?.['toolName']).toBe('bash');
    expect(toolCall?.['input']).toBe(
      JSON.stringify({ command: 'rm -rf dist' }),
    );
  });

  it('ask: → 调 ask-user，问题原样传过去', async () => {
    const chunks = await stream(userMessage('ask: 要不要继续？'));
    const toolCall = chunks.find((chunk) => chunk['type'] === 'tool-call');
    expect(toolCall?.['toolName']).toBe('ask-user');
    expect(toolCall?.['input']).toBe(
      JSON.stringify({ question: '要不要继续？' }),
    );
  });

  it('没有指令 → 复述一遍，并提示怎么触发工具', async () => {
    const chunks = await stream(userMessage('你好'));
    const text = chunks
      .filter((chunk) => chunk['type'] === 'text-delta')
      .map((chunk) => String(chunk['delta']))
      .join('');
    expect(text).toContain('你好');
    expect(text).toContain('run:');
    expect(chunks.some((chunk) => chunk['type'] === 'tool-call')).toBe(false);
  });

  it('**上一条是工具结果 → 收尾，不再调工具**（恢复轮靠这条不重复执行）', async () => {
    const chunks = await stream([
      ...userMessage('run: ls'),
      { role: 'assistant', content: [] },
      { role: 'tool', content: [] },
    ]);
    expect(chunks.some((chunk) => chunk['type'] === 'tool-call')).toBe(false);
    const finish = chunks.find((chunk) => chunk['type'] === 'finish');
    expect(finish?.['finishReason']).toEqual({
      unified: 'stop',
      raw: undefined,
    });
  });
});
