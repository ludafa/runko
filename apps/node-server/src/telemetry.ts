/**
 * chat 的 telemetry 落库（docs/tech/chat-webapp.md §11.4）：ai@7 转正的
 * `Telemetry` 事件集成接口（纯回调，无 OpenTelemetry 依赖）→ 每个事件一行
 * SQLite，按 `functionId = "<agentSessionId>#<turn>"`（`@nimbo/core` loop 在每次
 * `streamText` 恒注入，见 `SessionTelemetry` 的注释）拆出 (agent_session_id, turn)
 * 两列建索引——"用 turn 查一下"就是一条
 * `SELECT * FROM telemetry_events WHERE agent_session_id = ? AND turn = ?`。
 *
 * 三条设计纪律：
 *
 * 1. **独立 db 文件**（缺省 `telemetry.db`，`TELEMETRY_DB_PATH` 覆盖）——
 *    遥测数据是可随意清理/设保留期的耗材，不与聊天账本（data.db）混寿命；
 *    删文件即清空，零迁移负担（表结构自管 CREATE IF NOT EXISTS，不进
 *    drizzle 迁移链）。
 * 2. **载荷收敛**：事件里可能带完整 prompt/响应正文（recordInputs/
 *    recordOutputs 缺省开），体积与敏感性都不适合默认落盘——序列化时把
 *    大块正文键替换成体量摘要（见 `OMITTED_KEYS`），整体再设 16KB 上限；
 *    生产注入侧（`getChatTelemetry`）同时把两个 record 开关关掉，双保险。
 * 3. **遥测永不影响 turn**：每个回调整体 try/catch 吞错——SQLite 写失败
 *    最多丢一行遥测，绝不把错误抛回 `streamText` 的执行路径。
 *
 * 注意：nimbo 的工具由 loop 自己结算，AI SDK 的 onToolExecutionStart/End
 * 在这里永远不会触发——工具维度的数据在 `data-tool-timing` 部件里（见
 * docs/tech/single-ledger.md §3.2），按同一对 (agent_session_id, turn) 即可 join。
 */
import Database from 'better-sqlite3';
import type { Telemetry } from 'ai';
import type { SessionTelemetry } from '@nimbo/core';

const PAYLOAD_MAX_LENGTH = 16_384;

/** 序列化时替换成体量摘要的键：模型输入/输出正文与逐步累积的大块结构（保留"有多大"的线索，丢原文）。 */
const OMITTED_KEYS = new Set([
  'messages',
  'content',
  'prompt',
  'system',
  'instructions',
  'steps',
  'request',
  'response',
  'text',
  'reasoning',
]);

/**
 * 序列化时直接删除的键：`functionId` 已拆进 (agent_session_id, turn) 两列，
 * `recordInputs`/`recordOutputs` 是随事件并入的选项噪音（ai 的
 * `InferTelemetryEvent` 把 TelemetryOptions 字段并进每个事件）。
 */
const DROPPED_KEYS = new Set(['functionId', 'recordInputs', 'recordOutputs']);

function summarize(value: unknown): string {
  if (Array.isArray(value)) return `[omitted: ${String(value.length)} items]`;
  if (typeof value === 'string')
    return `[omitted: ${String(value.length)} chars]`;
  return '[omitted]';
}

/** 防御性序列化：大块键换摘要、循环引用/BigInt 等一律降级占位、总长封顶。 */
export function curatePayload(event: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(event, (key: string, value: unknown) => {
      if (key === '') return value;
      if (DROPPED_KEYS.has(key)) return undefined;
      return OMITTED_KEYS.has(key) ? summarize(value) : value;
    });
  } catch (error) {
    return JSON.stringify({
      serializationError: error instanceof Error ? error.message : String(error),
    });
  }
  // JSON.stringify(undefined) === undefined（非字符串）——事件本身不该是
  // undefined，但遥测路径上一切皆防御。
  if (typeof json !== 'string') return '{}';
  if (json.length <= PAYLOAD_MAX_LENGTH) return json;
  return JSON.stringify({
    truncated: true,
    approximateLength: json.length,
  });
}

/** `"<agentSessionId>#<turn>"` → 两列；不合形状的 functionId（非 chat 来源）原样落 agent_session_id、turn 置空。 */
export function parseFunctionId(functionId: string | undefined): {
  agentSessionId: string | null;
  turn: number | null;
} {
  if (functionId === undefined || functionId.length === 0)
    return { agentSessionId: null, turn: null };
  const hash = functionId.lastIndexOf('#');
  if (hash <= 0) return { agentSessionId: functionId, turn: null };
  const turn = Number(functionId.slice(hash + 1));
  if (!Number.isInteger(turn)) return { agentSessionId: functionId, turn: null };
  return { agentSessionId: functionId.slice(0, hash), turn };
}

export interface TelemetryEventRow {
  id: number;
  agentSessionId: string | null;
  turn: number | null;
  eventType: string;
  ts: number;
  payloadJson: string;
}

export interface TelemetryStore {
  record(eventType: string, functionId: string | undefined, event: unknown): void;
  /** "用 turn 查一下"的程序化入口（测试与后续 API 共用）；直接 sqlite3 查 telemetry_events 表等价。 */
  list(agentSessionId: string, turn: number): TelemetryEventRow[];
  close(): void;
}

interface RawEventRow {
  id: number;
  agent_session_id: string | null;
  turn: number | null;
  event_type: string;
  ts: number;
  payload_json: string;
}

export function createTelemetryStore(path: string): TelemetryStore {
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  // 耗材式 schema 演化（docs/tech/telemetry.md §3）：检测到更名前的旧列
  // （2026-07-17 session_id → agent_session_id）直接重建整表——遥测无持久
  // 承诺，重建优于迁移；DROP TABLE 连带其索引一起消失。
  const tableInfo: unknown = sqlite.pragma('table_info(telemetry_events)');
  const hasLegacyColumn =
    Array.isArray(tableInfo) &&
    tableInfo.some(
      (column) =>
        typeof column === 'object' &&
        column !== null &&
        'name' in column &&
        column.name === 'session_id',
    );
  if (hasLegacyColumn) sqlite.exec('DROP TABLE telemetry_events;');
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS telemetry_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_session_id TEXT,
      turn INTEGER,
      event_type TEXT NOT NULL,
      ts INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS telemetry_events_session_turn
      ON telemetry_events (agent_session_id, turn);`,
  );
  const insert = sqlite.prepare(
    'INSERT INTO telemetry_events (agent_session_id, turn, event_type, ts, payload_json) VALUES (?, ?, ?, ?, ?)',
  );
  const select = sqlite.prepare(
    'SELECT id, agent_session_id, turn, event_type, ts, payload_json FROM telemetry_events WHERE agent_session_id = ? AND turn = ? ORDER BY id',
  );
  return {
    record(eventType, functionId, event): void {
      const { agentSessionId, turn } = parseFunctionId(functionId);
      insert.run(agentSessionId, turn, eventType, Date.now(), curatePayload(event));
    },
    list(agentSessionId, turn): TelemetryEventRow[] {
      const rows = select.all(agentSessionId, turn) as RawEventRow[];
      return rows.map((row) => ({
        id: row.id,
        agentSessionId: row.agent_session_id,
        turn: row.turn,
        eventType: row.event_type,
        ts: row.ts,
        payloadJson: row.payload_json,
      }));
    },
    close(): void {
      sqlite.close();
    },
  };
}

/** 事件对象上的 `functionId`（ai 把 TelemetryOptions 并进每个事件）——`onError` 的事件是 `unknown`，统一走守卫提取。 */
function functionIdOf(event: unknown): string | undefined {
  if (typeof event !== 'object' || event === null) return undefined;
  if (!('functionId' in event)) return undefined;
  const value = event.functionId;
  return typeof value === 'string' ? value : undefined;
}

/** 事件回调的公共包装：读 functionId → 落一行；任何异常就地吞掉（纪律 3）。 */
export function createSqliteTelemetry(store: TelemetryStore): Telemetry {
  const record =
    (eventType: string) =>
    (event: unknown): void => {
      try {
        store.record(eventType, functionIdOf(event), event);
      } catch {
        // 遥测永不影响 turn——写失败静默丢弃这一行。
      }
    };
  return {
    onStart: record('start'),
    onStepStart: record('step-start'),
    onLanguageModelCallStart: record('model-call-start'),
    onLanguageModelCallEnd: record('model-call-end'),
    // nimbo 的工具由 loop 自己结算，`settleExecution` 在 `executeToolCall` 前后
    // **替 AI SDK 补发** onToolExecutionStart/End（`@nimbo/core` loop.ts 的
    // `notifyToolExecution*`）——集成必须挂这两个回调才接得住，漏挂则工具耗时
    // 事件虽被 core 发出却无人记录（账本有 `toolDurationMs`、遥测却零工具事件）。
    onToolExecutionStart: record('tool-execution-start'),
    onToolExecutionEnd: record('tool-execution-end'),
    onStepEnd: record('step-end'),
    onEnd: record('end'),
    onAbort: record('abort'),
    onError: record('error'),
  };
}

// ---- 生产装配（routes/chat.ts 的默认 chatApp 用）----

let initialized = false;
let chatTelemetry: SessionTelemetry | undefined;
let chatTelemetryStore: TelemetryStore | undefined;

/**
 * 惰性单例：首次调用时建库（缺省 `telemetry.db`，`TELEMETRY_DB_PATH` 覆盖）。
 * 两个关闭口：`TELEMETRY_DISABLED=1` 显式关；vitest 环境（`VITEST` 存在）且
 * 未显式给 `TELEMETRY_DB_PATH` 时自动关——`routes/chat.ts` 在模块顶层就创建
 * 默认 chatApp，不加这道守卫，任何 import 它的测试都会在仓库里落一个
 * telemetry.db。`recordInputs`/`recordOutputs` 关死见文件头纪律 2。
 */
function initChatTelemetry(): void {
  if (initialized) return;
  initialized = true;
  const explicitPath = process.env.TELEMETRY_DB_PATH?.trim();
  const hasExplicitPath = explicitPath !== undefined && explicitPath.length > 0;
  const disabled =
    process.env.TELEMETRY_DISABLED === '1' ||
    (process.env.VITEST !== undefined && !hasExplicitPath);
  if (disabled) return;
  chatTelemetryStore = createTelemetryStore(
    hasExplicitPath ? explicitPath : 'telemetry.db',
  );
  chatTelemetry = {
    integrations: [createSqliteTelemetry(chatTelemetryStore)],
    recordInputs: false,
    recordOutputs: false,
  };
}

/** 写侧装配：注入 `buildSession` 的 `SessionTelemetry`（经 `ChatRouteDeps.telemetry`）。 */
export function getChatTelemetry(): SessionTelemetry | undefined {
  initChatTelemetry();
  return chatTelemetry;
}

/** 读侧装配：turn 遥测明细端点（`GET .../turns/:turn/telemetry`）经 `ChatRouteDeps.telemetryStore` 用它查数——与写侧共享同一个库/惰性初始化。 */
export function getChatTelemetryStore(): TelemetryStore | undefined {
  initChatTelemetry();
  return chatTelemetryStore;
}
