package sources

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

type t3Turn struct {
	provider  string
	startedAt string
	model     string
	input     int64
	cached    int64
	creation  int64
	output    int64
}

// buildT3Database writes the subset of T3Code's schema the reader touches.
func buildT3Database(t *testing.T, turns []t3Turn) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "statev2.sqlite")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	for _, statement := range []string{
		`CREATE TABLE orchestration_v2_projection_provider_turns (provider_turn_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL)`,
		`CREATE TABLE orchestration_v2_projection_run_attempts (attempt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, provider TEXT NOT NULL)`,
		`CREATE TABLE orchestration_v2_projection_runs (run_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL)`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	for i, turn := range turns {
		suffix := fmt.Sprint(i)
		if _, err := db.Exec(
			`INSERT INTO orchestration_v2_projection_provider_turns VALUES (?, ?)`,
			"turn-"+suffix,
			fmt.Sprintf(`{"runAttemptId":"attempt-%s","startedAt":%q,"turnTokenUsage":{"inputTokens":%d,"cachedInputTokens":%d,"cacheCreationTokens":%d,"outputTokens":%d}}`,
				suffix, turn.startedAt, turn.input, turn.cached, turn.creation, turn.output),
		); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(
			`INSERT INTO orchestration_v2_projection_run_attempts VALUES (?, ?, ?)`,
			"attempt-"+suffix, "run-"+suffix, turn.provider,
		); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(
			`INSERT INTO orchestration_v2_projection_runs VALUES (?, ?)`,
			"run-"+suffix, fmt.Sprintf(`{"modelSelection":{"model":%q}}`, turn.model),
		); err != nil {
			t.Fatal(err)
		}
	}
	return path
}

// Both timestamps fall on the same local day under every UTC offset, so the two
// turns must merge into one row.
func TestReadT3SubtractsCachedAndSkipsSharedProviders(t *testing.T) {
	path := buildT3Database(t, []t3Turn{
		// inputTokens is the whole prompt; the cached part must not be added twice.
		{provider: "antigravity", startedAt: "2026-11-18T06:44:32Z", model: "gemini-4-carbon", input: 1000, cached: 800, output: 50},
		// More cached than input must clamp instead of producing a negative bucket.
		{provider: "antigravity", startedAt: "2026-11-18T09:00:00Z", model: "gemini-4-carbon", input: 10, cached: 40, output: 5},
		// Codex writes to ~/.codex, which the dedicated reader already counts.
		{provider: "codex", startedAt: "2026-11-18T07:00:00Z", model: "gpt-6-luna", input: 5000, output: 500},
	})

	tuples := readT3Database(path)
	if len(tuples) != 1 {
		t.Fatalf("tuples = %+v, want one merged row", tuples)
	}
	row := tuples[0]
	if row.Date != localDate("2026-11-18T06:44:32Z") || row.Model != "gemini-4-carbon" {
		t.Fatalf("row = %+v", row)
	}
	if row.Input != 200 || row.CacheRead != 840 || row.Output != 55 {
		t.Fatalf("buckets = input %d cacheRead %d output %d, want 200/840/55", row.Input, row.CacheRead, row.Output)
	}
	if row.Total != 1095 {
		t.Fatalf("total = %d, want 1095", row.Total)
	}
}

func TestReadT3MissingDatabaseIsSilent(t *testing.T) {
	if tuples := readT3Database(filepath.Join(t.TempDir(), "absent.sqlite")); tuples != nil {
		t.Fatalf("tuples = %+v, want nil", tuples)
	}
}
