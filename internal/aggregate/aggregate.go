// Package aggregate collapses normalized records into the dashboard payload.
package aggregate

import (
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"time"

	"github.com/nico2525nn/my-tokenmaxxing/internal/model"
)

const dayMillis = 86_400_000

// Build rolls records up into the payload the browser renders.
//
// Records are keyed by (date, source, model), so grouping turns tens of
// thousands of rows into a few hundred entries. Shipping that summary is what
// keeps page load flat as history grows.
func Build(records []model.Record) model.Payload {
	var (
		totals       model.Buckets
		sourceRows   = map[string]*model.SourceRow{}
		modelRows    = map[string]*model.ModelRow{}
		days         = map[string]map[string]*model.Point{}
		totalRecords int
	)

	for _, record := range records {
		if record.Total <= 0 {
			continue
		}

		totals.Tokens += record.Total
		totals.Input += record.Input
		totals.Output += record.Output
		totals.CacheRead += record.CacheRead
		totals.CacheCreation += record.CacheCreation

		source, ok := sourceRows[record.Source]
		if !ok {
			source = &model.SourceRow{Source: record.Source}
			sourceRows[record.Source] = source
		}
		source.Tokens += record.Total
		source.Input += record.Input
		source.Output += record.Output
		source.CacheRead += record.CacheRead
		source.CacheCreation += record.CacheCreation

		rowKey := record.Source + "\x00" + record.Model
		row, ok := modelRows[rowKey]
		if !ok {
			row = &model.ModelRow{Source: record.Source, Model: record.Model}
			modelRows[rowKey] = row
		}
		row.Tokens += record.Total
		row.Input += record.Input
		row.Output += record.Output
		row.CacheRead += record.CacheRead
		row.CacheCreation += record.CacheCreation

		bucket, ok := days[record.Date]
		if !ok {
			bucket = map[string]*model.Point{}
			days[record.Date] = bucket
		}
		point, ok := bucket[rowKey]
		if !ok {
			point = &model.Point{Source: record.Source, Model: record.Model}
			bucket[rowKey] = point
		}
		point.Tokens += record.Total
		point.Input += record.Input
		point.Output += record.Output
		point.CacheRead += record.CacheRead
		point.CacheCreation += record.CacheCreation
	}

	// `records` counts merged (date, source, model) points: that is the number
	// the KPI card shows, not the raw row count.
	for _, bucket := range days {
		totalRecords += len(bucket)
	}

	dates := make([]string, 0, len(days))
	for date := range days {
		dates = append(dates, date)
	}
	sort.Strings(dates)

	payload := model.Payload{
		GeneratedAt: time.Now().UTC().Format(time.RFC3339Nano),
		Totals:      totals,
		Records:     totalRecords,
		ActiveDays:  len(dates),
		Daily:       make([]model.Day, 0, len(dates)),
	}
	if len(dates) > 0 {
		payload.FirstDate = dates[0]
		payload.LastDate = dates[len(dates)-1]
	}

	for _, date := range dates {
		points := make([]model.Point, 0, len(days[date]))
		for _, point := range days[date] {
			points = append(points, *point)
		}
		sort.Slice(points, func(i, j int) bool { return points[i].Tokens > points[j].Tokens })
		payload.Daily = append(payload.Daily, model.Day{Date: date, Points: points})
	}

	payload.Sources = make([]model.SourceRow, 0, len(sourceRows))
	for _, row := range sourceRows {
		payload.Sources = append(payload.Sources, *row)
	}
	sort.Slice(payload.Sources, func(i, j int) bool { return payload.Sources[i].Tokens > payload.Sources[j].Tokens })

	payload.Models = make([]model.ModelRow, 0, len(modelRows))
	for _, row := range modelRows {
		payload.Models = append(payload.Models, *row)
	}
	sort.Slice(payload.Models, func(i, j int) bool { return payload.Models[i].Tokens > payload.Models[j].Tokens })

	payload.TopModel = "N/A"
	if len(payload.Models) > 0 && payload.Models[0].Tokens > 0 {
		payload.TopModel = payload.Models[0].Model
		payload.TopModelTokens = payload.Models[0].Tokens
	}

	payload.CurrentStreak, payload.LongestStreak = streaks(dates)
	return payload
}

// streaks counts consecutive active days. `today` is the local calendar day so
// the current streak matches what the reader sees in their own timezone.
func streaks(dates []string) (current, longest int) {
	if len(dates) == 0 {
		return 0, 0
	}
	active := make(map[string]struct{}, len(dates))
	for _, date := range dates {
		active[date] = struct{}{}
	}

	today := time.Now().Local().Format("2006-01-02")
	if _, ok := active[today]; ok {
		for back := 0; ; back++ {
			day := time.Now().Local().AddDate(0, 0, -back).Format("2006-01-02")
			if _, exists := active[day]; !exists {
				break
			}
			current++
		}
	}

	run := 0
	var previous time.Time
	for index, date := range dates {
		parsed, err := time.Parse("2006-01-02", date)
		if err != nil {
			continue
		}
		if index == 0 || parsed.Sub(previous) != dayMillis*time.Millisecond {
			run = 1
		} else {
			run++
		}
		if run > longest {
			longest = run
		}
		previous = parsed
	}
	return current, longest
}

// Stamp is a cheap "has anything changed?" digest over every input file.
func Stamp() string {
	home, _ := os.UserHomeDir()
	paths := []string{
		filepath.Join(home, ".cache", "tokenmaxxing", "readers-cache.json"),
		filepath.Join(home, ".zcode", "cli", "db", "db.sqlite"),
		filepath.Join(home, ".zcode", "cli", "db", "db.sqlite-wal"),
		envOr("DSH_HOME", filepath.Join(home, ".dsh"), "storages", "session_projcache", "sessions"),
		envOr("OPENGROK_HOME", filepath.Join(home, ".opengrok"), "sessions"),
		filepath.Join(home, ".reasonix", "sessions"),
	}
	out := ""
	for _, path := range paths {
		if info, err := os.Stat(path); err == nil {
			out += strconvFormat(info.ModTime().UnixMilli()) + ":" + strconvFormat(info.Size()) + "|"
			continue
		}
		out += "-|"
	}
	return out
}

func envOr(key, fallback string, parts ...string) string {
	base := os.Getenv(key)
	if base == "" {
		base = fallback
	}
	return filepath.Join(append([]string{base}, parts...)...)
}

func strconvFormat(value int64) string {
	return strconv.FormatInt(value, 10)
}
