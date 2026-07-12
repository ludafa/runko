/**
 * Minimal `text/event-stream` parser (WHATWG EventSource algorithm, `data`/
 * `event`/`id` fields — `retry` is irrelevant to a one-shot POST stream and
 * dropped). docs/08 §2.3: kubb's generated client doesn't cover SSE, so the
 * chat message endpoint is consumed with a hand-rolled `fetch` +
 * `ReadableStream` reader; this module is the incremental line/event
 * splitter that reader feeds into, chunk by chunk. It must not assume a
 * chunk boundary ever lines up with a line or event boundary — `fetch`'s
 * stream can split anywhere, including mid `\r\n`.
 */

export interface SSEMessage {
  event?: string;
  id?: string;
  data: string;
}

export class SSEStreamParser {
  private buffer = '';
  private dataLines: string[] = [];
  private eventName: string | undefined = undefined;
  private lastId: string | undefined = undefined;

  /** Feeds one more decoded text chunk; returns every complete message the chunk completed (zero or more). */
  push(chunk: string): SSEMessage[] {
    this.buffer += chunk;
    const messages: SSEMessage[] = [];
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      if (match === null) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      if (line.length === 0) {
        const message = this.dispatch();
        if (message !== undefined) messages.push(message);
        continue;
      }
      this.processLine(line);
    }
    return messages;
  }

  private processLine(line: string): void {
    if (line.startsWith(':')) return; // comment line, ignored per spec
    const colonIndex = line.indexOf(':');
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
    let value = colonIndex === -1 ? '' : line.slice(colonIndex + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        this.eventName = value;
        break;
      case 'data':
        this.dataLines.push(value);
        break;
      case 'id':
        this.lastId = value;
        break;
      default:
        break; // "retry" and any unknown field: not needed for this one-shot stream
    }
  }

  private dispatch(): SSEMessage | undefined {
    if (this.dataLines.length === 0) {
      this.eventName = undefined;
      return undefined;
    }
    const data = this.dataLines.join('\n');
    const message: SSEMessage = {
      data,
      ...(this.eventName !== undefined ? { event: this.eventName } : {}),
      ...(this.lastId !== undefined ? { id: this.lastId } : {}),
    };
    this.dataLines = [];
    this.eventName = undefined;
    return message;
  }
}

/**
 * Drains a `ReadableStream<Uint8Array>` body through an `SSEStreamParser`,
 * calling `onMessage` for every complete SSE message as it completes.
 * `TextDecoder`'s `{ stream: true }` mode handles multi-byte UTF-8
 * characters split across chunk boundaries (a second, lower-level boundary
 * than the line splitting `SSEStreamParser` does).
 */
export async function consumeSSEStream(
  body: ReadableStream<Uint8Array>,
  onMessage: (message: SSEMessage) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SSEStreamParser();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const message of parser.push(chunk)) onMessage(message);
    }
  } finally {
    reader.releaseLock();
  }
}
