// youtube-insights/db.ts — SQLite persistence for the youtube-insights extension.
// WRITE-OWNED by this extension (like social-metrics, unlike procura): the sync
// tool is the only writer, report only reads. Data lives outside the repo so
// restarts/updates never lose snapshot history.

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { mkdir, readFile } from "node:fs/promises";

const run = promisify(execFile);

export type Row = Record<string, unknown>;

export const DEFAULT_DATA_DIR = join(homedir(), ".theoses", "agent", "youtube-insights");
export const DEFAULT_DB_PATH = join(DEFAULT_DATA_DIR, "data.db");

export interface YoutubeInsightsConfig {
  db_path?: string;
  composio_key_path?: string;
  workspace_roots?: string[];
  max_api_calls_per_sync?: number;
}

const DEFAULT_CONFIG = {
  db_path: DEFAULT_DB_PATH,
  // Bearer key lives next to the GitHub-repo-highlight/FB tooling; single source of truth.
  composio_key_path: join(homedir(), "icm-workspaces/github-repo-highlight/tools/composio.json"),
  workspace_roots: [join(homedir(), "icm-workspaces/ai-agent-shorts")],
  max_api_calls_per_sync: 25,
};

export async function loadConfig(): Promise<{
  dbPath: string;
  composioKeyPath: string;
  workspaceRoots: string[];
  maxApiCalls: number;
}> {
  const configPath = join(homedir(), ".theoses", "agent", "youtube-insights.json");
  let overrides: YoutubeInsightsConfig = {};
  try {
    overrides = JSON.parse(await readFile(configPath, "utf8")) as YoutubeInsightsConfig;
  } catch {
    overrides = {};
  }
  const cfg = { ...DEFAULT_CONFIG, ...overrides };
  return {
    dbPath: cfg.db_path ?? DEFAULT_DB_PATH,
    composioKeyPath: cfg.composio_key_path ?? DEFAULT_CONFIG.composio_key_path,
    workspaceRoots: cfg.workspace_roots ?? DEFAULT_CONFIG.workspace_roots,
    maxApiCalls: cfg.max_api_calls_per_sync ?? DEFAULT_CONFIG.max_api_calls_per_sync,
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS videos (
  video_id     TEXT PRIMARY KEY,
  workspace    TEXT NOT NULL,
  source_file  TEXT NOT NULL,
  first_seen   TEXT NOT NULL,
  published_at TEXT,
  title        TEXT,
  repo         TEXT,
  duration_s   INTEGER,
  deleted_at   TEXT
);
CREATE TABLE IF NOT EXISTS metric_snapshots (
  video_id    TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  views    INTEGER,
  likes    INTEGER,
  comments INTEGER,
  PRIMARY KEY (video_id, captured_at)
);
CREATE INDEX IF NOT EXISTS idx_snapshots_video ON metric_snapshots(video_id, captured_at);
`;

export async function ensureSchema(dbPath: string): Promise<void> {
  await mkdir(join(dbPath, ".."), { recursive: true });
  await run("sqlite3", [dbPath, SCHEMA], { timeout: 10_000 });
}

export async function execSql(dbPath: string, sql: string, timeoutMs = 10_000): Promise<string> {
  const { stdout } = await run("sqlite3", ["-json", dbPath, sql], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

export async function queryRows(dbPath: string, sql: string): Promise<Row[]> {
  const out = await execSql(dbPath, sql);
  if (!out) return [];
  const parsed: unknown = JSON.parse(out);
  return Array.isArray(parsed) ? (parsed as Row[]) : [];
}

export async function queryOne(dbPath: string, sql: string): Promise<Row | undefined> {
  const rows = await queryRows(dbPath, sql);
  return rows[0];
}
