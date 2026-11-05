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

// ZCode keeps aggregated per-model usage in SQLite.

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
