package sources

import (
	"sort"
	"sync"

	"github.com/nico2525nn/my-tokenmaxxing/internal/cache"
	"github.com/nico2525nn/my-tokenmaxxing/internal/jsonx"
	"github.com/nico2525nn/my-tokenmaxxing/internal/scan"
)

// splitThreshold is where splitting one file beats keeping it whole. A single
// 3.2GB rollout would otherwise define the entire refresh.
const splitThreshold = 96 << 20

// chunkBytes targets a slice per core. Chunk jobs join the global pool instead of
// nesting their own goroutines, so concurrency stays at exactly `workers`.
const chunkBytes = 96 << 20

type codexUsage struct {
	offset        int64
	date          string
	input         int64
	output        int64
	cached        int64
	cacheCreation int64
}

type codexModelMark struct {
	offset int64
	model  string
}

// codexChunk reads one byte range of a rollout. Model attribution is resolved
// later: the model in force at a usage record is the closest preceding
// `turn_context`, which may live in an earlier chunk.
func codexChunk(path string, start, end int64) ([]codexUsage, []codexModelMark, error) {
	var (
		usages []codexUsage
		marks  []codexModelMark
	)
	err := scan.LinesRange(path, start, end, codexMarkers, func(offset int64, line scan.Line) error {
		if usage, isUsage := jsonx.FindObject(line, "usage"); isUsage {
			usages = append(usages, codexUsage{
				offset:        offset,
				date:          localDate(stringOf(line, "timestamp")),
				input:         intOf(usage, "input_tokens"),
				output:        intOf(usage, "output_tokens"),
				cached:        intOf(usage, "cached_input_tokens"),
				cacheCreation: intOf(usage, "cache_write_input_tokens"),
			})
			return nil
		}
		if name, has := jsonx.FindString(line, "model"); has && name != "" {
			marks = append(marks, codexModelMark{offset: offset, model: name})
		}
		return nil
	})
	return usages, marks, err
}

// mergeCodexChunks turns per-chunk usage and model marks into aggregated rows.
func mergeCodexChunks(parts []codexPart) []cache.Tuple {
	var usages []codexUsage
	var marks []codexModelMark
	for _, part := range parts {
		usages = append(usages, part.usages...)
		marks = append(marks, part.marks...)
	}
	sort.Slice(usages, func(i, j int) bool { return usages[i].offset < usages[j].offset })
	sort.Slice(marks, func(i, j int) bool { return marks[i].offset < marks[j].offset })

	acc := newAccumulator()
	model := "unknown"
	mark := 0
	for _, usage := range usages {
		for mark < len(marks) && marks[mark].offset <= usage.offset {
			model = marks[mark].model
			mark++
		}
		if usage.date == "" {
			continue
		}
		input := usage.input - usage.cached
		if input < 0 {
			input = 0
		}
		acc.add(usage.date, model, input, usage.output, usage.cached, usage.cacheCreation)
	}
	return acc.tuples()
}

type codexPart struct {
	usages []codexUsage
	marks  []codexModelMark
}

// chunkRanges splits a file into even byte ranges.
func chunkRanges(size int64) [][2]int64 {
	count := int((size + chunkBytes - 1) / chunkBytes)
	if count < 2 {
		count = 2
	}
	step := (size + int64(count) - 1) / int64(count)
	out := make([][2]int64, 0, count)
	for index := range count {
		start := int64(index) * step
		end := start + step
		if end > size {
			end = size
		}
		if start >= end {
			break
		}
		out = append(out, [2]int64{start, end})
	}
	return out
}

// pendingFile accumulates chunk results until every range of one file is done.
type pendingFile struct {
	path    string
	mtimeMS int64
	size    int64
	parts   []codexPart
	want    int
}

func (p *pendingFile) complete() bool { return len(p.parts) == p.want }

var _ = sync.Mutex{}
