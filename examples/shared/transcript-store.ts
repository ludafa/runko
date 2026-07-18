/**
 * transcript-store — persists a session's full execution transcript (every
 * `NimboChunk` from `session.stream()` + the final `TurnResult` + the serialized `SessionState`)
 * into a local SQLite database, using Node's built-in `node:sqlite`
 * (zero new dependencies; prints one ExperimentalWarning on Node 24, which
 * is cosmetic — the DatabaseSync API surface used here has been unchanged
 * since it shipped).
 *
 * Layout: one `runs` row per session run, N `events` rows keyed by
 * `(run_id, seq)` in arrival order. Everything variable-shaped is stored as
 * JSON text — the point is a durable, queryable transcript, not a relational
 * model of nimbo's event union:
 *
 *   sqlite3 .transcripts/examples-transcript.sqlite \
 *     "SELECT type, COUNT(*) FROM events GROUP BY type"
 *
 * The default DB path is `<repo>/.transcripts/examples-transcript.sqlite`
 * (gitignored via the `.transcripts/` rule, so transcripts can never be
 * committed); override with `NIMBO_TRANSCRIPT_DB=/path/to.sqlite`. It lives
 * in its own directory rather than under `.env` on purpose — the repo root
 * `.env` is a config *file* (see `.env.template`), not a directory.
 */
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { NimboChunk, SessionState, TurnResult } from "@nimbo/sdk";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id                 TEXT PRIMARY KEY,
  example            TEXT NOT NULL,
  session_id         TEXT NOT NULL,
  started_at         TEXT NOT NULL,
  finished_at        TEXT,
  status             TEXT NOT NULL DEFAULT 'running',
  final_response     TEXT,
  usage_json         TEXT,
  session_state_json TEXT,
  error              TEXT,
  meta_json          TEXT
);
CREATE TABLE IF NOT EXISTS events (
  run_id       TEXT NOT NULL REFERENCES runs(id),
  seq          INTEGER NOT NULL,
  ts           TEXT NOT NULL,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
`;

/** Default path: `<repo>/.transcripts/examples-transcript.sqlite` (see header). */
export function resolveTranscriptDbPath(): string {
  const override = process.env.NIMBO_TRANSCRIPT_DB?.trim();
  if (override !== undefined && override.length > 0) return override;
  const examplesDir = dirname(dirname(fileURLToPath(import.meta.url)));
  return join(examplesDir, "..", ".transcripts", "examples-transcript.sqlite");
}

export class TranscriptStore {
  readonly dbPath: string;
  private readonly db: DatabaseSync;
  private seq = 0;

  // No parameter properties (`constructor(readonly x…)`) — Node's strip-only
  // TS mode rejects them (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX), same constraint
  // as the rest of examples/.
  constructor(dbPath: string = resolveTranscriptDbPath()) {
    this.dbPath = dbPath;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
  }

  /** Insert the `runs` row up front so an interrupted run still leaves a 'running' record behind. */
  startRun(input: { example: string; sessionId: string; meta?: Record<string, string> }): string {
    const runId = randomUUID();
    this.db
      .prepare("INSERT INTO runs (id, example, session_id, started_at, meta_json) VALUES (?, ?, ?, ?, ?)")
      .run(runId, input.example, input.sessionId, new Date().toISOString(), JSON.stringify(input.meta ?? {}));
    return runId;
  }

  recordEvent(runId: string, chunk: NimboChunk): void {
    this.seq += 1;
    this.db
      .prepare("INSERT INTO events (run_id, seq, ts, type, payload_json) VALUES (?, ?, ?, ?, ?)")
      .run(runId, this.seq, new Date().toISOString(), chunk.type, JSON.stringify(chunk));
  }

  finishRun(
    runId: string,
    outcome:
      | { status: "completed"; result: TurnResult; sessionState: SessionState }
      | { status: "failed"; error: string },
  ): void {
    if (outcome.status === "completed") {
      this.db
        .prepare(
          "UPDATE runs SET finished_at = ?, status = 'completed', final_response = ?, usage_json = ?, session_state_json = ? WHERE id = ?",
        )
        .run(
          new Date().toISOString(),
          outcome.result.finalResponse,
          JSON.stringify(outcome.result.usage),
          JSON.stringify(outcome.sessionState),
          runId,
        );
      return;
    }
    this.db
      .prepare("UPDATE runs SET finished_at = ?, status = 'failed', error = ? WHERE id = ?")
      .run(new Date().toISOString(), outcome.error, runId);
  }

  close(): void {
    this.db.close();
  }
}
