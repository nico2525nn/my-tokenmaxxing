# My TokenMaxxing

Local dashboard for LLM token usage across coding agents. Reads eight agent logs directly, shows one page. Single Go binary, no runtime dependencies, no cost tracking.

<img width="1050" alt="dashboard screenshot" src="docs/screenshot-dashboard.webp" />

## Quick start

```bash
make run
# → http://localhost:3642
```

Needs Go 1.26+. Every source is read directly from its own logs — no ccusage, no
runtime dependencies, no network calls.

## What it does

- **Aggregates** Codex, OpenCode, pi, OMP, ZCode, Reasonix, OpenGrok, and DSH logs into one daily summary
- **Displays** a stacked token chart with per-day tooltips, period filters (7D / 30D / 90D / ALL / custom), per-model and per-harness breakdowns with cache hit rates
- **Profile** via `?name=…&avatar=…` or the in-page Edit button (browser-local)

## Data sources

| Source | Read from | Status |
|--------|-----------|--------|
| Codex | `~/.codex/sessions`, `~/.codex/archived_sessions` (incl. `.jsonl.zst`) | ✅ |
| OpenCode | `~/.local/share/opencode/opencode.db` | ✅ |
| pi | `~/.pi/agent/sessions/*.jsonl` | ✅ |
| OMP | `~/.omp/agent/sessions/*.jsonl` | ✅ |
| ZCode | `~/.zcode/cli/db/db.sqlite` | ✅ |
| Reasonix | `%APPDATA%/reasonix/projects/*/sessions/*.telemetry.json` | ✅ |
| OpenGrok | `$OPENGROK_HOME/sessions/**/usage.json` (else `~/.opengrok`) | ✅ |
| DSH | `$DSH_HOME/storages/session_projcache/sessions/*.json` (else `~/.dsh`) | ✅ session totals attributed to the last-prompt day (daily spikes are approximate) |

Reader details and token semantics: `docs/data-sources.md`.
Reader spec: `token-reading-logic.md` (Japanese).

## Performance

| | before (ccusage + Node) | now (Go) |
|---|---|---|
| First build, empty cache | 55s | **2.4s** |
| Rebuild, warm cache | 1.2s | **0.8s** |
| Refresh with no changes | 0.03s | **~0.02s** |
| Resident memory | 37MB | **~14MB** |
| Parse cache on disk | 282KB | **365KB** (capped at 8MB) |

The win comes from three things: byte-level scanning that never decodes lines it
does not need, splitting multi-gigabyte rollouts across cores, and caching each
file's aggregated rows by mtime+size so unchanged logs are never re-read.

## Layout

```
cmd/tokenmaxxing/main.go   HTTP server, refresh loop, snapshot cache
internal/sources/          one reader per agent + per-file cache
internal/scan/             byte-level JSONL/zstd scanner
internal/jsonx/            allocation-free JSON field extraction
internal/aggregate/        rollups, streaks, change stamp
internal/cache/            hashed, size-capped parse cache
internal/model/            dashboard payload types
public/index.html          dashboard UI (shadcn-style, zero dependencies)
public/tmx.js              shared dashboard helpers
```

## License

MIT
