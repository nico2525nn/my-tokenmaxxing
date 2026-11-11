// Package sources reads each agent's local usage logs and returns normalized
// per-(date, model) rows.
package sources

import (
	"path/filepath"
	"time"

	"github.com/nico2525nn/my-tokenmaxxing/internal/cache"
	"github.com/nico2525nn/my-tokenmaxxing/internal/jsonx"
	"github.com/nico2525nn/my-tokenmaxxing/internal/scan"
)

// Source describes one log family.
type Source struct {
	Name   string
	Dir    string
	Suffix []string
	Parse  func(path string) ([]cache.Tuple, error)
}

// localDate renders a timestamp as the machine's calendar day. Every source
// buckets locally: that is what ccusage reported and what "a day" means to the
// person reading the dashboard.
func localDate(value string) string {
	if value == "" {
		return ""
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		if len(value) >= 10 {
			return value[:10]
		}
		return ""
	}
	return parsed.Local().Format("2006-01-02")
}

func localDateMillis(ms int64) string {
	if ms <= 0 {
		return ""
	}
	return time.UnixMilli(ms).Local().Format("2006-01-02")
}

// tupleAccumulator merges rows that land on the same (date, model).
type tupleAccumulator struct {
	order []string
	rows  map[string]*cache.Tuple
}

func newAccumulator() *tupleAccumulator {
	return &tupleAccumulator{rows: map[string]*cache.Tuple{}}
}

func (a *tupleAccumulator) add(date, model string, input, output, cacheRead, cacheCreation int64) {
	total := input + output + cacheRead + cacheCreation
	if total <= 0 {
		return
	}
	key := date + "\x00" + model
	row, ok := a.rows[key]
	if !ok {
		row = &cache.Tuple{Date: date, Model: model}
		a.rows[key] = row
		a.order = append(a.order, key)
	}
	row.Input += input
	row.Output += output
	row.CacheRead += cacheRead
	row.CacheCreation += cacheCreation
	row.Total += total
}

// addTotal records a row whose log reports its own total, which can differ from
// the bucket sum (it may include reasoning tokens).
func (a *tupleAccumulator) addTotal(date, model string, input, output, cacheRead, cacheCreation, total int64) {
	if total <= 0 {
		a.add(date, model, input, output, cacheRead, cacheCreation)
		return
	}
	key := date + "\x00" + model
	row, ok := a.rows[key]
	if !ok {
		row = &cache.Tuple{Date: date, Model: model}
		a.rows[key] = row
		a.order = append(a.order, key)
	}
	row.Input += input
	row.Output += output
	row.CacheRead += cacheRead
	row.CacheCreation += cacheCreation
	row.Total += total
}

func (a *tupleAccumulator) tuples() []cache.Tuple {
	out := make([]cache.Tuple, 0, len(a.order))
	for _, key := range a.order {
		out = append(out, *a.rows[key])
	}
	return out
}

// ---- Codex ----------------------------------------------------------------

var codexMarkers = scan.New(`"type":"turn_context"`, `"type":"token_usage_record"`)

// parseCodex handles rollout logs. `input_tokens` already contains
// `cached_input_tokens`, so the cached part is subtracted to keep cache reads an
// additive bucket.
//
// Values are pulled with jsonx rather than encoding/json: the lines are short
// but numerous, and reflection dominated the whole refresh.
func parseCodex(path string) ([]cache.Tuple, error) {
	// Collect first, resolve models second: a usage record may appear before the
	// `turn_context` that names the model, and the merge pass handles that.
	var (
		usages []codexUsage
		marks  []codexModelMark
		offset int64
	)
	err := scan.Lines(path, codexMarkers, func(line scan.Line) error {
		if usage, isUsage := jsonx.FindObject(line, "usage"); isUsage {
			usages = append(usages, codexUsage{
				offset:        offset,
				date:          localDate(stringOf(line, "timestamp")),
				input:         intOf(usage, "input_tokens"),
				output:        intOf(usage, "output_tokens"),
				cached:        intOf(usage, "cached_input_tokens"),
				cacheCreation: intOf(usage, "cache_write_input_tokens"),
			})
		} else if name, hasModel := jsonx.FindString(line, "model"); hasModel && name != "" {
			marks = append(marks, codexModelMark{offset: offset, model: name})
		}
		offset++
		return nil
	})
	if err != nil {
		return nil, err
	}
	return mergeCodexChunks([]codexPart{{usages: usages, marks: marks}}), nil
}

func stringOf(data []byte, key string) string {
	value, _ := jsonx.String(data, key)
	return value
}

func intOf(data []byte, key string) int64 {
	value, _ := jsonx.Int(data, key)
	return value
}

// ---- OMP / pi -------------------------------------------------------------

var jsonlMarkers = scan.New(`"type":"model_change"`, `"type":"message"`)

// parseSessionLogs handles the shared OMP/pi session format: `model_change`
// carries the model, `message` carries per-turn usage whose cache buckets are
// already additive.
func parseSessionLogs(path string) ([]cache.Tuple, error) {
	acc := newAccumulator()
	model := "unknown"
	err := scan.Lines(path, jsonlMarkers, func(line scan.Line) error {
		// `modelId` (pi) and `model` (OMP) both appear on model_change lines; the
		// per-message model is nested under `message`, so it must be searched in
		// the whole line rather than the top-level object.
		if name, has := jsonx.FindString(line, "modelId"); has && name != "" {
			model = name
			return nil
		}
		usage, isUsage := jsonx.FindObject(line, "usage")
		if !isUsage {
			if name, has := jsonx.FindString(line, "model"); has && name != "" {
				model = name
			}
			return nil
		}
		if role, hasRole := jsonx.FindString(line, "role"); hasRole && role != "assistant" {
			return nil
		}
		date := localDate(stringOf(line, "timestamp"))
		if date == "" {
			return nil
		}
		rowModel, hasModel := jsonx.FindString(line, "model")
		if !hasModel || rowModel == "" {
			rowModel = model
		}
		acc.addTotal(
			date,
			normalizeModel(rowModel),
			intOf(usage, "input"),
			intOf(usage, "output"),
			intOf(usage, "cacheRead"),
			intOf(usage, "cacheWrite"),
			intOf(usage, "totalTokens"),
		)
		return nil
	})
	return acc.tuples(), err
}

// parseArchivedCodex accepts both plain and zstd-compressed rollouts.
func parseAnyCodex(path string) ([]cache.Tuple, error) { return parseCodex(path) }

func suffixes(includeZst bool) []string {
	if includeZst {
		return []string{".jsonl", ".jsonl.zst"}
	}
	return []string{".jsonl"}
}

func isCodexLog(path string) bool {
	base := filepath.Base(path)
	return filepath.Ext(base) == ".jsonl" || (len(base) > 4 && base[len(base)-4:] == ".zst")
}

// formatInt renders an int64 without pulling in fmt on a hot path.
func formatInt(value int64) string {
	if value == 0 {
		return "0"
	}
	var digits [20]byte
	index := len(digits)
	for value > 0 {
		index--
		digits[index] = byte('0' + value%10)
		value /= 10
	}
	return string(digits[index:])
}

// signatureID turns a textual signature into the numeric identity the cache
// stores for non-file inputs.
func signatureID(signature string) int64 {
	var value int64
	for index := 0; index < len(signature) && index < 18; index++ {
		value = value*10 + int64(signature[index]-'0')
	}
	return value
}
