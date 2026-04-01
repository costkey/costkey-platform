import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const DATA_DIR = process.env["COSTKEY_DATA_DIR"] ?? path.join(process.cwd(), ".costkey-data");

export function createDatabase(): Database.Database {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const dbPath = path.join(DATA_DIR, "costkey.db");
  const db = new Database(dbPath);

  // WAL mode for better concurrent read/write
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  initSchema(db);
  return db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      project_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT,
      url TEXT,
      method TEXT,
      status_code INTEGER,

      input_tokens INTEGER,
      output_tokens INTEGER,
      total_tokens INTEGER,
      reasoning_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_creation_tokens INTEGER,

      cost_usd REAL,
      duration_ms REAL,
      streaming INTEGER DEFAULT 0,

      ttft REAL,
      tps REAL,
      stream_duration REAL,
      chunk_count INTEGER,

      call_site_raw TEXT,
      call_site_frames TEXT,  -- JSON

      trace_id TEXT,            -- groups events from same request/operation
      trace_name TEXT,          -- human-readable trace label
      context TEXT,           -- JSON
      request_body TEXT,      -- JSON
      response_body TEXT,     -- JSON

      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_events_project_ts
      ON events(project_id, timestamp DESC);

    CREATE INDEX IF NOT EXISTS idx_events_project_model
      ON events(project_id, model);

    CREATE INDEX IF NOT EXISTS idx_events_project_provider
      ON events(project_id, provider);

    CREATE INDEX IF NOT EXISTS idx_events_trace
      ON events(project_id, trace_id);
  `);

  // Aggregated call sites table (materialized view equivalent)
  db.exec(`
    CREATE TABLE IF NOT EXISTS call_site_stats (
      project_id TEXT NOT NULL,
      call_site_key TEXT NOT NULL,  -- fingerprint of file:function:line
      file_name TEXT,
      function_name TEXT,
      line_number INTEGER,
      provider TEXT,
      model TEXT,

      total_calls INTEGER DEFAULT 0,
      total_cost_usd REAL DEFAULT 0,
      total_input_tokens INTEGER DEFAULT 0,
      total_output_tokens INTEGER DEFAULT 0,
      avg_duration_ms REAL DEFAULT 0,
      avg_ttft REAL,
      avg_tps REAL,

      first_seen TEXT,
      last_seen TEXT,

      PRIMARY KEY (project_id, call_site_key, model)
    );

    CREATE INDEX IF NOT EXISTS idx_callsite_project_cost
      ON call_site_stats(project_id, total_cost_usd DESC);
  `);

  // Projects table
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      auth_key TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}
