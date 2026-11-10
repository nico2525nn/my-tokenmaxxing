# My TokenMaxxing

Local dashboard for LLM token usage across coding agents. Single Go binary, no runtime dependencies, no external services.

<img width="1050" alt="dashboard screenshot" src="docs/screenshot.webp?v=3" />

## Run

```bash
make run
# → http://localhost:3642
```

Needs Go 1.26+.

`-port`, `-host`, `-interval` (refresh, default 60s), `-cache-max-mb` (default 8).

## Test

```bash
go test ./...      # parsing, aggregation, caching
make layout-test   # overflow regression, 320–1440px × 4 UI states
```

## Sources

| Source | Read from |
|--------|-----------|
| Codex | `~/.codex/sessions`, `~/.codex/archived_sessions` |
| OpenCode | `~/.local/share/opencode/opencode.db` |
| pi | `~/.pi/agent/sessions` |
| OMP | `~/.omp/agent/sessions` |
| ZCode | `~/.zcode/cli/db/db.sqlite` |
| Reasonix | `~/.reasonix/sessions`, `%APPDATA%/reasonix/projects` |
| OpenGrok | `$OPENGROK_HOME/sessions` else `~/.opengrok/sessions` |
| DSH | `$DSH_HOME/storages/session_projcache/sessions` else `~/.dsh` |

Only sources that exist are read. Per-source token semantics: `docs/data-sources.md`.

## Layout

```
cmd/tokenmaxxing/   HTTP server, refresh loop
internal/sources/   one reader per agent, per-file cache
internal/scan/      byte-level JSONL and zstd scanner
internal/jsonx/     field extraction without a full parse
internal/aggregate/ rollups, streaks
internal/cache/     hashed, size-capped parse cache
public/             dashboard UI and fonts
```

## License

MIT
