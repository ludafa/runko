import { describe, expect, it } from 'vitest';

import { consumeSSEStream, SSEStreamParser } from '../sse';

describe('SSEStreamParser', () => {
  it('parses a single complete message delivered in one chunk', () => {
    const parser = new SSEStreamParser();
    const messages = parser.push('data: {"seq":1}\n\n');
    expect(messages).toEqual([{ data: '{"seq":1}' }]);
  });

  it('parses a message whose line is split across two chunks (cross-chunk boundary)', () => {
    const parser = new SSEStreamParser();
    expect(parser.push('data: {"se')).toEqual([]);
    const messages = parser.push('q":1}\n\n');
    expect(messages).toEqual([{ data: '{"seq":1}' }]);
  });

  it('parses a message whose terminating blank line is itself split across chunks', () => {
    const parser = new SSEStreamParser();
    expect(parser.push('data: hello\n')).toEqual([]);
    const messages = parser.push('\n');
    expect(messages).toEqual([{ data: 'hello' }]);
  });

  it('joins multiple `data:` lines with `\\n` (multi-line data)', () => {
    const parser = new SSEStreamParser();
    const messages = parser.push('data: line one\ndata: line two\n\n');
    expect(messages).toEqual([{ data: 'line one\nline two' }]);
  });

  it('handles multiple complete messages arriving in one chunk', () => {
    const parser = new SSEStreamParser();
    const messages = parser.push('data: {"seq":1}\n\ndata: {"seq":2}\n\n');
    expect(messages).toEqual([{ data: '{"seq":1}' }, { data: '{"seq":2}' }]);
  });

  it('ignores comment lines (leading colon) and keeps the `event`/`id` fields sticky per message', () => {
    const parser = new SSEStreamParser();
    const messages = parser.push(
      ':heartbeat\nevent: turn\nid: 7\ndata: {"seq":1}\n\ndata: {"seq":2}\n\n',
    );
    expect(messages).toEqual([
      { data: '{"seq":1}', event: 'turn', id: '7' },
      // `id` is sticky across messages per the SSE spec (this stream never resets it); `event` isn't re-sent so it's gone.
      { data: '{"seq":2}', id: '7' },
    ]);
  });

  it('strips exactly one leading space after the field colon, not more', () => {
    const parser = new SSEStreamParser();
    const messages = parser.push('data:  two leading spaces\n\n');
    expect(messages).toEqual([{ data: ' two leading spaces' }]);
  });

  it('drops an event with no `data:` lines at all (blank-line-only dispatch)', () => {
    const parser = new SSEStreamParser();
    const messages = parser.push('event: ping\n\n');
    expect(messages).toEqual([]);
  });

  it('normalizes CRLF and lone CR line endings the same as LF', () => {
    const parser = new SSEStreamParser();
    const messages = parser.push('data: a\r\ndata: b\r\n\r\n');
    expect(messages).toEqual([{ data: 'a\nb' }]);
  });
});

describe('consumeSSEStream', () => {
  function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let index = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(chunks[index]));
        index += 1;
      },
    });
  }

  it('drains a stream whose chunk boundaries split lines arbitrarily, in order', async () => {
    const received: string[] = [];
    await consumeSSEStream(
      streamFromChunks(['data: {"se', 'q":1}\n', '\ndata: {"seq"', ':2}\n\n']),
      (message) => {
        received.push(message.data);
      },
    );
    expect(received).toEqual(['{"seq":1}', '{"seq":2}']);
  });
});
