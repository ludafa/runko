import { describe, expect, it } from 'vitest';

import {
  SAMPLE_USER_MESSAGE_TEXT,
  sampleChatEnvelopes,
} from '../fixtures/sample-session-events';
import { buildTimeline } from '../timeline';

describe('buildTimeline', () => {
  it('collapses item.started/updated/completed for the same id into a single slot, updated in place', () => {
    const entries = buildTimeline(sampleChatEnvelopes);
    const reasoningEntries = entries.filter(
      (entry) => entry.kind === 'item' && entry.id === 'r1',
    );
    expect(reasoningEntries).toHaveLength(1);
    const [reasoning] = reasoningEntries;
    if (
      reasoning === undefined ||
      reasoning.kind !== 'item' ||
      reasoning.item.type !== 'reasoning'
    )
      throw new Error('unreachable');
    expect(reasoning.item.text).toBe(
      '思考: 用户想要一个关于登录页面的可用性优化建议。',
    );
    expect(reasoning.lifecycle).toBe('completed');
  });

  it('keeps an item at its first-seen position even as later updates change its content', () => {
    const entries = buildTimeline(sampleChatEnvelopes);
    const keys = entries.map((entry) =>
      entry.kind === 'item' ? `item:${entry.id}` : entry.kind,
    );
    const reasoningIndex = keys.indexOf('item:r1');
    const planIndex = keys.indexOf('item:p1');
    const toolIndex = keys.indexOf('item:t1');
    expect(reasoningIndex).toBeGreaterThanOrEqual(0);
    expect(planIndex).toBeGreaterThan(reasoningIndex);
    expect(toolIndex).toBeGreaterThan(planIndex);
  });

  it("reflects a tool_call's final status (completed vs failed) without a duplicate row per lifecycle event", () => {
    const entries = buildTimeline(sampleChatEnvelopes);
    const t1 = entries.find(
      (entry) => entry.kind === 'item' && entry.id === 't1',
    );
    const t2 = entries.find(
      (entry) => entry.kind === 'item' && entry.id === 't2',
    );
    if (t1 === undefined || t1.kind !== 'item' || t1.item.type !== 'tool_call')
      throw new Error('unreachable');
    if (t2 === undefined || t2.kind !== 'item' || t2.item.type !== 'tool_call')
      throw new Error('unreachable');
    expect(t1.item.status).toBe('completed');
    expect(t2.item.status).toBe('failed');
    expect(
      entries.filter((entry) => entry.kind === 'item' && entry.id === 't1'),
    ).toHaveLength(1);
  });

  it('folds turn.completed into the following turn.result marker instead of a separate row', () => {
    const entries = buildTimeline(sampleChatEnvelopes);
    expect(entries.some((entry) => entry.kind === 'turn-result')).toBe(true);
    // turn.completed (seq 20) never produces its own slot:
    expect(
      entries.filter((entry) => 'seq' in entry && entry.seq === 20),
    ).toHaveLength(0);
  });

  it('renders the server-echoed user.message event as a user-message entry positioned right before the turn it started', () => {
    const entries = buildTimeline(sampleChatEnvelopes);
    const userIndex = entries.findIndex(
      (entry) => entry.kind === 'user-message',
    );
    const turnStartedIndex = entries.findIndex(
      (entry) => entry.kind === 'turn-started',
    );
    expect(userIndex).toBeGreaterThanOrEqual(0);
    expect(turnStartedIndex).toBe(userIndex + 1);
    const userEntry = entries[userIndex];
    if (userEntry === undefined || userEntry.kind !== 'user-message')
      throw new Error('unreachable');
    expect(userEntry.text).toBe(SAMPLE_USER_MESSAGE_TEXT);
    expect(userEntry.seq).toBe(2);
  });

  it('omits the user-message row entirely when the envelope list has no user.message event', () => {
    const withoutUserMessage = sampleChatEnvelopes.filter(
      (envelope) => envelope.event.type !== 'user.message',
    );
    const entries = buildTimeline(withoutUserMessage);
    expect(entries.some((entry) => entry.kind === 'user-message')).toBe(false);
  });

  it('replays a duplicate user.message envelope (e.g. history + a re-delivered live one) as a single row, deduped by seq', () => {
    const duplicated = [...sampleChatEnvelopes, sampleChatEnvelopes[1]].filter(
      (envelope): envelope is (typeof sampleChatEnvelopes)[number] =>
        envelope !== undefined,
    );
    const entries = buildTimeline(duplicated);
    expect(
      entries.filter((entry) => entry.kind === 'user-message'),
    ).toHaveLength(1);
  });

  it('is idempotent / order-stable when fed the same deduped envelopes twice', () => {
    const once = buildTimeline(sampleChatEnvelopes);
    const twice = buildTimeline([...sampleChatEnvelopes]);
    expect(twice).toEqual(once);
  });
});
