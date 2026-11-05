package sources

import (
	"database/sql"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	_ "modernc.org/sqlite"

	"github.com/nico2525nn/my-tokenmaxxing/internal/cache"
)

// SQLite-backed sources: OpenCode and ZCode keep per-message usage in a database
// rather than in JSONL logs.

func homeDir() string {
	dir, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return dir
}

// providerPrefix matches the vendor paths sources use in front of a model id.
var providerPrefix = regexp.MustCompile(`^(openrouter|opencode-zen|opencode|anthropic|google|openai|deepseek|moonshotai|xiaomi|tencent|nemotron|minimax|gemma|nvidia)/+`)

// normalizeModel collapses provider/path prefixes so one model stays one row.
func normalizeModel(model string) string {
	if model == "" {
		return "unknown"
	}
	clean := strings.TrimSpace(model)
	// Strip a leading "[provider] " tag.
	if strings.HasPrefix(clean, "[") {
		if end := strings.Index(clean, "]"); end != -1 {
			clean = strings.TrimSpace(clean[end+1:])
		}
	}
	clean = providerPrefix.ReplaceAllString(clean, "")
	// "deepseek/v4/flash" (path-like, no dashes) becomes "deepseek-v4-flash",
	// while "deepseek-v4-flash" is left alone.
	if strings.Contains(clean, "/") && !strings.Contains(clean, "-") {
		parts := strings.Split(clean, "/")
		kept := parts[:0]
		for _, part := range parts {
			if part != "" {
				kept = append(kept, part)
			}
		}
		clean = strings.Join(kept, "-")
	}
	return clean
}

const openCodeQuery = `
  SELECT json_extract(data, '$.time.created') AS created,
         json_extract(data, '$.model.id')     AS model,
         json_extract(data, '$.tokens.input') AS input,
         json_extract(data, '$.tokens.output') AS output,
         json_extract(data, '$.tokens.reasoning') AS reasoning,
         json_extract(data, '$.tokens.cache.read')  AS cache_read,
         json_extract(data, '$.tokens.cache.write') AS cache_write
  FROM session_message
  WHERE json_extract(data, '$.tokens') IS NOT NULL`

// ReadOpenCode reads per-message usage. `tokens` is additive; reasoning is
// folded into output to match the dashboard contract.
func ReadOpenCode() ([]cache.Tuple, int64, int64, bool) {
	path := filepath.Join(homeDir(), ".local", "share", "opencode", "opencode.db")
	info, err := os.Stat(path)
	if err != nil {
		return nil, 0, 0, false
	}
	mtime, size := info.ModTime().UnixMilli(), info.Size()
	if wal, werr := os.Stat(path + "-wal"); werr == nil {
		mtime += wal.ModTime().UnixMilli()
		size += wal.Size()
	}

	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		return nil, mtime, size, false
	}
	defer db.Close()

	rows, err := db.Query(openCodeQuery)
	if err != nil {
		return nil, mtime, size, false
	}
	defer rows.Close()

	acc := newAccumulator()
	for rows.Next() {
		var (
			created, reasoning                   sql.NullInt64
			input, output, cacheRead, cacheWrite sql.NullInt64
			model                                sql.NullString
		)
		if rows.Scan(&created, &model, &input, &output, &reasoning, &cacheRead, &cacheWrite) != nil {
			continue
		}
		date := localDateMillis(created.Int64)
		if date == "" {
			continue
		}
		name := model.String
		if name == "" {
			name = "unknown"
		}
		acc.add(date, name, input.Int64, output.Int64+reasoning.Int64, cacheRead.Int64, cacheWrite.Int64)
	}
	return acc.tuples(), mtime, size, true
}

const zCodeQuery = `
  SELECT date(started_at/1000,'unixepoch','localtime') AS day, model_id,
         SUM(input_tokens) AS input, SUM(output_tokens) AS output,
         SUM(cache_read_input_tokens) AS cache_read,
         SUM(cache_creation_input_tokens) AS cache_creation,
         SUM(computed_total_tokens) AS total
  FROM model_usage
  GROUP BY day, model_id
  ORDER BY day`

// ReadZCode reads ZCode's aggregated model_usage table.
func ReadZCode() []cache.Tuple {
	path := filepath.Join(homeDir(), ".zcode", "cli", "db", "db.sqlite")
	if _, err := os.Stat(path); err != nil {
		return nil
	}
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		return nil
	}
	defer db.Close()

	rows, err := db.Query(zCodeQuery)
	if err != nil {
		return nil
	}
	defer rows.Close()

	acc := newAccumulator()
	for rows.Next() {
		var (
			day, model                            sql.NullString
			input, output, cacheRead, cacheCreate sql.NullInt64
			total                                 sql.NullInt64
		)
		if rows.Scan(&day, &model, &input, &output, &cacheRead, &cacheCreate, &total) != nil {
			continue
		}
		name := model.String
		if name == "" {
			name = "unknown"
		}
		acc.add(day.String, normalizeModel(name), input.Int64, output.Int64, cacheRead.Int64, cacheCreate.Int64)
	}
	return acc.tuples()
}
