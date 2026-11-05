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

| | before | now |
|---|---|---|
| First data on screen (empty cache) | 2.4s | **0.6s** |
| Complete snapshot (empty cache) | 2.4s | **2.4s** |
| Warm restart (nothing changed) | 2.4s rebuild | **~0.02s, no rebuild** |
| Peak RSS (cold build) | 246MB | **126MB** |
| Resident after build | 40MB | **7.6MB** |
| Parse cache on disk | 365KB | **365KB** (capped at 8MB) |

Two passes share one worker pool: uncompressed logs are scheduled first and
published immediately, then the immutable `.jsonl.zst` archives are folded in
behind them. The page shows the early snapshot with "archives still loading"
until the complete totals land.

### Page load

Measured with Chrome DevTools throttling at 300ms RTT / 1.5 Mbit, cache disabled:

| | before | now |
|---|---|---|
| First contentful paint | 752ms | **470ms** |
| Load complete | 1848ms | **1216ms** |
| Bytes transferred | ~111KB + third-party | **78KB, zero third-party** |
| Combined requests | 4 (2 external) | **3 (all local)** |

What changed: responses are gzipped (75KB HTML → 19KB, 35KB JSON → 6KB), the
script is inlined so the page needs no second round trip, the favicon request is
suppressed, and the two fonts are self-hosted variable files instead of a
render-blocking Google Fonts stylesheet. The avatar no longer phones GitHub on
every load.

The win comes from four things: byte-level scanning that never decodes lines it
does not need, splitting multi-gigabyte rollouts across cores, allocation-free
JSON field extraction, and caching each file's aggregated rows by mtime+size so
unchanged logs are never re-read.

## Layout

```
cmd/tokenmaxxing/main.go   HTTP server, refresh loop, snapshot cache
internal/sources/          one reader per agent + per-file cache
internal/scan/             byte-level JSONL/zstd scanner
internal/jsonx/            allocation-free JSON field extraction
internal/aggregate/        rollups, streaks, change stamp
internal/cache/            hashed, size-capped parse cache
internal/model/            dashboard payload types
public/index.html          dashboard UI (shadcn-style, inlined CSS+JS)
public/fonts/              self-hosted Inter and Geist Mono (variable)
```

## License

MIT
