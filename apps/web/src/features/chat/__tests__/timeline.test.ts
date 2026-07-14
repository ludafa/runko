import { describe, expect, it } from 'vitest';

import {
  SAMPLE_USER_MESSAGE_TEXT,
  sampleApprovalQuestionEnvelopes,
  sampleChatEnvelopes,
} from '../fixtures/sample-session-events';
import type { ChatStreamEnvelope } from '../schema';
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

// -----------------------------------------------------------------------
// Approval/question bridge events (docs/08 §2.2c（审批链）) — work order C2.
// -----------------------------------------------------------------------

describe('buildTimeline: approval bridge (approval.requested/approval.resolved)', () => {
  it('folds approval.requested into a pending entry carrying the tool/input', () => {
    const envelopes: ChatStreamEnvelope[] = [
      {
        seq: 1,
        event: {
          type: 'approval.requested',
          callId: 'c1',
          toolName: 'bash',
          input: { command: 'git push' },
        },
      },
    ];
    const entries = buildTimeline(envelopes);
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (entry === undefined || entry.kind !== 'approval')
      throw new Error('unreachable');
    expect(entry.status).toBe('pending');
    expect(entry.callId).toBe('c1');
    expect(entry.toolName).toBe('bash');
    expect(entry.input).toEqual({ command: 'git push' });
  });

  it('folds approval.resolved allow into an allowed entry with no message, updating the same slot in place', () => {
    const envelopes: ChatStreamEnvelope[] = [
      {
        seq: 1,
        event: {
          type: 'approval.requested',
          callId: 'c1',
          toolName: 'bash',
          input: { command: 'git push' },
        },
      },
      {
        seq: 2,
        event: { type: 'approval.resolved', callId: 'c1', behavior: 'allow' },
      },
    ];
    const entries = buildTimeline(envelopes);
    expect(entries).toHaveLength(1); // same slot, not a second row
    const [entry] = entries;
    if (entry === undefined || entry.kind !== 'approval')
      throw new Error('unreachable');
    expect(entry.status).toBe('allowed');
    expect(entry.message).toBeUndefined();
    expect(entry.toolName).toBe('bash'); // carried over from the requested event
  });

  it('folds approval.resolved deny into a denied entry, passing the deny message through', () => {
    const envelopes: ChatStreamEnvelope[] = [
      {
        seq: 1,
        event: {
          type: 'approval.requested',
          callId: 'c1',
          toolName: 'bash',
          input: { command: 'rm -rf /tmp/x' },
        },
      },
      {
        seq: 2,
        event: {
          type: 'approval.resolved',
          callId: 'c1',
          behavior: 'deny',
          message: '太危险了',
        },
      },
    ];
    const entries = buildTimeline(envelopes);
    const [entry] = entries;
    if (entry === undefined || entry.kind !== 'approval')
      throw new Error('unreachable');
    expect(entry.status).toBe('denied');
    expect(entry.message).toBe('太危险了');
  });

  it('keeps the approval entry at its first-seen (requested) position — a later resolution never moves it', () => {
    const envelopes: ChatStreamEnvelope[] = [
      { seq: 1, event: { type: 'turn.started', turn: 1 } },
      {
        seq: 2,
        event: {
          type: 'approval.requested',
          callId: 'c1',
          toolName: 'bash',
          input: {},
        },
      },
      {
        seq: 3,
        event: {
          type: 'item.started',
          item: { id: 'x1', type: 'reasoning', text: '' },
        },
      },
      {
        seq: 4,
        event: { type: 'approval.resolved', callId: 'c1', behavior: 'allow' },
      },
    ];
    const entries = buildTimeline(envelopes);
    const kinds = entries.map((entry) => entry.kind);
    expect(kinds).toEqual(['turn-started', 'approval', 'item']);
  });
});

describe('buildTimeline: question bridge (question.asked/question.answered)', () => {
  it('folds question.asked with options into a pending entry carrying the options', () => {
    const envelopes: ChatStreamEnvelope[] = [
      {
        seq: 1,
        event: {
          type: 'question.asked',
          callId: 'q1',
          question: '选哪个颜色？',
          options: ['红', '蓝'],
        },
      },
    ];
    const entries = buildTimeline(envelopes);
    const [entry] = entries;
    if (entry === undefined || entry.kind !== 'question')
      throw new Error('unreachable');
    expect(entry.status).toBe('pending');
    expect(entry.options).toEqual(['红', '蓝']);
  });

  it('folds question.asked without options into a pending entry with options left undefined', () => {
    const envelopes: ChatStreamEnvelope[] = [
      {
        seq: 1,
        event: {
          type: 'question.asked',
          callId: 'q1',
          question: '要不要继续？',
        },
      },
    ];
    const entries = buildTimeline(envelopes);
    const [entry] = entries;
    if (entry === undefined || entry.kind !== 'question')
      throw new Error('unreachable');
    expect(entry.options).toBeUndefined();
  });

  it('folds question.answered (answered outcome) into an answered entry carrying the answer, updating the same slot in place', () => {
    const envelopes: ChatStreamEnvelope[] = [
      {
        seq: 1,
        event: {
          type: 'question.asked',
          callId: 'q1',
          question: '要不要继续？',
        },
      },
      {
        seq: 2,
        event: {
          type: 'question.answered',
          callId: 'q1',
          outcome: 'answered',
          answer: '继续',
        },
      },
    ];
    const entries = buildTimeline(envelopes);
    expect(entries).toHaveLength(1); // same slot, not a second row
    const [entry] = entries;
    if (entry === undefined || entry.kind !== 'question')
      throw new Error('unreachable');
    expect(entry.status).toBe('answered');
    expect(entry.answer).toBe('继续');
    expect(entry.question).toBe('要不要继续？'); // carried over from the asked event
  });

  it('folds question.answered (timeout outcome) into a timeout entry with no answer', () => {
    const envelopes: ChatStreamEnvelope[] = [
      {
        seq: 1,
        event: {
          type: 'question.asked',
          callId: 'q1',
          question: '要不要继续？',
        },
      },
      {
        seq: 2,
        event: { type: 'question.answered', callId: 'q1', outcome: 'timeout' },
      },
    ];
    const entries = buildTimeline(envelopes);
    const [entry] = entries;
    if (entry === undefined || entry.kind !== 'question')
      throw new Error('unreachable');
    expect(entry.status).toBe('timeout');
    expect(entry.answer).toBeUndefined();
  });

  it('keeps the question entry at its first-seen (asked) position — a later answer never moves it', () => {
    const envelopes: ChatStreamEnvelope[] = [
      { seq: 1, event: { type: 'turn.started', turn: 1 } },
      {
        seq: 2,
        event: { type: 'question.asked', callId: 'q1', question: '继续吗？' },
      },
      {
        seq: 3,
        event: {
          type: 'item.started',
          item: { id: 'x1', type: 'reasoning', text: '' },
        },
      },
      {
        seq: 4,
        event: {
          type: 'question.answered',
          callId: 'q1',
          outcome: 'answered',
          answer: '继续',
        },
      },
    ];
    const entries = buildTimeline(envelopes);
    const kinds = entries.map((entry) => entry.kind);
    expect(kinds).toEqual(['turn-started', 'question', 'item']);
  });
});

describe('buildTimeline: terminal-sweep expiry (turn.result / turn-runner turn.failed)', () => {
  it("sweeps the fixture's still-pending approval (call_3) to 'expired' once turn.result arrives", () => {
    const entries = buildTimeline(sampleApprovalQuestionEnvelopes);
    const approvals = entries.filter((entry) => entry.kind === 'approval');
    expect(approvals).toHaveLength(2);
    const call3 = approvals.find(
      (entry) => entry.kind === 'approval' && entry.callId === 'call_3',
    );
    if (call3 === undefined || call3.kind !== 'approval')
      throw new Error('unreachable');
    expect(call3.status).toBe('expired');
  });

  it('does not touch already-terminal approval/question entries during the terminal sweep (fixture call_1/call_2)', () => {
    const entries = buildTimeline(sampleApprovalQuestionEnvelopes);
    const call1 = entries.find(
      (entry) => entry.kind === 'approval' && entry.callId === 'call_1',
    );
    const call2 = entries.find(
      (entry) => entry.kind === 'question' && entry.callId === 'call_2',
    );
    if (call1 === undefined || call1.kind !== 'approval')
      throw new Error('unreachable');
    if (call2 === undefined || call2.kind !== 'question')
      throw new Error('unreachable');
    expect(call1.status).toBe('allowed');
    expect(call2.status).toBe('answered');
  });

  it("also sweeps a still-pending question to 'expired' via turn-runner's flat turn.failed sentinel (no nested error — the terminal one)", () => {
    const envelopes: ChatStreamEnvelope[] = [
      {
        seq: 1,
        event: { type: 'question.asked', callId: 'q1', question: '继续吗？' },
      },
      {
        seq: 2,
        event: {
          type: 'turn.failed',
          code: 'internal_error',
          message: 'boom',
        },
      },
    ];
    const entries = buildTimeline(envelopes);
    const question = entries.find((entry) => entry.kind === 'question');
    if (question === undefined || question.kind !== 'question')
      throw new Error('unreachable');
    expect(question.status).toBe('expired');
  });

  it('does NOT sweep on the mid-stream SessionEvent turn.failed variant (nested error) — that turn still reaches a normal turn.result afterwards', () => {
    const envelopes: ChatStreamEnvelope[] = [
      {
        seq: 1,
        event: {
          type: 'approval.requested',
          callId: 'c1',
          toolName: 'bash',
          input: {},
        },
      },
      {
        seq: 2,
        event: {
          type: 'turn.failed',
          error: { code: 'provider_error', message: 'transient' },
        },
      },
    ];
    const entries = buildTimeline(envelopes);
    const approval = entries.find((entry) => entry.kind === 'approval');
    if (approval === undefined || approval.kind !== 'approval')
      throw new Error('unreachable');
    expect(approval.status).toBe('pending');
  });
});

describe('buildTimeline: locallyExpiredCallIds option (a failed submitApproval/submitAnswer 404)', () => {
  it('expires only the pending entries whose callId is listed, leaving other pending ones alone', () => {
    const envelopes: ChatStreamEnvelope[] = [
      {
        seq: 1,
        event: {
          type: 'approval.requested',
          callId: 'c1',
          toolName: 'bash',
          input: {},
        },
      },
      {
        seq: 2,
        event: {
          type: 'approval.requested',
          callId: 'c2',
          toolName: 'bash',
          input: {},
        },
      },
    ];
    const entries = buildTimeline(envelopes, {
      locallyExpiredCallIds: new Set(['c1']),
    });
    const c1 = entries.find(
      (entry) => entry.kind === 'approval' && entry.callId === 'c1',
    );
    const c2 = entries.find(
      (entry) => entry.kind === 'approval' && entry.callId === 'c2',
    );
    if (c1 === undefined || c1.kind !== 'approval')
      throw new Error('unreachable');
    if (c2 === undefined || c2.kind !== 'approval')
      throw new Error('unreachable');
    expect(c1.status).toBe('expired');
    expect(c2.status).toBe('pending');
  });

  it('does not override an already-terminal entry (e.g. answered) even if its callId is listed', () => {
    const envelopes: ChatStreamEnvelope[] = [
      {
        seq: 1,
        event: { type: 'question.asked', callId: 'q1', question: '继续吗？' },
      },
      {
        seq: 2,
        event: {
          type: 'question.answered',
          callId: 'q1',
          outcome: 'answered',
          answer: '好',
        },
      },
    ];
    const entries = buildTimeline(envelopes, {
      locallyExpiredCallIds: new Set(['q1']),
    });
    const [entry] = entries;
    if (entry === undefined || entry.kind !== 'question')
      throw new Error('unreachable');
    expect(entry.status).toBe('answered');
  });

  it('is a no-op when no entry is pending for the listed callIds (nothing to expire)', () => {
    const withoutOption = buildTimeline(sampleApprovalQuestionEnvelopes);
    const withEmptyOption = buildTimeline(sampleApprovalQuestionEnvelopes, {
      locallyExpiredCallIds: new Set(),
    });
    expect(withEmptyOption).toEqual(withoutOption);
  });
});

describe('buildTimeline: ask_user tool_call suppression (docs/08 §2.2c（审批链）)', () => {
  it('produces no item entry for an in_progress ask_user tool_call', () => {
    const envelopes: ChatStreamEnvelope[] = [
      {
        seq: 1,
        event: {
          type: 'item.started',
          item: {
            id: 't1',
            type: 'tool_call',
            toolName: 'ask_user',
            input: { question: 'x' },
            status: 'in_progress',
          },
        },
      },
    ];
    expect(buildTimeline(envelopes)).toHaveLength(0);
  });

  it('produces no item entry for a completed ask_user tool_call (the question card is its sole rendering)', () => {
    const envelopes: ChatStreamEnvelope[] = [
      {
        seq: 1,
        event: {
          type: 'item.completed',
          item: {
            id: 't1',
            type: 'tool_call',
            toolName: 'ask_user',
            input: { question: 'x' },
            output: 'y',
            status: 'completed',
          },
        },
      },
    ];
    expect(buildTimeline(envelopes)).toHaveLength(0);
  });

  it('DOES produce an item entry for a failed ask_user tool_call (no question card to show for it)', () => {
    const envelopes: ChatStreamEnvelope[] = [
      {
        seq: 1,
        event: {
          type: 'item.completed',
          item: {
            id: 't1',
            type: 'tool_call',
            toolName: 'ask_user',
            input: { question: 'x' },
            output: 'boom',
            status: 'failed',
          },
        },
      },
    ];
    const entries = buildTimeline(envelopes);
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (
      entry === undefined ||
      entry.kind !== 'item' ||
      entry.item.type !== 'tool_call'
    )
      throw new Error('unreachable');
    expect(entry.item.status).toBe('failed');
  });

  it('DOES produce an item entry for a denied ask_user tool_call (an approval gate ahead of it rejected the call)', () => {
    const envelopes: ChatStreamEnvelope[] = [
      {
        seq: 1,
        event: {
          type: 'item.completed',
          item: {
            id: 't1',
            type: 'tool_call',
            toolName: 'ask_user',
            input: { question: 'x' },
            status: 'denied',
          },
        },
      },
    ];
    const entries = buildTimeline(envelopes);
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (
      entry === undefined ||
      entry.kind !== 'item' ||
      entry.item.type !== 'tool_call'
    )
      throw new Error('unreachable');
    expect(entry.item.status).toBe('denied');
  });
});

describe('buildTimeline: malformed/out-of-order approval and question resolutions (fallback values)', () => {
  it('falls back to empty toolName / null input when approval.resolved arrives with no prior approval.requested', () => {
    const envelopes: ChatStreamEnvelope[] = [
      {
        seq: 1,
        event: { type: 'approval.resolved', callId: 'c1', behavior: 'allow' },
      },
    ];
    const entries = buildTimeline(envelopes);
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (entry === undefined || entry.kind !== 'approval')
      throw new Error('unreachable');
    expect(entry.toolName).toBe('');
    expect(entry.input).toBeNull();
    expect(entry.status).toBe('allowed');
  });

  it('falls back to an empty question string / undefined options when question.answered arrives with no prior question.asked', () => {
    const envelopes: ChatStreamEnvelope[] = [
      {
        seq: 1,
        event: {
          type: 'question.answered',
          callId: 'q1',
          outcome: 'answered',
          answer: '好',
        },
      },
    ];
    const entries = buildTimeline(envelopes);
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (entry === undefined || entry.kind !== 'question')
      throw new Error('unreachable');
    expect(entry.question).toBe('');
    expect(entry.options).toBeUndefined();
    expect(entry.status).toBe('answered');
    expect(entry.answer).toBe('好');
  });
});
