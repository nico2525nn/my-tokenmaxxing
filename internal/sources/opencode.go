package sources

import (
	"database/sql"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"

	"github.com/nico2525nn/my-tokenmaxxing/internal/cache"
)

// OpenCode stores per-message usage in SQLite. `tokens` is additive
// (input + output + reasoning + cache.read + cache.write); reasoning is folded
// into the output bucket to match the dashboard token contract.
//
// The query reads 33k JSON blobs (~0.8s), so it only runs when the database
// signature changed. Probing the signature is a stat call.
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

func openCodePath() string {
	return filepath.Join(homeDir(), ".local", "share", "opencode", "opencode.db")
}

// OpenCodeSignature identifies the database contents; the WAL is included because
// it carries writes before they are checkpointed.
func OpenCodeSignature() (string, bool) {
	path := openCodePath()
	info, err := os.Stat(path)
	if err != nil {
		return "", false
	}
	signature := info.ModTime().UnixMilli()
	if wal, werr := os.Stat(path + "-wal"); werr == nil {
		signature += wal.ModTime().UnixMilli()
	}
	return formatInt(signature), true
}

// ReadOpenCode runs the query and returns aggregated rows.
func ReadOpenCode() ([]cache.Tuple, bool) {
	path := openCodePath()
	if _, err := os.Stat(path); err != nil {
		return nil, false
	}
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		return nil, false
	}
	defer db.Close()

	rows, err := db.Query(openCodeQuery)
	if err != nil {
		return nil, false
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
	return acc.tuples(), true
}
