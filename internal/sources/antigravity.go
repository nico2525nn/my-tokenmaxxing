package sources

import (
	"os"
	"path/filepath"

	"github.com/nico2525nn/my-tokenmaxxing/internal/cache"
	"github.com/nico2525nn/my-tokenmaxxing/internal/jsonx"
	"github.com/nico2525nn/my-tokenmaxxing/internal/scan"
)

// ---- Antigravity ----------------------------------------------------------

// Antigravity keeps a step-by-step transcript per conversation under
// `brain/<conversation>/.system_generated/logs/`. Model steps carry their own
// usage: `input_tokens`, `cache_read_tokens`, `output_tokens`.
//
// `input_tokens` is already the uncached part — the cached prefix is reported
// separately in `cache_read_tokens` — so the buckets are additive as-is.
var antigravityMarkers = scan.New(`"step_index"`)

// antigravityRoots lists where the CLI and the IDE keep their brain.
// `ANTIGRAVITY_HOME` points at a directory that contains `brain/`.
func antigravityRoots() []string {
	var roots []string
	if home := os.Getenv("ANTIGRAVITY_HOME"); home != "" {
		roots = append(roots, home)
	}
	base := homeDir()
	roots = append(roots,
		filepath.Join(base, ".gemini", "antigravity-cli"),
		filepath.Join(base, ".gemini", "antigravity"),
		filepath.Join(base, ".antigravity"),
	)
	seen := map[string]struct{}{}
	unique := roots[:0]
	for _, root := range roots {
		resolved, err := filepath.Abs(root)
		if err != nil {
			resolved = root
		}
		if _, dup := seen[resolved]; dup {
			continue
		}
		seen[resolved] = struct{}{}
		unique = append(unique, resolved)
	}
	return unique
}

// ReadAntigravity sums every model step in every conversation transcript.
func ReadAntigravity() []cache.Tuple {
	acc := newAccumulator()
	for _, root := range antigravityRoots() {
		readAntigravityRoot(root, acc)
	}
	return acc.tuples()
}

func readAntigravityRoot(root string, acc *tupleAccumulator) {
	brain := filepath.Join(root, "brain")
	conversations, err := os.ReadDir(brain)
	if err != nil {
		return
	}
	for _, conversation := range conversations {
		if !conversation.IsDir() {
			continue
		}
		// `chunks/` holds the same steps split for replay; the root file is the
		// complete one, and reading both would double count.
		for _, name := range []string{"transcript_full.jsonl", "transcript.jsonl"} {
			path := filepath.Join(brain, conversation.Name(), ".system_generated", "logs", name)
			if _, err := os.Stat(path); err != nil {
				continue
			}
			parseAntigravityTranscript(path, acc)
			break
		}
	}
}

func parseAntigravityTranscript(path string, acc *tupleAccumulator) {
	_ = scan.Lines(path, antigravityMarkers, func(line scan.Line) error {
		input, hasInput := jsonx.Int(line, "input_tokens")
		if !hasInput {
			// Tool-call and user rows share the marker but carry no usage.
			return nil
		}
		date := localDate(stringOf(line, "created_at"))
		if date == "" {
			return nil
		}
		output, _ := jsonx.Int(line, "output_tokens")
		cached, _ := jsonx.Int(line, "cache_read_tokens")
		acc.add(date, normalizeModel(stringOf(line, "model")), input, output, cached, 0)
		return nil
	})
}
