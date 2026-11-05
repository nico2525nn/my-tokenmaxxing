package scan

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeTemp(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "log.jsonl")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLinesMatchesOnlyMarkedLines(t *testing.T) {
	path := writeTemp(t, strings.Join([]string{
		`{"type":"other","pad":"` + strings.Repeat("x", 500) + `"}`,
		`{"type":"token_usage_record","payload":{}}`,
		`{"type":"token_usage_record","payload":{}}`,
	}, "\n")+"\n")

	markers := New(`"type":"token_usage_record"`)
	var got []string
	if err := Lines(path, markers, func(line Line) error {
		got = append(got, string(line))
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("matched %d lines, want 2", len(got))
	}
	if !strings.Contains(got[0], "token_usage_record") {
		t.Fatalf("unexpected line %q", got[0])
	}
}

func TestLinesHandlesMissingTrailingNewline(t *testing.T) {
	path := writeTemp(t, `{"type":"token_usage_record"}`)
	count := 0
	if err := Lines(path, New(`"token_usage_record"`), func(Line) error { count++; return nil }); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("count = %d, want 1", count)
	}
}

func TestLinesMarkerOutsideWindowIsIgnored(t *testing.T) {
	// Markers are only searched in the line prefix on purpose; a marker that only
	// appears deep inside a long value must not select the line.
	line := `{"pad":"` + strings.Repeat("y", 200) + `","type":"token_usage_record"}`
	path := writeTemp(t, line+"\n")
	count := 0
	if err := Lines(path, New(`"type":"token_usage_record"`), func(Line) error { count++; return nil }); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("count = %d, want 0", count)
	}
}

func TestLinesRangeCoversEveryLineExactlyOnce(t *testing.T) {
	var builder strings.Builder
	for i := range 500 {
		builder.WriteString(`{"type":"token_usage_record","i":`)
		builder.WriteByte(byte('0' + i%10))
		builder.WriteString("}\n")
	}
	content := builder.String()
	path := writeTemp(t, content)

	seen := map[int64]int{}
	collect := func(start, end int64) {
		if err := LinesRange(path, start, end, New(`"token_usage_record"`), func(offset int64, line Line) error {
			seen[offset]++
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	size := int64(len(content))
	step := size / 4
	collect(0, step)
	collect(step, step*2)
	collect(step*2, step*3)
	collect(step*3, size)

	total := 0
	for offset, count := range seen {
		if count != 1 {
			t.Fatalf("offset %d seen %d times", offset, count)
		}
		total++
	}
	if total != 500 {
		t.Fatalf("saw %d lines, want 500", total)
	}
}
