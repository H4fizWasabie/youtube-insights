// youtube-insights/youtube.ts — read-only YouTube Data API access for the
// youtube-insights extension, via the Composio MCP gateway (same gateway and
// bearer key as social-metrics/facebook.ts and the ai-agent-shorts uploader).
//
// Read-only by construction: the ONLY Composio slug referenced in this file is
// YOUTUBE_GET_VIDEO_DETAILS_BATCH. Upload/update/delete slugs are never used,
// mirroring the procura extension's no-write-path rule.
//
// API note (verified 2026-09-24 during the channel audit): YOUTUBE_GET_VIDEO_DETAILS_BATCH
// with MULTIPLE ids returns zero items (found_count absent). One id per call
// works reliably — sync loops one video per call. Do not "optimize" to a batch.

import { readFile } from "node:fs/promises";

export interface YoutubeConfig {
  composioKeyPath: string;
}

interface ComposioCreds {
  composio_key: string;
  composio_url: string;
}

const DEFAULT_COMPOSIO_URL = "https://connect.composio.dev/mcp";
const HTTP_TIMEOUT_MS = 60_000;

async function loadCreds(cfg: YoutubeConfig): Promise<ComposioCreds> {
  const raw = JSON.parse(await readFile(cfg.composioKeyPath, "utf8")) as {
    url?: string;
    headers?: { Authorization?: string };
  };
  const auth = raw.headers?.Authorization ?? "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
  if (!key) throw new Error("composio.json missing headers.Authorization bearer key");
  return { composio_key: key, composio_url: raw.url ?? DEFAULT_COMPOSIO_URL };
}

let mcpSid: string | null = null;

/** Minimal JSON-RPC client for the Composio MCP gateway (same protocol as social-metrics/facebook.ts). */
async function rpc(creds: ComposioCreds, payload: Record<string, unknown>): Promise<any> {
  const res = await fetch(creds.composio_url, {
    method: "POST",
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${creds.composio_key}`,
      ...(mcpSid ? { "mcp-session-id": mcpSid } : {}),
    },
    body: JSON.stringify(payload),
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid) mcpSid = sid;
  const body = await res.text();
  if (!res.ok) throw new Error(`composio HTTP ${res.status}: ${body.slice(0, 200)}`);
  // Response may be SSE-framed; take the first data: line that parses as JSON.
  let json: any = null;
  if (body.startsWith("{") || body.startsWith("[")) {
    json = JSON.parse(body);
  } else {
    for (const line of body.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      try {
        json = JSON.parse(t.slice(5).trim());
        break;
      } catch {
        continue;
      }
    }
  }
  if (!json) throw new Error(`composio returned no JSON (first 200 chars: ${body.slice(0, 200)})`);
  return json;
}

function extractResult(rpcResp: any): any {
  const content = rpcResp?.result?.content ?? rpcResp?.result;
  if (Array.isArray(content)) {
    const text = content.map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).join("");
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return content;
}

async function callTool(creds: ComposioCreds, toolSlug: string, args: Record<string, unknown>): Promise<any> {
  // initialize handshake first (gateway requires a session)
  try {
    await rpc(creds, {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "youtube-insights", version: "1.0.0" } },
    });
    await rpc(creds, { jsonrpc: "2.0", method: "notifications/initialized" });
  } catch {
    /* best-effort: some gateways allow stateless calls */
  }
  const init = await rpc(creds, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: toolSlug, arguments: args }], current_step: "EXECUTE" } },
  });
  const outer = extractResult(init);
  // COMPOSIO_MULTI_EXECUTE_TOOL returns {data:{results:[{response,tool_slug}]}}
  const results = outer?.data?.results;
  if (Array.isArray(results) && results.length > 0) {
    const r = results[0];
    if (r.response?.successful === false) {
      throw new Error(`${toolSlug}: ${r.response.error ?? r.response.data?.message ?? "unknown tool error"}`);
    }
    return r.response?.data ?? r.response;
  }
  return outer;
}

export interface VideoStats {
  video_id: string;
  title: string | null;
  published_at: string | null; // ISO date (YYYY-MM-DD)
  duration_s: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  found: boolean; // false = video no longer retrievable (deleted/private)
}

/** ISO-8601 duration (PT43S / PT1M5S) to seconds; null when unparseable. */
function isoDurationSeconds(d: unknown): number | null {
  if (typeof d !== "string") return null;
  const m = d.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  return (Number(m[1] ?? 0) * 3600) + (Number(m[2] ?? 0) * 60) + Number(m[3] ?? 0);
}

/** Stats + metadata for ONE video. One API call. */
export async function fetchVideoStats(videoId: string, cfg: YoutubeConfig): Promise<VideoStats> {
  const creds = await loadCreds(cfg);
  const d = await callTool(creds, "YOUTUBE_GET_VIDEO_DETAILS_BATCH", {
    id: [videoId],
    parts: ["snippet", "statistics", "contentDetails"],
  });
  const items = d?.items ?? [];
  if (!items.length) {
    return { video_id: videoId, title: null, published_at: null, duration_s: null, views: null, likes: null, comments: null, found: false };
  }
  const it = items[0];
  const sn = it.snippet ?? {};
  const st = it.statistics ?? {};
  const cd = it.contentDetails ?? {};
  const num = (v: unknown): number | null => (v == null || v === "" ? null : Number(v));
  return {
    video_id: videoId,
    title: typeof sn.title === "string" ? sn.title : null,
    published_at: typeof sn.publishedAt === "string" ? sn.publishedAt.slice(0, 10) : null,
    duration_s: isoDurationSeconds(cd.duration),
    views: num(st.viewCount),
    likes: num(st.likeCount),
    comments: num(st.commentCount),
    found: true,
  };
}
