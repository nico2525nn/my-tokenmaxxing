# Data sources and readers

The dashboard reads every coding agent's local usage logs itself. There is no
external aggregator, no build step, and no third-party runtime dependency.

## Sources

| Source | Location | Reader |
|--------|----------|--------|
| Codex | `~/.codex/sessions`, `~/.codex/archived_sessions` (`.jsonl`, `.jsonl.zst`) | `internal/sources/sources.go` (`parseCodex`), split across cores by `codex_split.go` |
| OpenCode | `~/.local/share/opencode/opencode.db` | `internal/sources/sqlite.go` |
| pi | `~/.pi/agent/sessions/*.jsonl` | `internal/sources/sources.go` (`parseSessionLogs`) |
| OMP | `~/.omp/agent/sessions/*.jsonl` | `internal/sources/sources.go` (`parseSessionLogs`) |
| ZCode | `~/.zcode/cli/db/db.sqlite` | `internal/sources/sqlite.go` |
| Reasonix | `~/.reasonix/sessions`, `%APPDATA%/reasonix/projects` | `internal/sources/files.go` |
| OpenGrok | `$OPENGROK_HOME/sessions` else `~/.opengrok` | `internal/sources/files.go` |
| DSH | `$DSH_HOME/storages/session_projcache/sessions` else `~/.dsh` | `internal/sources/files.go` |

## Why the logs are read directly

The original implementation shelled out to `ccusage`, which re-scanned every
historical session on each refresh: ~8s per run over a 6GB Codex backlog no
matter how little had changed. Reading the logs in-process with a per-file cache
keyed by mtime+size in `~/.cache/tokenmaxxing/readers-cache.json` took a first
build from 55s to 2.4s and a no-op refresh to milliseconds.

Totals were verified against `ccusage` before the dependency was removed: the
direct readers matched to 0.01% over the same window. If a log layout changes,
that comparison is the check to re-run.

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
`internal/sources/sources.go` (`localDate`) is the single formatter; date-only arithmetic in
`public/tmx.js` stays on UTC so adding days never drifts across a DST edge.

## ZCode driver

ZCode and OpenCode need SQLite. Both use `modernc.org/sqlite`, a pure-Go driver,
so the binary stays CGO-free and builds anywhere Go does. A database that cannot
be opened is logged rather than silently dropped.
