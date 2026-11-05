package sources

import (
	"sort"
	"sync"

	"github.com/nico2525nn/my-tokenmaxxing/internal/cache"
	"github.com/nico2525nn/my-tokenmaxxing/internal/jsonx"
	"github.com/nico2525nn/my-tokenmaxxing/internal/scan"
)

// splitThreshold is where splitting one file across cores beats keeping it whole.
// A single 3.2GB rollout otherwise defines the whole refresh.
const splitThreshold = 128 << 20

// maxChunks bounds per-file fan-out so one huge log cannot starve every other
// file in the pool.
const maxChunks = 8

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

// parseCodexSplit reads a large rollout in byte ranges and merges them.
//
// Chunks are independent, but the model in force at a usage record is decided by
// the closest preceding `turn_context`, which may live in an earlier chunk. So
// each chunk reports both usage records and model marks with their offsets, and
// the merge resolves the model by walking the two sorted lists once.
func parseCodexSplit(path string, size int64) ([]cache.Tuple, error) {
	chunks := int(size / splitThreshold)
	if chunks < 2 {
		chunks = 2
	}
	if chunks > maxChunks {
		chunks = maxChunks
	}

	var (
		mu       sync.Mutex
		usages   = make([]codexUsage, 0, 1024)
		marks    = make([]codexModelMark, 0, 64)
		wg       sync.WaitGroup
		firstErr error
	)

	chunkSize := (size + int64(chunks) - 1) / int64(chunks)
	for index := range chunks {
		start := int64(index) * chunkSize
		end := start + chunkSize
		if end > size {
			end = size
		}
		if start >= end {
			continue
		}
		wg.Add(1)
		go func(start, end int64) {
			defer wg.Done()
			var (
				localUsages []codexUsage
				localMarks  []codexModelMark
			)
			err := scan.LinesRange(path, start, end, codexMarkers, func(offset int64, line scan.Line) error {
				payload, ok := jsonx.Object(line, "payload")
				if !ok {
					return nil
				}
				if usage, isUsage := jsonx.Object(payload, "usage"); isUsage {
					localUsages = append(localUsages, codexUsage{
						offset:        offset,
						date:          localDate(stringOf(line, "timestamp")),
						input:         intOf(usage, "input_tokens"),
						output:        intOf(usage, "output_tokens"),
						cached:        intOf(usage, "cached_input_tokens"),
						cacheCreation: intOf(usage, "cache_write_input_tokens"),
					})
					return nil
				}
				if name, has := jsonx.String(payload, "model"); has && name != "" {
					localMarks = append(localMarks, codexModelMark{offset: offset, model: name})
				}
				return nil
			})
			mu.Lock()
			defer mu.Unlock()
			if err != nil && firstErr == nil {
				firstErr = err
			}
			usages = append(usages, localUsages...)
			marks = append(marks, localMarks...)
		}(start, end)
	}
	wg.Wait()
	if firstErr != nil {
		return nil, firstErr
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
	return acc.tuples(), nil
}
