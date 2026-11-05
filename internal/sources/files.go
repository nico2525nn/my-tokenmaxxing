package sources

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/nico2525nn/my-tokenmaxxing/internal/cache"
	"github.com/nico2525nn/my-tokenmaxxing/internal/scan"
)

// File-based sources that are not plain JSONL session logs.

// ---- Reasonix -------------------------------------------------------------

var (
	reasonixDateRE  = regexp.MustCompile(`(\d{4})(\d{2})(\d{2})`)
	reasonixModelRE = regexp.MustCompile(`-([^/\\]+?)\.jsonl\.telemetry\.json$`)
	reasonixIDRE    = regexp.MustCompile(`^\d+(\.\d+)?-`)
	reasonixTagRE   = regexp.MustCompile(`(?i)^(deepseek|gemma|nemotron|gpt|moonshotai|xiaomi|tencent|minimax|hy3|mimo)-`)
)

type reasonixUsage struct {
	TotalTokens      int64 `json:"totalTokens"`
	CompletionTokens int64 `json:"completionTokens"`
	PromptTokens     int64 `json:"promptTokens"`
	Input            int64 `json:"input"`
	Output           int64 `json:"output"`
	CacheHitTokens   int64 `json:"cacheHitTokens"`
	CacheRead        int64 `json:"cacheRead"`
}

type reasonixEvent struct {
	TS      string         `json:"ts"`
	Stamp   string         `json:"timestamp"`
	Model   string         `json:"model"`
	Usage   *reasonixUsage `json:"usage"`
	Message *struct {
		Model string         `json:"model"`
		Usage *reasonixUsage `json:"usage"`
	} `json:"message"`
}

// ReadReasonix covers both layouts: `*.events.jsonl` line streams and
// `*.jsonl.telemetry.json` single documents.
//
// Reasonix's `cacheMissTokens` is the prompt side the provider had to resend,
// not cache *creation*, so it never becomes a cache-creation bucket here.
func ReadReasonix() []cache.Tuple {
	acc := newAccumulator()
	bases := []string{
		filepath.Join(homeDir(), ".reasonix", "sessions"),
		filepath.Join(homeDir(), "AppData", "Roaming", "reasonix", "projects"),
	}

	for _, base := range bases {
		if _, err := os.Stat(base); err != nil {
			continue
		}
		var files []string
		if strings.HasSuffix(base, "sessions") {
			files = append(files, scan.Collect(base, []string{".events.jsonl", ".telemetry.json"})...)
		} else {
			entries, err := os.ReadDir(base)
			if err != nil {
				continue
			}
			for _, entry := range entries {
				dir := filepath.Join(base, entry.Name(), "sessions")
				if _, serr := os.Stat(dir); serr == nil {
					files = append(files, scan.Collect(dir, []string{".telemetry.json"})...)
				}
			}
		}

		for _, file := range files {
			raw, err := os.ReadFile(file)
			if err != nil {
				continue
			}
			found := false
			for _, line := range strings.Split(string(raw), "\n") {
				if line == "" {
					continue
				}
				var event reasonixEvent
				if json.Unmarshal([]byte(line), &event) != nil {
					continue
				}
				usage := event.Usage
				model := event.Model
				if event.Message != nil {
					if usage == nil {
						usage = event.Message.Usage
					}
					if model == "" {
						model = event.Message.Model
					}
				}
				if usage == nil {
					continue
				}
				stamp := event.TS
				if stamp == "" {
					stamp = event.Stamp
				}
				acc.add(
					localDate(stamp),
					normalizeModel(model),
					firstNonZero(usage.PromptTokens, usage.Input),
					firstNonZero(usage.CompletionTokens, usage.Output),
					firstNonZero(usage.CacheHitTokens, usage.CacheRead),
					0,
				)
				found = true
			}

			if found {
				continue
			}
			// Single-document telemetry: the date and model live in the filename.
			var document struct {
				Usage *reasonixUsage `json:"usage"`
			}
			if json.Unmarshal(raw, &document) != nil || document.Usage == nil {
				continue
			}
			date := ""
			if match := reasonixDateRE.FindStringSubmatch(file); match != nil {
				date = match[1] + "-" + match[2] + "-" + match[3]
			}
			model := "unknown"
			if match := reasonixModelRE.FindStringSubmatch(file); match != nil {
				model = match[1]
			}
			model = reasonixIDRE.ReplaceAllString(model, "")
			model = reasonixTagRE.ReplaceAllString(model, "")
			acc.add(date, normalizeModel(model), document.Usage.PromptTokens, document.Usage.CompletionTokens,
				document.Usage.CacheHitTokens, 0)
		}
	}
	return acc.tuples()
}

func firstNonZero(values ...int64) int64 {
	for _, value := range values {
		if value != 0 {
			return value
		}
	}
	return 0
}

// ---- OpenGrok -------------------------------------------------------------

type openGrokUsage struct {
	InputTokens         int64 `json:"inputTokens"`
	OutputTokens        int64 `json:"outputTokens"`
	ReasoningTokens     int64 `json:"reasoningTokens"`
	CachedReadTokens    int64 `json:"cachedReadTokens"`
	CacheCreationTokens int64 `json:"cacheCreationTokens"`
}

type openGrokTurn struct {
	EndedAt        string                    `json:"endedAt"`
	PrimaryModelID string                    `json:"primaryModelId"`
	ModelUsage     map[string]*openGrokUsage `json:"modelUsage"`
	openGrokUsage
}

type openGrokSession struct {
	UpdatedAt string         `json:"updatedAt"`
	Turns     []openGrokTurn `json:"turns"`
	Session   *struct {
		PrimaryModelID string `json:"primaryModelId"`
	} `json:"session"`
}

// ReadOpenGrok sums per-turn deltas so a session lands on the day each turn
// finished. `inputTokens` already contains `cachedReadTokens` (Responses-wire
// semantics), so the cached part is subtracted into its own bucket.
func ReadOpenGrok() []cache.Tuple {
	base := os.Getenv("OPENGROK_HOME")
	if base == "" {
		base = filepath.Join(homeDir(), ".opengrok")
	}
	dir := filepath.Join(base, "sessions")
	if _, err := os.Stat(dir); err != nil {
		return nil
	}

	acc := newAccumulator()
	for _, file := range scan.Collect(dir, []string{"usage.json"}) {
		raw, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		var session openGrokSession
		if json.Unmarshal(raw, &session) != nil {
			continue
		}
		for _, turn := range session.Turns {
			date := localDate(turn.EndedAt)
			if date == "" {
				date = localDate(session.UpdatedAt)
			}
			if date == "" {
				continue
			}
			rows := turn.ModelUsage
			if len(rows) == 0 {
				model := turn.PrimaryModelID
				if model == "" && session.Session != nil {
					model = session.Session.PrimaryModelID
				}
				if model == "" {
					model = "unknown"
				}
				usage := openGrokUsage{
					InputTokens:         turn.InputTokens,
					OutputTokens:        turn.OutputTokens,
					ReasoningTokens:     turn.ReasoningTokens,
					CachedReadTokens:    turn.CachedReadTokens,
					CacheCreationTokens: turn.CacheCreationTokens,
				}
				rows = map[string]*openGrokUsage{model: &usage}
			}
			for name, usage := range rows {
				if usage == nil {
					continue
				}
				input := usage.InputTokens - usage.CachedReadTokens
				if input < 0 {
					input = 0
				}
				// Reasoning is stored separately; fold it into output to match the
				// dashboard token contract.
				acc.add(date, normalizeModel(name), input, usage.OutputTokens+usage.ReasoningTokens,
					usage.CachedReadTokens, usage.CacheCreationTokens)
			}
		}
	}
	return acc.tuples()
}

// ---- DSH ------------------------------------------------------------------

type dshProjection struct {
	Record *struct {
		Identity *struct {
			ID        string `json:"id"`
			CreatedAt int64  `json:"createdAt"`
		} `json:"identity"`
		Rows *struct {
			TokenUsage *struct {
				Val *struct {
					Totals *struct {
						UncachedInput int64 `json:"uncachedInputTokens"`
						Output        int64 `json:"outputTokens"`
						CacheRead     int64 `json:"cacheReadTokens"`
						CacheWrite    int64 `json:"cacheWriteTokens"`
					} `json:"totals"`
				} `json:"val"`
			} `json:"tokenUsage"`
			SessionListMetadata *struct {
				Val *struct {
					LastPromptAt int64 `json:"lastPromptAt"`
				} `json:"val"`
			} `json:"sessionListMetadata"`
			ModelSelection *struct {
				Val *struct {
					LastUsed *struct {
						Model string `json:"model"`
					} `json:"lastUsed"`
				} `json:"val"`
			} `json:"modelSelection"`
		} `json:"rows"`
	} `json:"record"`
}

// ReadDsh uses the harness's authoritative session totals. Only session-level
// numbers exist, so they are bucketed on the last prompt: daily spikes from long
// sessions are approximate and the Harness table says so.
func ReadDsh() []cache.Tuple {
	home := os.Getenv("DSH_HOME")
	if home == "" {
		home = filepath.Join(homeDir(), ".dsh")
	}
	dir := filepath.Join(home, "storages", "session_projcache", "sessions")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}

	acc := newAccumulator()
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			continue
		}
		var projection dshProjection
		if json.Unmarshal(raw, &projection) != nil || projection.Record == nil || projection.Record.Rows == nil {
			continue
		}
		rows := projection.Record.Rows
		if rows.TokenUsage == nil || rows.TokenUsage.Val == nil || rows.TokenUsage.Val.Totals == nil {
			continue
		}
		totals := rows.TokenUsage.Val.Totals

		stamp := int64(0)
		if rows.SessionListMetadata != nil && rows.SessionListMetadata.Val != nil {
			stamp = rows.SessionListMetadata.Val.LastPromptAt
		}
		if stamp == 0 && projection.Record.Identity != nil {
			stamp = projection.Record.Identity.CreatedAt
		}
		date := localDateMillis(stamp)
		if date == "" {
			continue
		}

		model := ""
		if rows.ModelSelection != nil && rows.ModelSelection.Val != nil && rows.ModelSelection.Val.LastUsed != nil {
			model = rows.ModelSelection.Val.LastUsed.Model
		}
		if model == "" {
			model = "unknown"
		}
		acc.add(date, normalizeModel(model), totals.UncachedInput, totals.Output, totals.CacheRead, totals.CacheWrite)
	}
	return acc.tuples()
}
