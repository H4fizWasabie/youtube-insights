# youtube-insights (Theoses extension)

Snapshots per-video YouTube stats (views, likes, comments) for the ai-agent-shorts
channel through the Composio gateway, and powers the deterministic channel report.
Composio credentials are read from a local `composio.json` (gitignored) — never committed.

Deployed live at `~/.theoses/agent/extensions/youtube-insights/` on the Theoses VPS.
CI: `tsc --noEmit` against theoses2 typings on every push/PR touching `*.ts`.
