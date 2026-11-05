# Data sources and readers

The dashboard reads every coding agent's local usage logs itself. There is no
external aggregator, no build step, and no third-party runtime dependency.

## Sources

| Source | Location | Reader |
|--------|----------|--------|
| Codex | `~/.codex/sessions`, `~/.codex/archived_sessions` (`.jsonl`, `.jsonl.zst`) | `parseCodex` in `server/readers.js` |
| OpenCode | `~/.local/share/opencode/opencode.db` (SQLite) | `readOpenCode` |
| pi | `~/.pi/agent/sessions/*.jsonl` | `makeJsonlUsageParser("pi")` |
| OMP | `~/.omp/agent/sessions/*.jsonl` | `fetchFromOmp` in `server/data-fetcher.js` |
| ZCode | `~/.zcode/cli/db/db.sqlite` | `fetchFromZCode` |
| Reasonix | `~/.reasonix/sessions`, `%APPDATA%/reasonix/projects` | `fetchFromReasonix` |
| OpenGrok | `$OPENGROK_HOME/sessions` else `~/.opengrok` | `fetchFromOpenGrok` |
| DSH | `$DSH_HOME/storages/session_projcache/sessions` else `~/.dsh` | `fetchFromDsh` |

`ccusage` is retained only as a fallback: it runs when the direct readers
recognize nothing, or when `TOKENMAXXING_CCUSAGE=1` forces it.

## Why not ccusage

ccusage shelled out (`bunx`/`npx`) and re-scanned every historical session on
each refresh. On this machine that was ~8s per run over a 6GB Codex backlog, no
matter how little had changed. The direct readers parse the same logs, keep a
per-file cache keyed by mtime+size in `~/.cache/tokenmaxxing/readers-cache.json`,
and only touch files that changed:

| Path | First scan | Steady state |
|------|-----------|--------------|
| ccusage | 7.9s | 7.9s |
| direct readers | ~55s (one-off: 1.1GB of `.zst` to decompress) | **0.7s** |

Totals match ccusage to 0.01% (53.218B vs 53.213B over the same window), which
is the check to re-run if a log layout changes.

## Token semantics

Every source is normalized to four additive buckets — `input`, `output`,
`cacheRead`, `cacheCreation` — where `total = input + output + cacheRead +
cacheCreation`. Cache hits are reported as `cacheRead / (input + cacheRead)`.

- Codex: `input_tokens` already contains `cached_input_tokens`, so the cached
  part is subtracted out of the input bucket.
- OpenCode: `tokens` is already additive; `reasoning` is folded into output.
- OpenGrok: reports Responses-wire semantics (`inputTokens` includes cached
  reads), so cached reads are subtracted like Codex.
- Reasonix: `cacheMissTokens` is the prompt side the provider had to resend, not
  Cache *creation*, so it stays inside the uncached input bucket.
- DSH: only session-level totals exist. They are attributed to the last-prompt
  day, so daily spikes from long sessions are approximate. The Harness table
  marks the DSH row accordingly.

## Dates

All day buckets use the machine's local calendar date. `localIsoDate` in
`server/readers.js` is the single formatter; date-only arithmetic in
`public/tmx.js` stays on UTC so adding days never drifts across a DST edge.

## ZCode driver

ZCode needs SQLite. Bun uses `bun:sqlite`; Node 22.5+ uses the built-in
`node:sqlite`. Without either, the source is skipped with a log line rather than
silently dropped.
