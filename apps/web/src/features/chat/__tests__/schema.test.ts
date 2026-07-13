import { describe, expect, it } from 'vitest';

import { parseChatStreamEnvelope, sessionItemSchema } from '../schema';

/**
 * Regression coverage for the local-review Finding 3 fix: `sessionItemSchema`
 * here (this file's own wire-level mirror of `@nimbo/core`'s `SessionItem` —
 * see schema.ts's header comment for why it can't just import a zod schema
 * from core) used to be missing the `user_message` variant `Session.steer()`
 * (docs/02-tech-spec.md §4.2) added — a `user_message` item arriving over
 * `GET .../events` replay, or live via SSE, would fail `.parse()`/`.safeParse()`
 * and either throw (an unhandled envelope) or get silently dropped via
 * `onParseError` (api.ts), never rendering. The `_sessionItemSchemaCoversAllVariants`
 * compile-time check now guards against this drifting again; these are the
 * runtime-level regression tests for the specific bug that motivated it.
 */
describe('schema: sessionItemSchema', () => {
  it('parses a user_message item (steer()-injected mid-turn message)', () => {
    const parsed = sessionItemSchema.parse({
      id: 'u1',
      type: 'user_message',
      text: '补充：也顺便检查一下 API 超时时间',
    });
    expect(parsed).toEqual({
      id: 'u1',
      type: 'user_message',
      text: '补充：也顺便检查一下 API 超时时间',
    });
  });
});

describe('schema: parseChatStreamEnvelope', () => {
  it('parses an SSE data: payload whose item.completed event carries a user_message item — the direct regression for a steered turn failing to parse/render', () => {
    const raw = JSON.stringify({
      seq: 4,
      event: {
        type: 'item.completed',
        item: {
          id: 'u1',
          type: 'user_message',
          text: '补充：也顺便检查一下 API 超时时间',
        },
      },
    });

    const result = parseChatStreamEnvelope(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.envelope).toEqual({
      seq: 4,
      event: {
        type: 'item.completed',
        item: {
          id: 'u1',
          type: 'user_message',
          text: '补充：也顺便检查一下 API 超时时间',
        },
      },
    });
  });
});
