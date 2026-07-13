import { describe, expect, it } from 'vitest';

import {
  chatStreamEventSchema,
  sessionItemSchema,
} from '../../src/schemas/chat.js';

/**
 * Regression coverage for the local-review Finding 2 fix: `sessionItemSchema`
 * (and, transitively, `sessionEventSchema`/`chatStreamEventSchema`) used to
 * be missing the `user_message` variant `@nimbo/core`'s `SessionItem` union
 * gained for `Session.steer()` (docs/02-tech-spec.md §4.2) — a `user_message`
 * item arriving over `GET .../events`/`GET .../stream` replay would fail
 * `.parse()` with a `ZodError` (silently reported as end-user-visible replay
 * breakage, not a schema-shape bug). The `_...CoversAllVariants` compile-time
 * check in schemas/chat.ts now guards against this drifting again; these are
 * the runtime-level regression tests for the specific bug that motivated it.
 */
describe('schemas/chat: sessionItemSchema', () => {
  it('parses a user_message item (steer()-injected mid-turn message, @nimbo/core tech-spec §4.2)', () => {
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

describe('schemas/chat: chatStreamEventSchema', () => {
  it('parses an item.completed event carrying a user_message item without throwing — the direct regression for GET .../events replay ZodError-ing on a steered turn', () => {
    const parsed = chatStreamEventSchema.parse({
      type: 'item.completed',
      item: {
        id: 'u1',
        type: 'user_message',
        text: '补充：也顺便检查一下 API 超时时间',
      },
    });
    expect(parsed).toEqual({
      type: 'item.completed',
      item: {
        id: 'u1',
        type: 'user_message',
        text: '补充：也顺便检查一下 API 超时时间',
      },
    });
  });
});
