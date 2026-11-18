package sources

import (
	"os"
	"path/filepath"
	"testing"
)

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// The transcript carries duplicate copies of every step (`chunks/` and the
// shorter `transcript.jsonl`), so the reader must take exactly one of them.
func TestReadAntigravityCountsEachStepOnce(t *testing.T) {
	root := t.TempDir()
	logs := filepath.Join(root, "brain", "conv-1", ".system_generated", "logs")
	body := `{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","created_at":"2026-11-18T05:25:33Z","content":"hi"}
{"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-11-18T05:26:15Z","model":"gemini-pro-orchestrator","input_tokens":9807,"cache_read_tokens":0,"output_tokens":555}
{"step_index":2,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-11-18T05:27:44Z","model":"gemini-pro-orchestrator","input_tokens":6081,"cache_read_tokens":9808,"output_tokens":598}
`
	writeFile(t, filepath.Join(logs, "transcript_full.jsonl"), body)
	writeFile(t, filepath.Join(logs, "transcript.jsonl"), body)
	writeFile(t, filepath.Join(logs, "chunks", "transcript_full", "00000000.jsonl"), body)

	acc := newAccumulator()
	readAntigravityRoot(root, acc)
	tuples := acc.tuples()
	if len(tuples) != 1 {
		t.Fatalf("tuples = %+v, want one merged row", tuples)
	}
	row := tuples[0]
	if row.Date != "2026-11-18" || row.Model != "gemini-pro-orchestrator" {
		t.Fatalf("row = %+v", row)
	}
	if row.Input != 15888 || row.Output != 1153 || row.CacheRead != 9808 {
		t.Fatalf("buckets = input %d output %d cacheRead %d", row.Input, row.Output, row.CacheRead)
	}
	if row.Total != 15888+1153+9808 {
		t.Fatalf("total = %d, want the sum of the buckets", row.Total)
	}
}

// A conversation whose full transcript was never written falls back to the
// truncated copy rather than dropping out of the totals.
func TestReadAntigravityFallsBackToTruncatedTranscript(t *testing.T) {
	root := t.TempDir()
	logs := filepath.Join(root, "brain", "conv-2", ".system_generated", "logs")
	writeFile(t, filepath.Join(logs, "transcript.jsonl"),
		`{"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","created_at":"2026-11-18T05:25:33Z","model":"gemini-3-pro","input_tokens":10,"cache_read_tokens":90,"output_tokens":5}`+"\n")

	acc := newAccumulator()
	readAntigravityRoot(root, acc)
	tuples := acc.tuples()
	if len(tuples) != 1 || tuples[0].Total != 105 || tuples[0].Model != "gemini-3-pro" {
		t.Fatalf("tuples = %+v", tuples)
	}
}
