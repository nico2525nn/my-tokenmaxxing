package sources

import (
	"database/sql"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"

	"github.com/nico2525nn/my-tokenmaxxing/internal/cache"
)

// ---- T3Code ---------------------------------------------------------------

// T3Code records one usage block per provider turn in `statev2.sqlite`. The
// projection tables are the deduplicated state, so reading them never sees the
// same turn twice, unlike the raw `orchestration_v2_events` stream.
//
// `inputTokens` is the whole prompt, cached prefix included, and `outputTokens`
// already contains reasoning; the cached part is subtracted so cache reads stay
// an additive bucket.
const t3Query = `
  SELECT a.provider,
         json_extract(t.payload_json, '$.startedAt')                              AS started_at,
         json_extract(t.payload_json, '$.turnTokenUsage.inputTokens')             AS input_tokens,
         json_extract(t.payload_json, '$.turnTokenUsage.cachedInputTokens')       AS cached_input_tokens,
         json_extract(t.payload_json, '$.turnTokenUsage.cacheCreationTokens')     AS cache_creation_tokens,
         json_extract(t.payload_json, '$.turnTokenUsage.outputTokens')            AS output_tokens,
         json_extract(r.payload_json, '$.modelSelection.model')                   AS model
    FROM orchestration_v2_projection_provider_turns t
    JOIN orchestration_v2_projection_run_attempts a
      ON a.attempt_id = json_extract(t.payload_json, '$.runAttemptId')
    JOIN orchestration_v2_projection_runs r
      ON r.run_id = a.run_id`

// t3SharedProviders run against the same global store a dedicated reader
// already counts, so their turns are skipped here instead of being counted
// twice. T3Code does not sandbox them: Codex resolves CODEX_HOME to `~/.codex`
// by default, and even a managed instance's shadow home symlinks `sessions`
// back to the shared home (CodexHomeLayout.ts keeps only log/memories/tmp
// local). pi and OpenCode have no T3 home override at all.
//
// Antigravity is the exception: its driver always resolves a profile directory
// under T3Code's state dir, so those turns exist nowhere else.
var t3SharedProviders = map[string]struct{}{
	"codex":     {},
	"opencode":  {},
	"opencode2": {},
	"pi":        {},
}

func t3StatePath() string {
	if home := os.Getenv("T3_HOME"); home != "" {
		return filepath.Join(home, "userdata", "statev2.sqlite")
	}
	return filepath.Join(homeDir(), ".t3", "userdata", "statev2.sqlite")
}

// ReadT3 sums the turn usage T3Code recorded for the providers it owns.
func ReadT3() []cache.Tuple {
	return readT3Database(t3StatePath())
}

func readT3Database(path string) []cache.Tuple {
	if _, err := os.Stat(path); err != nil {
		return nil
	}
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		return nil
	}
	defer db.Close()

	rows, err := db.Query(t3Query)
	if err != nil {
		// The tables only exist once T3Code has run an orchestrated turn, and a
		// running server can hold the database locked.
		return nil
	}
	defer rows.Close()

	acc := newAccumulator()
	for rows.Next() {
		var (
			provider, startedAt, model sql.NullString
			input, cached, creation    sql.NullInt64
			output                     sql.NullInt64
		)
		if err := rows.Scan(&provider, &startedAt, &input, &cached, &creation, &output, &model); err != nil {
			continue
		}
		if _, shared := t3SharedProviders[provider.String]; shared {
			continue
		}
		date := localDate(startedAt.String)
		if date == "" {
			continue
		}
		uncached := input.Int64 - cached.Int64
		if uncached < 0 {
			uncached = 0
		}
		acc.add(date, normalizeModel(model.String), uncached, output.Int64, cached.Int64, creation.Int64)
	}
	return acc.tuples()
}
