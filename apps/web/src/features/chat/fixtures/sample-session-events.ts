/**
 * A recorded-style `ChatStreamEnvelope[]` fixture (work order §B) — shaped
 * like a real run of examples/12's event timeline (the server's
 * `user.message` echo as the turn's first event, tool_call's three
 * lifecycle-observable end states, a failed tool call, an `error` item, a
 * multi-increment `agent_message`, `reasoning`'s collapse, `plan_update`'s
 * checklist growth, `file_change`, and the turn.completed/turn.result
 * pair), used to drive both the vitest component tests and local dev/manual
 * preview of the timeline without a running server.
 */
import type { ChatStreamEnvelope } from '../schema';

export const SAMPLE_USER_MESSAGE_TEXT =
  '帮我看看登录页面有没有可以优化的地方。';

export const sampleChatEnvelopes: ChatStreamEnvelope[] = [
  { seq: 1, event: { type: 'session.started', sessionId: 'sess_demo' } },
  { seq: 2, event: { type: 'user.message', text: SAMPLE_USER_MESSAGE_TEXT } },
  { seq: 3, event: { type: 'turn.started', turn: 1 } },

  {
    seq: 4,
    event: {
      type: 'item.started',
      item: { id: 'r1', type: 'reasoning', text: '' },
    },
  },
  {
    seq: 5,
    event: {
      type: 'item.updated',
      item: { id: 'r1', type: 'reasoning', text: '思考: 用户想要...' },
    },
  },
  {
    seq: 6,
    event: {
      type: 'item.completed',
      item: {
        id: 'r1',
        type: 'reasoning',
        text: '思考: 用户想要一个关于登录页面的可用性优化建议。',
      },
    },
  },

  {
    seq: 7,
    event: {
      type: 'item.started',
      item: {
        id: 'p1',
        type: 'plan_update',
        items: [{ text: '审查现有登录页面', completed: false }],
      },
    },
  },
  {
    seq: 8,
    event: {
      type: 'item.updated',
      item: {
        id: 'p1',
        type: 'plan_update',
        items: [
          { text: '审查现有登录页面', completed: true },
          { text: '提出优化建议', completed: false },
        ],
      },
    },
  },

  {
    seq: 9,
    event: {
      type: 'item.started',
      item: {
        id: 't1',
        type: 'tool_call',
        toolName: 'bash',
        input: { command: "grep -R 'LoginPage' src" },
        status: 'in_progress',
      },
    },
  },
  {
    seq: 10,
    event: {
      type: 'item.updated',
      item: {
        id: 't1',
        type: 'tool_call',
        toolName: 'bash',
        input: { command: "grep -R 'LoginPage' src" },
        status: 'in_progress',
      },
    },
  },
  {
    seq: 11,
    event: {
      type: 'item.completed',
      item: {
        id: 't1',
        type: 'tool_call',
        toolName: 'bash',
        input: { command: "grep -R 'LoginPage' src" },
        output: '3 matches found in src/pages/login.tsx',
        status: 'completed',
      },
    },
  },

  {
    seq: 12,
    event: {
      type: 'item.started',
      item: {
        id: 't2',
        type: 'tool_call',
        toolName: 'write_file',
        input: {
          path: 'src/pages/login.tsx',
          content: '...(long content elided)...',
        },
        status: 'in_progress',
      },
    },
  },
  {
    seq: 13,
    event: {
      type: 'item.completed',
      item: {
        id: 't2',
        type: 'tool_call',
        toolName: 'write_file',
        input: {
          path: 'src/pages/login.tsx',
          content: '...(long content elided)...',
        },
        output: 'permission denied',
        status: 'failed',
      },
    },
  },

  {
    seq: 14,
    event: {
      type: 'item.started',
      item: {
        id: 'e1',
        type: 'error',
        message:
          'write_file 失败：permission denied，将改为建议方案而非直接修改文件',
      },
    },
  },

  {
    seq: 15,
    event: {
      type: 'item.completed',
      item: {
        id: 'f1',
        type: 'file_change',
        changes: [
          { path: 'src/pages/login.tsx', kind: 'update' },
          { path: 'src/pages/login.css', kind: 'add' },
        ],
      },
    },
  },

  {
    seq: 16,
    event: {
      type: 'item.started',
      item: { id: 'a1', type: 'agent_message', text: '' },
    },
  },
  {
    seq: 17,
    event: {
      type: 'item.updated',
      item: { id: 'a1', type: 'agent_message', text: '根据代码分析，' },
    },
  },
  {
    seq: 18,
    event: {
      type: 'item.updated',
      item: {
        id: 'a1',
        type: 'agent_message',
        text: '根据代码分析，登录页面的密码输入框缺少显示/隐藏切换，',
      },
    },
  },
  {
    seq: 19,
    event: {
      type: 'item.completed',
      item: {
        id: 'a1',
        type: 'agent_message',
        text: '根据代码分析，登录页面的密码输入框缺少显示/隐藏切换，建议增加一个可点击的眼睛图标来提升可用性。由于直接修改文件权限被拒绝，以上是我的建议方案。',
      },
    },
  },

  {
    seq: 20,
    event: {
      type: 'turn.completed',
      usage: {
        inputTokens: 1200,
        outputTokens: 340,
        totalTokens: 1540,
        cachedInputTokens: 896,
      },
    },
  },
  {
    seq: 21,
    event: {
      type: 'turn.result',
      finalResponse:
        '根据代码分析，登录页面的密码输入框缺少显示/隐藏切换，建议增加一个可点击的眼睛图标来提升可用性。由于直接修改文件权限被拒绝，以上是我的建议方案。',
      usage: {
        inputTokens: 1200,
        outputTokens: 340,
        totalTokens: 1540,
        cachedInputTokens: 896,
      },
    },
  },
];

/**
 * A second, self-contained recorded-style sequence (work order §B, docs/08
 * §2.2c（审批链）) covering the two human-in-the-loop flows this work order
 * adds: a `bash` call escalated to approval (`approval.requested` →
 * `approval.resolved`, allow), an `ask_user` question
 * (`question.asked` → `question.answered`), and a still-pending approval
 * that never gets resolved before the turn's own terminal sentinel
 * (`turn.result`) — the case `timeline.ts`'s terminal-sweep folds into
 * `'expired'` rather than leaving stuck at `'pending'` forever.
 *
 * Kept separate from `sampleChatEnvelopes` above (own seq numbering,
 * starting at 1, same "no gaps" convention) rather than appended onto it:
 * several `TimelineView` tests assert exact counts against that fixture (one
 * `bash` card, one `turn-result-bar`), which extending its single turn would
 * break.
 */
export const SAMPLE_APPROVAL_COMMAND = 'git push origin nimbo/chat-demo';
export const SAMPLE_QUESTION_TEXT =
  '登录按钮的颜色，你希望用主题色还是保持现在的灰色？';
export const SAMPLE_QUESTION_ANSWER = '用主题色吧。';
export const SAMPLE_EXPIRED_APPROVAL_COMMAND = 'git reset --hard origin/main';

export const sampleApprovalQuestionEnvelopes: ChatStreamEnvelope[] = [
  { seq: 1, event: { type: 'session.started', sessionId: 'sess_demo_2' } },
  {
    seq: 2,
    event: {
      type: 'user.message',
      text: '把改动推上去，另外登录按钮的颜色你看着定就行。',
    },
  },
  { seq: 3, event: { type: 'turn.started', turn: 1 } },

  // bash escalated to approval — the tool_call item and the approval bridge
  // events are independent (`callId` ≠ item id, docs/08 §2.2c） but ordered
  // start → request → resolve → complete the way the real bridge produces
  // them.
  {
    seq: 4,
    event: {
      type: 'item.started',
      item: {
        id: 't1',
        type: 'tool_call',
        toolName: 'bash',
        input: { command: SAMPLE_APPROVAL_COMMAND },
        status: 'in_progress',
      },
    },
  },
  {
    seq: 5,
    event: {
      type: 'approval.requested',
      callId: 'call_1',
      toolName: 'bash',
      input: { command: SAMPLE_APPROVAL_COMMAND },
    },
  },
  {
    seq: 6,
    event: { type: 'approval.resolved', callId: 'call_1', behavior: 'allow' },
  },
  {
    seq: 7,
    event: {
      type: 'item.completed',
      item: {
        id: 't1',
        type: 'tool_call',
        toolName: 'bash',
        input: { command: SAMPLE_APPROVAL_COMMAND },
        output:
          'To github.com:acme/demo.git\n   1a2b3c4..5d6e7f8  nimbo/chat-demo -> nimbo/chat-demo',
        status: 'completed',
      },
    },
  },

  // ask_user — its own tool_call item stays suppressed (timeline.ts) once it
  // settles as `completed`; the `question.*` pair is its sole rendering.
  {
    seq: 8,
    event: {
      type: 'item.started',
      item: {
        id: 't2',
        type: 'tool_call',
        toolName: 'ask_user',
        input: {
          question: SAMPLE_QUESTION_TEXT,
          options: ['主题色', '保持灰色'],
        },
        status: 'in_progress',
      },
    },
  },
  {
    seq: 9,
    event: {
      type: 'question.asked',
      callId: 'call_2',
      question: SAMPLE_QUESTION_TEXT,
      options: ['主题色', '保持灰色'],
    },
  },
  {
    seq: 10,
    event: {
      type: 'question.answered',
      callId: 'call_2',
      outcome: 'answered',
      answer: SAMPLE_QUESTION_ANSWER,
    },
  },
  {
    seq: 11,
    event: {
      type: 'item.completed',
      item: {
        id: 't2',
        type: 'tool_call',
        toolName: 'ask_user',
        input: {
          question: SAMPLE_QUESTION_TEXT,
          options: ['主题色', '保持灰色'],
        },
        output: SAMPLE_QUESTION_ANSWER,
        status: 'completed',
      },
    },
  },

  // A second bash call escalates to approval but never gets resolved before
  // the turn ends (a timeout resolution that never made it onto this
  // client's log, or turn-runner's own end-of-turn "deny residual pending
  // but don't emit" fallback, docs/08 §2.2c（审批链）) — `timeline.ts`'s
  // terminal-sweep is what folds this into `'expired'` instead of leaving it
  // stuck offering Allow/Deny for a decision the turn can no longer act on.
  {
    seq: 12,
    event: {
      type: 'item.started',
      item: {
        id: 't3',
        type: 'tool_call',
        toolName: 'bash',
        input: { command: SAMPLE_EXPIRED_APPROVAL_COMMAND },
        status: 'in_progress',
      },
    },
  },
  {
    seq: 13,
    event: {
      type: 'approval.requested',
      callId: 'call_3',
      toolName: 'bash',
      input: { command: SAMPLE_EXPIRED_APPROVAL_COMMAND },
    },
  },

  {
    seq: 14,
    event: {
      type: 'turn.completed',
      usage: { inputTokens: 400, outputTokens: 120, totalTokens: 520 },
    },
  },
  {
    seq: 15,
    event: {
      type: 'turn.result',
      finalResponse: '改动已推送；登录按钮颜色按你的选择改成了主题色。',
      usage: { inputTokens: 400, outputTokens: 120, totalTokens: 520 },
    },
  },
];
