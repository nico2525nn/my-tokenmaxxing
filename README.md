# My TokenMaxxing

Local dashboard for LLM token usage across coding agents. Reads eight agent logs directly, shows one page. No build step, no cost tracking.

<img width="1050" alt="dashboard screenshot" src="docs/screenshot-dashboard.webp" />

## Quick start

```bash
bun install
bun run server/index.js
# → http://localhost:3642
```

Needs [Bun](https://bun.sh) 1.3+ or Node.js 22.5+. Every source is read directly
from its own logs — no ccusage, no network calls.

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
| Claude, Gemini, Copilot | via `ccusage` fallback only | ⚠️ needs setup |
| OMP | `~/.omp/agent/sessions/*.jsonl` | ✅ |
| ZCode | `~/.zcode/cli/db/db.sqlite` | ✅ (Bun, or Node 22.5+ via node:sqlite) |
| Reasonix | `%APPDATA%/reasonix/projects/*/sessions/*.telemetry.json` | ✅ |
| OpenGrok | `$OPENGROK_HOME/sessions/**/usage.json` (else `~/.opengrok`) | ✅ |
| DSH | `$DSH_HOME/storages/session_projcache/sessions/*.json` (else `~/.dsh`) | ✅ session totals attributed to the last-prompt day (daily spikes are approximate) |

Reader details and token semantics: `docs/data-sources.md`.
Reader spec: `token-reading-logic.md` (Japanese).

`ccusage` is optional now: it only runs when the direct readers find nothing
(`TOKENMAXXING_CCUSAGE=1` forces it). Reading logs in-process with a per-file
cache took a refresh from ~8s to 1.2s cold and 0.03s when nothing changed.

## Layout

```
server/index.js            express server (API + static files)
server/data-fetcher.js     collectors + aggregation
server/readers.js          direct log readers + per-file cache
server/refresh-dashboard.js  background aggregation worker
public/index.html          dashboard UI (shadcn-style, zero dependencies)
public/tmx.js              shared dashboard helpers
test/aggregation.test.js   npm test
```

## License

MIT
