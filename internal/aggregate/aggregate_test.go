package aggregate

import (
	"testing"
	"time"

	"github.com/nico2525nn/my-tokenmaxxing/internal/model"
)

func record(date, source, modelName string, tokens int64) model.Record {
	return model.Record{
		Date: date, Source: source, Model: modelName,
		Input: tokens, Total: tokens,
	}
}

func TestBuildRollsUpAndCountsMergedPoints(t *testing.T) {
	payload := Build([]model.Record{
		record("2026-10-27", "codex", "m1", 60),
		record("2026-10-27", "codex", "m1", 30), // same point, merged
		record("2026-10-27", "codex", "m2", 10),
		record("2026-10-28", "omp", "m1", 5),
	})

	if payload.Totals.Tokens != 105 {
		t.Fatalf("tokens = %d", payload.Totals.Tokens)
	}
	if payload.Records != 3 {
		t.Fatalf("records = %d, want 3 merged points", payload.Records)
	}
	if payload.ActiveDays != 2 || payload.FirstDate != "2026-10-27" || payload.LastDate != "2026-10-28" {
		t.Fatalf("window = %s..%s days=%d", payload.FirstDate, payload.LastDate, payload.ActiveDays)
	}
	// Top model is ranked per source/model row: codex/m1 holds 90, omp/m1 holds 5.
	if payload.TopModel != "m1" || payload.TopModelTokens != 90 {
		t.Fatalf("top = %s/%d", payload.TopModel, payload.TopModelTokens)
	}
	if len(payload.Sources) != 2 || payload.Sources[0].Source != "codex" {
		t.Fatalf("sources = %+v", payload.Sources)
	}
	if len(payload.Daily) != 2 || len(payload.Daily[0].Points) != 2 {
		t.Fatalf("daily = %+v", payload.Daily)
	}
}

func TestBuildEmptyIsClean(t *testing.T) {
	payload := Build(nil)
	if payload.Totals.Tokens != 0 || payload.ActiveDays != 0 {
		t.Fatalf("payload = %+v", payload)
	}
	if payload.TopModel != "N/A" {
		t.Fatalf("top model = %q", payload.TopModel)
	}
	if payload.Daily == nil || len(payload.Daily) != 0 {
		t.Fatalf("daily = %+v", payload.Daily)
	}
}

func TestBuildSkipsZeroTokenRecords(t *testing.T) {
	payload := Build([]model.Record{
		{Date: "2026-10-27", Source: "a", Model: "m", Total: 0},
		{Date: "2026-10-27", Source: "a", Model: "m", Total: 10},
	})
	if payload.Totals.Tokens != 10 || payload.Records != 1 {
		t.Fatalf("tokens=%d records=%d", payload.Totals.Tokens, payload.Records)
	}
}

func TestStreaks(t *testing.T) {
	today := time.Now().Local()
	day := func(offset int) string { return today.AddDate(0, 0, offset).Format("2006-01-02") }

	current, longest := streaks([]string{day(-2), day(-1), day(0)})
	if current != 3 || longest != 3 {
		t.Fatalf("current=%d longest=%d, want 3/3", current, longest)
	}

	current, longest = streaks([]string{day(-5), day(-4), day(-2)})
	if current != 0 || longest != 2 {
		t.Fatalf("current=%d longest=%d, want 0/2", current, longest)
	}

	current, longest = streaks(nil)
	if current != 0 || longest != 0 {
		t.Fatalf("current=%d longest=%d, want 0/0", current, longest)
	}
}

func TestStreakIgnoresGap(t *testing.T) {
	// A missing day ends the run; it must not be stitched across.
	_, longest := streaks([]string{"2026-01-01", "2026-01-02", "2026-01-04", "2026-01-05"})
	if longest != 2 {
		t.Fatalf("longest = %d, want 2", longest)
	}
}
