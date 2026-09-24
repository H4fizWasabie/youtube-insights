// youtube-insights/index.ts — extension exposing YouTube channel analytics for
// the 89lab channel (ai-agent-shorts pipeline), in the same shape as social-metrics:
//
//   youtube_insights_sync   — scan ledgers for published video_ids, snapshot
//                             per-video stats (views, likes, comments) via the
//                             Composio gateway. Run this before reporting.
//   youtube_insights_report — deterministic read-only report: ranked per-video
//                             table, topic rollup, per-day cadence rollup,
//                             totals. All aggregation is computed in collector.ts;
//                             the model transcribes, it does not do arithmetic.
//
// All writes go to ~/.theoses/agent/youtube-insights/data.db (extension-owned).
// API access is read-only by construction (youtube.ts only calls
// YOUTUBE_GET_VIDEO_DETAILS_BATCH) — same no-write-path rule as procura.

import { Type, type Static } from "typebox";
import type { ExtensionAPI } from "theoses-coding-agent";
import { loadConfig } from "./db.ts";
import { report, scanWorkspaces, syncInsights } from "./collector.ts";

function textResult(text: string, details: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

const SyncParams = Type.Object({});
const ReportParams = Type.Object({});
type SyncInput = Static<typeof SyncParams>;
type ReportInput = Static<typeof ReportParams>;

/**
 * These tools hand their errors back as ordinary result text (isError is unset), so the core `[tool] ... ok` journal
 * line cannot tell a failed call from a good one. Log failures here so the journal shows which tool failed and why.
 */
function logFailure(tool: string, error: unknown): void {
  console.error(`[youtube-insights] ${tool} failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
}

/** Per-video API errors do not throw (they are collected in the sync result), so surface them too. */
function logPartialErrors(tool: string, errors: string[]): void {
  if (errors.length === 0) return;
  console.error(`[youtube-insights] ${tool} finished with ${errors.length} error(s): ${errors.slice(0, 3).join(" | ").slice(0, 400)}`);
}

export default function youtubeInsightsExtension(theoses: ExtensionAPI) {
  // ponytail: process-local cooldown, resets on restart (same as social_metrics_fb_sync).
  const SYNC_COOLDOWN_MS = 3 * 60_000;
  let lastSyncAt = 0;
  let lastSyncResult: ReturnType<typeof textResult> | null = null;

  theoses.registerTool({
    name: "youtube_insights_sync",
    label: "YouTube insights sync",
    description:
      "Scan ai-agent-shorts ledgers for published video_ids and snapshot per-video YouTube stats (views, likes, comments) via the Composio gateway. Run this before youtube_insights_report. Cached for 3 minutes — calling it again sooner returns the same result instead of re-spending API budget.",
    parameters: SyncParams,
    async execute(_toolCallId: string, _params: SyncInput, signal: AbortSignal) {
      const now = Date.now();
      if (lastSyncResult && now - lastSyncAt < SYNC_COOLDOWN_MS) {
        return lastSyncResult;
      }
      const { dbPath, composioKeyPath, workspaceRoots, maxApiCalls } = await loadConfig();
      try {
        const scan = await scanWorkspaces(dbPath, workspaceRoots);
        const sync = await syncInsights(dbPath, { composioKeyPath }, { maxApiCalls }, signal);
        logPartialErrors("youtube_insights_sync", sync.errors);
        const lines = [
          `Scan: ${scan.found} ledger video ids seen, ${scan.inserted} upserted (${Object.entries(scan.perWorkspace).map(([ws, n]) => `${ws}: ${n}`).join(", ") || "none"}).`,
          `Sync: ${sync.synced} videos checked, ${sync.snapshots} snapshots stored, ${sync.dead} no longer retrievable (marked deleted).`,
          ...(sync.errors.length > 0 ? [`Errors: ${sync.errors.slice(0, 5).join(" | ")}`] : []),
        ];
        lastSyncAt = now;
        lastSyncResult = textResult(lines.join("\n"), { scan, sync });
        return lastSyncResult;
      } catch (e) {
        logFailure("youtube_insights_sync", e);
        return textResult(`youtube_insights_sync failed: ${e instanceof Error ? e.message : String(e)}`, {});
      }
    },
  });

  theoses.registerTool({
    name: "youtube_insights_report",
    label: "YouTube insights report",
    description:
      "Deterministic YouTube channel report (89lab / ai-agent-shorts): per-video table ranked by views (views, likes, comments, views-per-day, topic), topic rollup ranked by avg views/day, per-publish-day cadence rollup (videos/day vs avg views), and totals. Read-only; does not call the YouTube API. All aggregation is computed in code — transcribe the numbers, do not recompute them.",
    parameters: ReportParams,
    async execute(_toolCallId: string, _params: ReportInput) {
      const { dbPath } = await loadConfig();
      try {
        const r = await report(dbPath);
        if (r.videos.length === 0) {
          return textResult("No videos registered yet. Run youtube_insights_sync first.", r);
        }
        const t = r.totals;
        const lines: string[] = [];
        lines.push(
          `Totals: ${t.live}/${t.videos} live videos, ${t.views} views, ${t.likes} likes, ${t.comments} comments (avg ${t.avg_views}, median ${t.median_views}, avg ${t.avg_views_per_day} views/day).`,
        );
        lines.push("");
        lines.push("Topics (ranked by avg views/day):");
        for (const g of r.by_topic) {
          lines.push(`  ${g.topic}: ${g.videos} videos, avg ${g.avg_views} views, avg ${g.avg_views_per_day} views/day`);
        }
        lines.push("");
        lines.push("Publish cadence (videos/day -> avg views):");
        for (const d of r.by_day) {
          lines.push(`  ${d.date}: ${d.videos} videos -> avg ${d.avg_views} views`);
        }
        lines.push("");
        for (const v of r.videos) {
          const mark = v.deleted_at ? "[dead] " : "";
          lines.push(
            `${mark}${v.published_at} views=${v.views} likes=${v.likes} comments=${v.comments} vpd=${v.views_per_day} dur=${v.duration_s ?? "?"}s topic=${v.topic}\n    ${v.title ?? "(no title)"} — ${v.repo ?? "no repo"}\n    id=${v.video_id}`,
          );
        }
        return textResult(lines.join("\n"), r);
      } catch (e) {
        logFailure("youtube_insights_report", e);
        return textResult(`youtube_insights_report failed: ${e instanceof Error ? e.message : String(e)}`, {});
      }
    },
  });
}
