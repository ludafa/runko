/**
 * telemetry 落库（src/telemetry.ts，docs/tech/chat-webapp.md §11.4）：
 * functionId 解析、载荷收敛（大块正文换摘要 + 16KB 封顶）、事件回调的
 * "永不影响 turn"守卫、getChatTelemetry 的 vitest 守卫，以及经
 * 建 session 全链路（core loop 注入 functionId → 集成落 SQLite →
 * 按 (session_id, turn) 查回）的端到端验证。
 */
import { defaultSessionFactory } from '@runko/agent';
import { MemoryFS } from '@runko/sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { buildInstructions } from '../src/agent/chat-agent.js';
import { loadSkillsFromWorkspace } from '../src/agent/skill-catalog.js';
import {
  createSqliteTelemetry,
  createTelemetryStore,
  curatePayload,
  getChatTelemetry,
  parseFunctionId,
} from '../src/telemetry.js';
import { stopOnlyModel, toolCallThenStopModel } from './helpers/mock-model.js';
import { drainTurn } from './helpers/runko-chunks.js';
import { silentLogger } from './helpers/silent-logger.js';

describe('parseFunctionId', () => {
  it('splits "<agentSessionId>#<turn>" into the two columns', () => {
    expect(parseFunctionId('sess-1#3')).toEqual({
      agentSessionId: 'sess-1',
      turn: 3,
    });
  });

  it('splits on the LAST hash, so a agentSessionId containing "#" still round-trips', () => {
    expect(parseFunctionId('a#b#7')).toEqual({
      agentSessionId: 'a#b',
      turn: 7,
    });
  });

  it('falls back gracefully for undefined / empty / non-numeric-turn / hash-less ids', () => {
    expect(parseFunctionId(undefined)).toEqual({
      agentSessionId: null,
      turn: null,
    });
    expect(parseFunctionId('')).toEqual({ agentSessionId: null, turn: null });
    expect(parseFunctionId('no-hash')).toEqual({
      agentSessionId: 'no-hash',
      turn: null,
    });
    expect(parseFunctionId('sess#NaN-ish')).toEqual({
      agentSessionId: 'sess#NaN-ish',
      turn: null,
    });
  });
});

describe('curatePayload', () => {
  it('replaces heavy body keys (messages/content/...) with size summaries, keeps metrics intact', () => {
    const parsed = JSON.parse(
      curatePayload({
        usage: { inputTokens: 12, outputTokens: 3 },
        messages: [{ role: 'user' }, { role: 'assistant' }],
        content: 'x'.repeat(500),
      }),
    ) as Record<string, unknown>;
    expect(parsed.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
    expect(parsed.messages).toBe('[omitted: 2 items]');
    expect(parsed.content).toBe('[omitted: 500 chars]');
  });

  it('caps the serialized payload at 16KB with a truncation marker', () => {
    // 用不在省略清单里的键堆体积，逼出总长封顶分支。
    const huge = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`k${String(i)}`, 'v'.repeat(200)]),
    );
    const parsed = JSON.parse(curatePayload(huge)) as Record<string, unknown>;
    expect(parsed.truncated).toBe(true);
    expect(typeof parsed.approximateLength).toBe('number');
  });

  it('degrades to a serializationError stub instead of throwing (circular reference)', () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const parsed = JSON.parse(curatePayload(circular)) as Record<
      string,
      unknown
    >;
    expect(typeof parsed.serializationError).toBe('string');
  });
});

describe('createTelemetryStore + createSqliteTelemetry', () => {
  it('records one row per event, keyed by (session_id, turn) parsed from functionId, queryable via list()', () => {
    const store = createTelemetryStore(':memory:');
    // onError 的事件参数本就是 unknown（其余回调的精确事件形状由端到端用例
    // 覆盖）——正好无摩擦地验证"回调 → 拆列 → 落行"的通路。
    const telemetry = createSqliteTelemetry(store);
    telemetry.onError?.({
      functionId: 'sess-9#2',
      performance: { responseTimeMs: 123 },
    });

    const rows = store.list('sess-9', 2);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe('error');
    const payload = JSON.parse(rows[0]?.payloadJson ?? '{}') as Record<
      string,
      unknown
    >;
    expect(payload.performance).toEqual({ responseTimeMs: 123 });
    // functionId 已拆列，载荷里不再重复。
    expect(payload.functionId).toBeUndefined();
    store.close();
  });

  it('never lets a store failure escape the callback (telemetry must not break the turn)', () => {
    const throwing = {
      record: () => {
        throw new Error('disk full');
      },
      list: () => [],
      close: () => {},
    };
    const telemetry = createSqliteTelemetry(throwing);
    expect(() => {
      telemetry.onError?.({ functionId: 's#1' });
    }).not.toThrow();
  });
});

describe('耗材式 schema 演化（2026-07-17 列更名）', () => {
  it('detects a legacy telemetry.db (old session_id column) and rebuilds the table in place', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const Database = (await import('better-sqlite3')).default;

    const dir = await mkdtemp(join(tmpdir(), 'runko-telemetry-'));
    const path = join(dir, 'telemetry.db');
    try {
      // 造一个更名前的旧库（session_id 列 + 一行旧数据）。
      const legacy = new Database(path);
      legacy.exec(
        `CREATE TABLE telemetry_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT, turn INTEGER, event_type TEXT NOT NULL,
          ts INTEGER NOT NULL, payload_json TEXT NOT NULL);`,
      );
      legacy
        .prepare(
          "INSERT INTO telemetry_events (session_id, turn, event_type, ts, payload_json) VALUES ('old', 1, 'end', 0, '{}')",
        )
        .run();
      legacy.close();

      // 新代码打开旧库：整表重建（遥测无持久承诺），新 schema 正常读写。
      const store = createTelemetryStore(path);
      store.record('end', 'fresh#1', {});
      expect(store.list('fresh', 1)).toHaveLength(1);
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('getChatTelemetry', () => {
  it('is disabled under vitest unless TELEMETRY_DB_PATH is explicitly set (no stray telemetry.db from test imports)', () => {
    expect(getChatTelemetry()).toBeUndefined();
  });
});

describe('端到端：建 session → core loop 注入 functionId → SQLite 可按 turn 查回', () => {
  const stores: { close(): void }[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) {
      store.close();
    }
  });

  it('a drained turn lands model-call events under (session.id, turn 1)', async () => {
    const store = createTelemetryStore(':memory:');
    stores.push(store);

    const fs = new MemoryFS();
    await fs.writeFile(
      '/.agents/skills/frontend-design/SKILL.md',
      '---\ndescription: test stub\n---\n# stub\n',
    );
    const exec = {
      exec: () =>
        Promise.resolve({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 }),
    };
    // `@runko/agent` 的默认工厂——与 `agent/runtime.ts` 每一轮真正用的是同一段装配
    // （文件工具八件套 + core 的 `createSession`），所以这条 e2e 验的是生产那条路。
    const session = await defaultSessionFactory(
      {
        model: stopOnlyModel('done'),
        skills: await loadSkillsFromWorkspace(fs, silentLogger),
        instructions: buildInstructions({
          repoOwner: 'acme',
          repoName: 'demo',
          defaultBranch: 'main',
          branchName: 'runko/chat-t1',
          hasWebSearch: false,
        }),
      },
      {
        workspace: Object.assign(fs, exec),
        telemetry: {
          integrations: [createSqliteTelemetry(store)],
          recordInputs: false,
          recordOutputs: false,
        },
      },
    );

    await drainTurn(session.stream('hi'));

    const rows = store.list(session.toJSON().id, 1);
    const eventTypes = rows.map((row) => row.eventType);
    expect(eventTypes).toContain('model-call-start');
    expect(eventTypes).toContain('model-call-end');
    // 载荷是收敛后的 JSON（可解析、无大块正文键的原文）。
    for (const row of rows) {
      expect(() => JSON.parse(row.payloadJson)).not.toThrow();
    }
  });

  it('a turn that runs a tool lands tool-execution events (回归护栏：core settleExecution 补发 → SQLite 集成必须挂 onToolExecution* 才接得住)', async () => {
    const store = createTelemetryStore(':memory:');
    stores.push(store);

    const fs = new MemoryFS();
    await fs.writeFile(
      '/.agents/skills/frontend-design/SKILL.md',
      '---\ndescription: test stub\n---\n# stub\n',
    );
    const exec = {
      exec: () =>
        Promise.resolve({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 }),
    };
    const session = await defaultSessionFactory(
      {
        // 一步工具调用（write-file 走 settleExecution → executeToolCall）后停。
        model: toolCallThenStopModel(
          'write-file',
          { path: '/notes.txt', content: 'hi' },
          'call_1',
          'wrote it',
        ),
        skills: await loadSkillsFromWorkspace(fs, silentLogger),
        instructions: buildInstructions({
          repoOwner: 'acme',
          repoName: 'demo',
          defaultBranch: 'main',
          branchName: 'runko/chat-tool',
          hasWebSearch: false,
        }),
      },
      {
        workspace: Object.assign(fs, exec),
        telemetry: {
          integrations: [createSqliteTelemetry(store)],
          recordInputs: false,
          recordOutputs: false,
        },
      },
    );

    await drainTurn(session.stream('write a file'));

    const rows = store.list(session.toJSON().id, 1);
    const eventTypes = rows.map((row) => row.eventType);
    // 若 createSqliteTelemetry 漏挂 onToolExecutionStart/End，core 发出的工具
    // 事件无人记录——账本 toolDurationMs>0、遥测却零工具事件（2026-07-17 bug）。
    expect(eventTypes).toContain('tool-execution-start');
    expect(eventTypes).toContain('tool-execution-end');
    // 工具名与真实执行耗时进了 tool-execution-end 载荷（web 明细面板取这两个字段）。
    const endRow = rows.find((row) => row.eventType === 'tool-execution-end');
    const payload = JSON.parse(endRow?.payloadJson ?? '{}') as {
      toolCall?: { toolName?: string };
      toolExecutionMs?: unknown;
    };
    expect(payload.toolCall?.toolName).toBe('write-file');
    expect(typeof payload.toolExecutionMs).toBe('number');
  });
});
