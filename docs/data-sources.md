# Token semantics

Every source is normalized to four additive buckets — `input`, `output`,
`cacheRead`, `cacheCreation` — so `total = input + output + cacheRead +
cacheCreation`. Cache hit rate is `cacheRead / (input + cacheRead)`.

Some logs do not report it that way:

- **Codex** — `input_tokens` already contains `cached_input_tokens`; the cached
  part is subtracted so cache reads stay additive.
- **OpenGrok** — same shape (Responses wire): `inputTokens` includes
  `cachedReadTokens`, so it is subtracted. `reasoningTokens` is folded into
  output.
- **OpenCode** — `tokens` is already additive; `reasoning` is folded into output.
- **Reasonix** — `cacheMissTokens` is the prompt side the provider had to resend,
  not cache *creation*, so it stays inside the uncached input bucket.
- **DSH** — only session-level totals exist. They are attributed to the
  last-prompt day, so daily spikes from long sessions are approximate; the
  Harness table marks the row.

## Dates

Day buckets use the machine's local calendar date (`localDate` in
`internal/sources/sources.go`). Date-only arithmetic in the UI stays on UTC so
adding days never drifts across a DST edge.

## Cache

`~/.cache/tokenmaxxing/readers-cache.json` stores each file's aggregated rows
under a content hash, keyed by path plus mtime/size. Unchanged logs are never
re-read. The file is capped by `-cache-max-mb`; over the limit the coldest
entries are dropped and rebuilt later.
