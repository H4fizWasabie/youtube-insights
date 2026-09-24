// youtube-insights/collector.ts — deterministic scan + sync + report logic.
//
// ZTA rule (why this extension exists): every number in the report is computed
// HERE, in code — rankings, averages, medians, topic grouping, cadence rollups.
// The calling model only transcribes; it never does arithmetic. Same inputs,
// same output, every run.
//
// Data flow (mirrors social-metrics):
//   scanWorkspaces  ledger.jsonl (source of truth for what was published) -> videos table
//   syncInsights    Composio YouTube stats -> metric_snapshots (append-only history)
//   report          reads DB only, no API calls, no writes

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureSchema, execSql, queryRows, type Row } from "./db.ts";
import { fetchVideoStats, type YoutubeConfig } from "./youtube.ts";

const MIN_VIDEO_ID_LENGTH = 8; // YouTube ids are 11 chars; guard against junk

interface LedgerEntry {
  date?: string;
  video_id?: string | null;
  title?: string | null;
  repo?: string | null;
  duration_s?: number | null;
  deleted?: string | null;
}

/** Register ledger videos into the videos table. Idempotent. */
export async function scanWorkspaces(dbPath: string, workspaceRoots: string[]): Promise<{ found: number; inserted: number; perWorkspace: Record<string, number> }> {
  await ensureSchema(dbPath);
  let found = 0;
  let inserted = 0;
  const perWorkspace: Record<string, number> = {};
  for (const root of workspaceRoots) {
    const sourceFile = join(root, "state", "ledger.jsonl");
    let raw: string;
    try {
      raw = await readFile(sourceFile, "utf8");
    } catch {
      continue; // workspace without a ledger is normal
    }
    const workspace = root.split("/").filter(Boolean).pop() ?? root;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let e: LedgerEntry;
      try {
        e = JSON.parse(line) as LedgerEntry;
      } catch {
        continue;
      }
      const vid = typeof e.video_id === "string" ? e.video_id.trim() : "";
      if (vid.length < MIN_VIDEO_ID_LENGTH) continue;
      found += 1;
      const escaped = (v: unknown) => (v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
      await execSql(
        dbPath,
        `INSERT OR IGNORE INTO videos (video_id, workspace, source_file, first_seen, title, repo, duration_s, deleted_at)
VALUES (${escaped(vid)}, ${escaped(workspace)}, ${escaped(sourceFile)}, ${escaped(e.date ?? "1970-01-01")}, ${escaped(e.title)}, ${escaped(e.repo)}, ${e.duration_s ?? "NULL"}, ${escaped(e.deleted ?? null)});`,
      );
      inserted += 1;
    }
    perWorkspace[workspace] = (perWorkspace[workspace] ?? 0) + 1;
  }
  return { found, inserted, perWorkspace };
}

/** Snapshot current stats for live videos (one API call per video, capped). Append-only. */
export async function syncInsights(
  dbPath: string,
  ytCfg: YoutubeConfig,
  opts: { maxApiCalls: number },
  signal?: AbortSignal,
): Promise<{ synced: number; snapshots: number; dead: number; errors: string[] }> {
  await ensureSchema(dbPath);
  void signal; // timeouts handled inside the youtube client
  const rows = await queryRows(dbPath, `SELECT video_id FROM videos WHERE deleted_at IS NULL ORDER BY video_id;`);
  const errors: string[] = [];
  let synced = 0;
  let snapshots = 0;
  let dead = 0;
  for (const row of rows) {
    if (synced >= opts.maxApiCalls) break;
    const vid = String(row.video_id).replace(/'/g, "''");
    synced += 1;
    try {
      const s = await fetchVideoStats(String(row.video_id), ytCfg);
      if (!s.found) {
        await execSql(dbPath, `UPDATE videos SET deleted_at = datetime('now') WHERE video_id = '${vid}' AND deleted_at IS NULL;`);
        dead += 1;
        continue;
      }
      const nullNum = (v: number | null) => (v == null ? "NULL" : String(v));
      const q = (v: string | null) => (v == null ? "NULL" : `'${v.replace(/'/g, "''")}'`);
      await execSql(
        dbPath,
        `INSERT OR REPLACE INTO metric_snapshots (video_id, captured_at, views, likes, comments)
VALUES ('${vid}', datetime('now'), ${nullNum(s.views)}, ${nullNum(s.likes)}, ${nullNum(s.comments)});`,
      );
      snapshots += 1;
      // Backfill/refresh metadata learned from the API (published_at, live title, duration).
      await execSql(
        dbPath,
        `UPDATE videos SET title = COALESCE(${q(s.title)}, title), duration_s = COALESCE(${s.duration_s ?? "NULL"}, duration_s),
  published_at = COALESCE(${q(s.published_at)}, published_at, first_seen)
WHERE video_id = '${vid}';`,
      );
    } catch (e) {
      errors.push(`${String(row.video_id)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { synced, snapshots, dead, errors };
}

// ---------------------------------------------------------------- report ----

export interface VideoReportRow {
  video_id: string;
  title: string | null;
  repo: string | null;
  topic: string;
  published_at: string;
  duration_s: number | null;
  views: number;
  likes: number;
  comments: number;
  views_per_day: number;
  deleted_at: string | null;
}

export interface TopicRollup {
  topic: string;
  videos: number;
  avg_views: number;
  avg_views_per_day: number;
}

export interface DayRollup {
  date: string;
  videos: number;
  avg_views: number;
}

export interface YoutubeReport {
  totals: { videos: number; live: number; views: number; likes: number; comments: number; avg_views: number; median_views: number; avg_views_per_day: number };
  by_topic: TopicRollup[];
  by_day: DayRollup[];
  videos: VideoReportRow[];
}

/** Deterministic topic grouping: first matching keyword group wins, in this fixed order. */
export function classifyTopic(title: string | null, repo: string | null): string {
  const hay = `${title ?? ""} ${repo ?? ""}`.toLowerCase();
  if (/(browser|web)/.test(hay) && /(agent|automation|use|control|click|playwright|selenium|puppeteer)/.test(hay)) return "browser-automation";
  if (/voice|speech|whisper|hands[- ]?free|talk to/.test(hay)) return "voice";
  if (/computer use|desktop|phone|mobile|screen/.test(hay)) return "computer-use";
  if (/audit|security|secure/.test(hay)) return "security";
  if (/review|lint|code quality/.test(hay)) return "code-review";
  return "other";
}

function avg(nums: number[]): number {
  return nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10 : 0;
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] + s[mid]) / 2) * 10) / 10;
}

function daysBetween(laterIso: string, earlierIso: string): number {
  const ms = Date.parse(laterIso) - Date.parse(earlierIso);
  return Number.isFinite(ms) ? ms / 86_400_000 : 0;
}

/** Read-only report. All aggregation happens here, never in the model. */
export async function report(dbPath: string): Promise<YoutubeReport> {
  await ensureSchema(dbPath);
  const rows = await queryRows(
    dbPath,
    `SELECT v.video_id, v.title, v.repo, v.duration_s, v.deleted_at,
            COALESCE(v.published_at, v.first_seen) AS published_at,
            m.views, m.likes, m.comments, m.captured_at
     FROM videos v
     JOIN (SELECT video_id, MAX(captured_at) AS latest FROM metric_snapshots GROUP BY video_id) last
       ON last.video_id = v.video_id
     JOIN metric_snapshots m ON m.video_id = last.video_id AND m.captured_at = last.latest
     ORDER BY v.video_id;`,
  );
  const nowIso = new Date().toISOString();
  const videos: VideoReportRow[] = rows.map((r: Row) => {
    const publishedAt = String(r.published_at ?? "").slice(0, 10) || "1970-01-01";
    const capturedAt = String(r.captured_at ?? nowIso);
    const views = Number(r.views ?? 0);
    // Views per day since publish (min 1 day so same-day videos don't divide by zero).
    const ageDays = Math.max(1, daysBetween(capturedAt.slice(0, 10), publishedAt));
    return {
      video_id: String(r.video_id),
      title: (r.title as string) ?? null,
      repo: (r.repo as string) ?? null,
      topic: classifyTopic((r.title as string) ?? null, (r.repo as string) ?? null),
      published_at: publishedAt,
      duration_s: r.duration_s == null ? null : Number(r.duration_s),
      views,
      likes: Number(r.likes ?? 0),
      comments: Number(r.comments ?? 0),
      views_per_day: Math.round((views / ageDays) * 10) / 10,
      deleted_at: (r.deleted_at as string) ?? null,
    };
  });
  // Deterministic rank: views desc, then views_per_day desc, then video_id asc.
  videos.sort((a, b) => b.views - a.views || b.views_per_day - a.views_per_day || a.video_id.localeCompare(b.video_id));

  const live = videos.filter((v) => !v.deleted_at);
  const viewsList = live.map((v) => v.views);

  const topicMap = new Map<string, VideoReportRow[]>();
  for (const v of live) topicMap.set(v.topic, [...(topicMap.get(v.topic) ?? []), v]);
  const by_topic: TopicRollup[] = [...topicMap.entries()]
    .map(([topic, vs]) => ({
      topic,
      videos: vs.length,
      avg_views: avg(vs.map((v) => v.views)),
      avg_views_per_day: avg(vs.map((v) => v.views_per_day)),
    }))
    .sort((a, b) => b.avg_views_per_day - a.avg_views_per_day || a.topic.localeCompare(b.topic));

  const dayMap = new Map<string, VideoReportRow[]>();
  for (const v of live) dayMap.set(v.published_at, [...(dayMap.get(v.published_at) ?? []), v]);
  const by_day: DayRollup[] = [...dayMap.entries()]
    .map(([date, vs]) => ({ date, videos: vs.length, avg_views: avg(vs.map((v) => v.views)) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    totals: {
      videos: videos.length,
      live: live.length,
      views: viewsList.reduce((a, b) => a + b, 0),
      likes: live.reduce((a, v) => a + v.likes, 0),
      comments: live.reduce((a, v) => a + v.comments, 0),
      avg_views: avg(viewsList),
      median_views: median(viewsList),
      avg_views_per_day: avg(live.map((v) => v.views_per_day)),
    },
    by_topic,
    by_day,
    videos,
  };
}
