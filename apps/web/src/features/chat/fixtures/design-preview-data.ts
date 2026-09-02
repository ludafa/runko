/**
 * 设计预览数据（只服务于 `/design` 这个设计工作台，见 `routes/design.tsx`）。
 *
 * 与 `sample-conversation-events.ts` 分工不同：那份是**测试**用的 chunk 序列
 * （断言物化/渲染的输入），这份是**设计**用的成品 `RunkoUIMessage[]`——把一次
 * 真实会话里会出现的全部界面状态（推理、文本、五种工具状态、计划、文件改动、
 * 审批、提问、失败、统计）一次性摆在同一屏上，好让界面语言的每一档都能被眼睛
 * 直接比对。不进任何测试断言，改它不会让测试变红。
 */
import type { RunkoUIMessage } from '@runko/core';

import type { Conversation, QueuedMessage } from '../schema';
import type { PendingUserEcho } from '../timeline';

/** 固定时间基准——预览页不能用 `Date.now()`，否则每次刷新耗时都在变、没法比对两版设计。 */
const T0 = Date.UTC(2026, 6, 25, 6, 14, 3);

/**
 * [skill 清单](../../../../../docs/terms.md)的假数据（docs/features/composer-skill-mention.md）——
 * 让 [composer](../../../../../docs/terms.md) 的 `/` 菜单在设计工作台里也能开出来，
 * 不必连服务端、不必等真沙盒。名字与描述照抄真实 skill 的口吻，好看出菜单在长
 * 描述下的换行表现。
 */
export const previewSkills = [
  {
    name: 'frontend-design',
    description:
      'Make one focused, non-generic visual/interaction improvement to an existing web UI without rewriting it.',
  },
  {
    name: 'code-review',
    description: '审查一段 diff：找缺陷、找遗漏的边界，不改写风格。',
  },
  {
    name: 'writing-docs',
    description: '把一个功能写成产品/技术/施工三份文档，术语先登记再使用。',
  },
];

export const previewConversations: Conversation[] = [
  {
    id: 'conv-redesign',
    title: '重做 chat 页面的界面语言',
    repo: 'ludafa/runko',
    branchName: 'runko/chat-a91f2c',
    sandboxName: 'runko-conv-redesign',
    provider: 'vercel',
    status: 'active',
    lastActiveAt: new Date(T0).toISOString(),
    queuedMessages: [],
    availableSkills: [],
    turnInProgress: false,
    createdAt: new Date(T0 - 3_600_000).toISOString(),
  },
  {
    id: 'conv-auth',
    title: '修登录态过期后不跳转',
    repo: 'ludafa/runko',
    branchName: 'runko/chat-77b0de',
    sandboxName: 'runko-conv-auth',
    provider: 'e2b',
    status: 'sleeping',
    lastActiveAt: new Date(T0 - 86_400_000).toISOString(),
    queuedMessages: [],
    availableSkills: [],
    turnInProgress: false,
    createdAt: new Date(T0 - 90_000_000).toISOString(),
  },
  {
    id: 'conv-docs',
    title: null,
    repo: 'ludafa/runko',
    branchName: 'runko/chat-04c1aa',
    sandboxName: 'runko-conv-docs',
    provider: 'vercel',
    status: 'expired',
    lastActiveAt: new Date(T0 - 6 * 86_400_000).toISOString(),
    queuedMessages: [],
    availableSkills: [],
    turnInProgress: false,
    createdAt: new Date(T0 - 7 * 86_400_000).toISOString(),
  },
];

export const previewQueue: QueuedMessage[] = [
  {
    id: 'q-1',
    text: '顺手把 dashboard 的卡片也换成新的间距',
    userId: 'u-1',
    createdAt: T0 + 61_000,
  },
  {
    id: 'q-2',
    text: '最后跑一遍 pnpm -C apps/web test',
    userId: 'u-1',
    createdAt: T0 + 74_000,
  },
];

const AGENT_PROSE = `我先把现在的界面语言摸一遍，再动手。

从 \`main.css\` 看，全站只有一套 shadcn 默认灰阶，**工具调用、审批、提问、计划**四类完全不同的东西共用同一种圆角卡片——这是层级读不出来的根因。

计划分三步：

1. 先定 token（色板 / 字体 / 圆角），让全站跟着变；
2. 再把「说的话」和「做的事」在结构上分开；
3. 最后把需要人介入的那两类单独做成打断。`;

/** 一次完整的会话：从用户指令到本轮统计，覆盖界面每一档状态。 */
export const previewMessages: RunkoUIMessage[] = [
  {
    id: 'm-user-1',
    role: 'user',
    parts: [
      {
        type: 'text',
        text: '把 chat 页面重做一版：现在工具卡片太吵，找不到 agent 到底说了什么。',
      },
    ],
  },
  {
    id: 'm-assistant-1',
    role: 'assistant',
    parts: [
      {
        type: 'reasoning',
        state: 'done',
        text: '用户抱怨的是层级，不是密度。先看 token 层有没有把语义色留出来——如果只有一套中性灰，那所有卡片长一样就是必然的。',
      },
      { type: 'text', state: 'done', text: AGENT_PROSE },
      {
        type: 'data-plan-update',
        id: 'plan-1',
        data: {
          items: [
            { text: '盘点现有 token 与组件', completed: true },
            { text: '定新色板与字体', completed: true },
            { text: '重做时间线结构', completed: false },
            { text: '重做审批 / 提问打断', completed: false },
          ],
        },
      },
      {
        type: 'tool-read-file',
        toolCallId: 'call-1',
        state: 'output-available',
        input: { path: 'apps/web/src/main.css' },
        output:
          '@import "tailwindcss";\n@import "shadcn/tailwind.css";\n\n:root {\n  --background: oklch(1 0 0);\n  --foreground: oklch(0.145 0 0);\n  …\n}',
      },
      {
        type: 'data-tool-timing',
        id: 'call-1',
        data: {
          toolCallId: 'call-1',
          startedAt: T0 + 4_000,
          executionStartedAt: T0 + 4_120,
          completedAt: T0 + 4_260,
        },
      },
      {
        type: 'tool-grep',
        toolCallId: 'call-2',
        state: 'output-available',
        input: {
          pattern: 'rounded-xl border',
          path: 'apps/web/src/features/chat',
        },
        output:
          'tool-call-card.tsx:238\napproval-card.tsx:79\nquestion-card.tsx:77\nplan-checklist.tsx:11\nreasoning-block.tsx:77',
      },
      {
        type: 'data-tool-timing',
        id: 'call-2',
        data: {
          toolCallId: 'call-2',
          startedAt: T0 + 4_010,
          executionStartedAt: T0 + 4_130,
          completedAt: T0 + 4_980,
        },
      },
      {
        type: 'data-file-change',
        id: 'fc-1',
        data: {
          changes: [
            { path: 'apps/web/src/main.css', kind: 'update' },
            {
              path: 'apps/web/src/features/chat/components/rail.tsx',
              kind: 'add',
            },
            {
              path: 'apps/web/src/features/chat/components/turn-marker.tsx',
              kind: 'delete',
            },
          ],
        },
      },
    ],
  },
  // 真实会话里一轮 = 很多条 assistant 消息（一步一条）。单独留一条只有一个部件的
  // 消息，是为了在工作台上复现「相邻两步之间轨道会不会断」——2026-07-25 真机上
  // 发现的断线正是这个形状（见 timeline-view.tsx 的 `groupIntoRails`）。
  {
    id: 'm-assistant-1b',
    role: 'assistant',
    metadata: {
      turn: 3,
      status: 'completed',
      durationMs: 83_400,
      toolDurationMs: 33_100,
      usage: {
        inputTokens: 149_326,
        cachedInputTokens: 131_072,
        outputTokens: 4_812,
        totalTokens: 154_138,
      },
    },
    parts: [
      {
        type: 'reasoning',
        state: 'done',
        text: 'typecheck 挂了，先看是不是 RailState 联合类型没导出。',
      },
      {
        type: 'tool-bash',
        toolCallId: 'call-3',
        state: 'output-error',
        input: { command: 'pnpm -C apps/web typecheck' },
        errorText:
          "src/features/chat/components/rail.tsx(42,7): error TS2322: Type 'string' is not assignable to type 'RailState'.",
      },
      {
        type: 'data-tool-timing',
        id: 'call-3',
        data: {
          toolCallId: 'call-3',
          startedAt: T0 + 5_000,
          executionStartedAt: T0 + 5_050,
          completedAt: T0 + 22_400,
        },
      },
    ],
  },
  {
    id: 'm-user-2',
    role: 'user',
    metadata: { steered: true },
    parts: [
      { type: 'text', text: '等一下，别删 turn-marker，失败提示还在用。' },
    ],
  },
  {
    id: 'm-assistant-2',
    role: 'assistant',
    parts: [
      {
        type: 'tool-ask-user',
        toolCallId: 'call-ask-1',
        state: 'output-available',
        input: {
          question: '侧栏保留会话状态徽标吗？它和分支名信息重复。',
          options: ['保留', '去掉'],
        },
        output: '去掉',
      },
      {
        type: 'tool-ask-user',
        toolCallId: 'call-ask-2',
        state: 'input-available',
        input: {
          question:
            '用户消息还要不要保留气泡？我倾向去掉，让它和 agent 的话在同一条基线上。',
          options: ['去掉气泡', '保留气泡'],
        },
      },
      {
        type: 'tool-write-file',
        toolCallId: 'call-4',
        state: 'output-available',
        input: { path: 'apps/web/src/main.css', content: '…' },
        output: 'written 4.1 KB',
      },
      {
        type: 'data-tool-timing',
        id: 'call-4',
        data: {
          toolCallId: 'call-4',
          startedAt: T0 + 40_000,
          executionStartedAt: T0 + 40_100,
          completedAt: T0 + 40_540,
        },
      },
      {
        type: 'tool-bash',
        toolCallId: 'call-5',
        state: 'approval-requested',
        input: { command: 'git push origin runko/chat-a91f2c' },
        approval: { id: 'call-5' },
      },
      {
        type: 'data-tool-timing',
        id: 'call-5',
        data: { toolCallId: 'call-5', startedAt: T0 + 41_000 },
      },
      {
        type: 'tool-list-dir',
        toolCallId: 'call-6',
        state: 'input-available',
        input: { path: 'apps/web/src/components/ui' },
      },
      {
        type: 'data-tool-timing',
        id: 'call-6',
        data: { toolCallId: 'call-6', startedAt: T0 + 41_200 },
      },
    ],
  },
];

/**
 * 刚点了「插话」、core 还没走到下一个 step 边界的那一刻——压暗 + 标「待注入」。
 * `afterMessageCount` 取够大的数，让它落在时间线末尾（就是刚发出去的位置）。
 */
export const previewPendingEchoes: PendingUserEcho[] = [
  {
    id: 1,
    text: '顺带把 provider 徽标也去掉吧',
    afterMessageCount: 99,
    steered: true,
  },
];

/** 第二组：一轮失败收尾——错误条 + 失败徽标，单独摆一处好比对。 */
export const previewFailedMessages: RunkoUIMessage[] = [
  {
    id: 'm-user-3',
    role: 'user',
    parts: [{ type: 'text', text: '把这个分支合进 main' }],
  },
  {
    id: 'm-assistant-3',
    role: 'assistant',
    metadata: {
      turn: 4,
      status: 'failed',
      durationMs: 12_300,
      error: {
        code: 'provider_error',
        message: '模型服务返回 429，重试 3 次后仍失败',
      },
    },
    parts: [
      {
        type: 'tool-bash',
        toolCallId: 'call-7',
        state: 'output-denied',
        input: { command: 'git merge --no-ff runko/chat-a91f2c' },
        approval: {
          id: 'call-7',
          approved: false,
          reason: '先开 PR 走 review，别直接合',
        },
      },
      {
        type: 'data-tool-timing',
        id: 'call-7',
        data: {
          toolCallId: 'call-7',
          startedAt: T0 + 60_000,
          completedAt: T0 + 71_000,
        },
      },
      {
        type: 'data-error',
        id: 'err-1',
        data: { message: '沙盒在本轮中途被平台回收，剩余步骤未执行' },
      },
    ],
  },
];

/**
 * 第三组：一轮被[停止](../../../../../docs/terms.md)收尾（docs/features/turn-abort.md）
 * ——中性的「已停止」标记，摆在失败那组旁边正是为了比对：同样是「没跑完」，但一个是
 * 故障（红），一个是用户自己按的（中性）。
 */
export const previewStoppedMessages: RunkoUIMessage[] = [
  {
    id: 'm-user-4',
    role: 'user',
    parts: [{ type: 'text', text: '把 README 逐段翻译成英文' }],
  },
  {
    id: 'm-assistant-4',
    role: 'assistant',
    metadata: {
      turn: 5,
      status: 'interrupted',
      durationMs: 8_400,
      error: { code: 'aborted', message: 'Turn stopped by the user.' },
    },
    parts: [
      { type: 'step-start' },
      {
        type: 'text',
        text: '已翻完前两节，正在翻「快速开始」……',
        state: 'done',
      },
    ],
  },
];

/**
 * 第三组之二：同样是 `code: 'aborted'`，但**不是用户按的**——服务端
 * [优雅关闭](../../../../../docs/terms.md)时中止的（docs/features/graceful-shutdown.md）。
 * 与上面那组并排，是为了盯住唯一的差别：标题与正文如实说「服务重启」，而不是让用户
 * 以为自己按过停止。`message` 必须与 `turn-marker.tsx` 的 `SHUTDOWN_ABORT_MESSAGE`
 * 逐字一致，否则这一档就退回成「已停止」——这组样例同时也是那个文案契约的哨兵。
 */
export const previewShutdownInterruptedMessages: RunkoUIMessage[] = [
  {
    id: 'm-user-5',
    role: 'user',
    parts: [{ type: 'text', text: '把所有组件迁到新的设计 token' }],
  },
  {
    id: 'm-assistant-5',
    role: 'assistant',
    metadata: {
      turn: 3,
      status: 'interrupted',
      durationMs: 12_100,
      error: {
        code: 'aborted',
        message: 'The server shut down while this turn was running.',
      },
    },
    parts: [
      { type: 'step-start' },
      {
        type: 'text',
        text: '已经迁完 Button 与 Card，正在处理 Dialog……',
        state: 'done',
      },
    ],
  },
];
