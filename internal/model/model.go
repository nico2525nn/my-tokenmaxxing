// Package model holds the payload the dashboard renders. The JSON field names
// are the wire contract with public/tmx.js and must not change casually.
package model

// Record is one (date, source, model) usage row.
type Record struct {
	Date          string
	Source        string
	Model         string
	Input         int64
	Output        int64
	CacheRead     int64
	CacheCreation int64
	Total         int64
}

// Buckets is the additive token breakdown shared by every aggregate.
type Buckets struct {
	Tokens        int64 `json:"tokens"`
	Input         int64 `json:"input"`
	Output        int64 `json:"output"`
	CacheRead     int64 `json:"cacheRead"`
	CacheCreation int64 `json:"cacheCreation"`
}

// Point is one source/model row inside a day.
type Point struct {
	Source        string `json:"source"`
	Model         string `json:"model"`
	Tokens        int64  `json:"tokens"`
	Input         int64  `json:"input"`
	Output        int64  `json:"output"`
	CacheRead     int64  `json:"cacheRead"`
	CacheCreation int64  `json:"cacheCreation"`
}

// Day is one calendar day of usage.
type Day struct {
	Date   string  `json:"date"`
	Points []Point `json:"points"`
}

// SourceRow is the per-harness rollup.
type SourceRow struct {
	Source        string `json:"source"`
	Tokens        int64  `json:"tokens"`
	Input         int64  `json:"input"`
	Output        int64  `json:"output"`
	CacheRead     int64  `json:"cacheRead"`
	CacheCreation int64  `json:"cacheCreation"`
}

// ModelRow is the per-source/model rollup.
type ModelRow struct {
	Source        string `json:"source"`
	Model         string `json:"model"`
	Tokens        int64  `json:"tokens"`
	Input         int64  `json:"input"`
	Output        int64  `json:"output"`
	CacheRead     int64  `json:"cacheRead"`
	CacheCreation int64  `json:"cacheCreation"`
}

// Payload is the whole dashboard snapshot.
type Payload struct {
	GeneratedAt    string      `json:"generatedAt"`
	Totals         Buckets     `json:"totals"`
	Records        int         `json:"records"`
	ActiveDays     int         `json:"activeDays"`
	TopModel       string      `json:"topModel"`
	TopModelTokens int64       `json:"topModelTokens"`
	FirstDate      string      `json:"firstDate"`
	LastDate       string      `json:"lastDate"`
	CurrentStreak  int         `json:"currentStreak"`
	LongestStreak  int         `json:"longestStreak"`
	Sources        []SourceRow `json:"sources"`
	Models         []ModelRow  `json:"models"`
	Daily          []Day       `json:"daily"`
	// Stamp is a cheap "did any input change?" digest; the refresh loop skips a
	// rebuild when it matches the cached payload.
	Stamp string `json:"stamp"`
	// Changed counts files/databases re-read to produce this snapshot.
	Changed int `json:"changed"`
}
