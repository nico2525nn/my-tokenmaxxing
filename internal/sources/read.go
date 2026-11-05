package sources

import (
	"log"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/nico2525nn/my-tokenmaxxing/internal/cache"
	"github.com/nico2525nn/my-tokenmaxxing/internal/model"
	"github.com/nico2525nn/my-tokenmaxxing/internal/scan"
)

// Result is the outcome of one read pass.
type Result struct {
	Records []model.Record
	// Produced maps a source name to the number of aggregate rows it contributed.
	Produced map[string]int
	// Changed counts files and databases that had to be re-read.
	Changed int
}

type job struct {
	path   string
	source string
	size   int64
	parse  func(string) ([]cache.Tuple, error)
}

type group struct {
	name   string
	dir    string
	suffix []string
	parse  func(string) ([]cache.Tuple, error)
}

func groups() []group {
	return []group{
		{"codex", filepath.Join(homeDir(), ".codex", "sessions"), []string{".jsonl", ".jsonl.zst"}, parseCodex},
		{"codex", filepath.Join(homeDir(), ".codex", "archived_sessions"), []string{".jsonl", ".jsonl.zst"}, parseCodex},
		{"pi", filepath.Join(homeDir(), ".pi", "agent", "sessions"), []string{".jsonl", ".jsonl.zst"}, parseSessionLogs},
		{"omp", filepath.Join(homeDir(), ".omp", "agent", "sessions"), []string{".jsonl"}, parseSessionLogs},
	}
}

// ReadAll walks every source, reusing cached rows for files whose mtime+size
// still match. Changed files are parsed in parallel across CPUs.
func ReadAll(maxCacheBytes int64) (Result, error) {
	fileCache := cache.Load()
	result := Result{Produced: map[string]int{}}

	var (
		mu   sync.Mutex
		live []string
		jobs []job
	)

	collect := func(source string, tuples []cache.Tuple) {
		if len(tuples) == 0 {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		result.Produced[source] += len(tuples)
		for _, tuple := range tuples {
			result.Records = append(result.Records, model.Record{
				Date:          tuple.Date,
				Source:        source,
				Model:         tuple.Model,
				Input:         tuple.Input,
				Output:        tuple.Output,
				CacheRead:     tuple.CacheRead,
				CacheCreation: tuple.CacheCreation,
				Total:         tuple.Total,
			})
		}
	}

	// The OpenCode query takes ~0.8s; run it alongside the JSONL scan rather than
	// after it.
	type openCodeOutcome struct {
		tuples      []cache.Tuple
		mtime, size int64
		ok          bool
	}
	openCodeChannel := make(chan openCodeOutcome, 1)
	go func() {
		tuples, mtime, size, ok := ReadOpenCode()
		openCodeChannel <- openCodeOutcome{tuples, mtime, size, ok}
	}()

	for _, g := range groups() {
		if _, err := os.Stat(g.dir); err != nil {
			continue
		}
		groupStart := time.Now()
		for _, path := range scan.Collect(g.dir, g.suffix) {
			live = append(live, path)
			info, err := os.Stat(path)
			if err != nil {
				continue
			}
			if tuples, ok := fileCache.Get(path, info.ModTime().UnixMilli(), info.Size()); ok {
				collect(g.name, tuples)
				continue
			}
			parse := g.parse
			// Big uncompressed rollouts are range-scanned in parallel; zstd needs a
			// sequential stream, so those stay whole.
			if g.name == "codex" && info.Size() >= splitThreshold && filepath.Ext(path) == ".jsonl" {
				size := info.Size()
				parse = func(target string) ([]cache.Tuple, error) { return parseCodexSplit(target, size) }
			}
			jobs = append(jobs, job{path: path, source: g.name, size: info.Size(), parse: parse})
		}
		if os.Getenv("TOKENMAXXING_TRACE") != "" {
			log.Printf("scan %s/%s: %d files in %s", g.name, filepath.Base(g.dir), len(jobs), time.Since(groupStart))
		}
	}

	if len(jobs) > 0 {
		parseStart := time.Now()
		changed := parseJobs(jobs, fileCache, collect)
		result.Changed += changed
		if os.Getenv("TOKENMAXXING_TRACE") != "" {
			log.Printf("parse %d files: %s", len(jobs), time.Since(parseStart))
		}
	}

	openCodeResult := <-openCodeChannel
	openCodeKey := "opencode:" + filepath.Join(homeDir(), ".local", "share", "opencode", "opencode.db")
	if openCodeResult.ok {
		if cachedTuples, hit := fileCache.Get(openCodeKey, openCodeResult.mtime, openCodeResult.size); hit {
			collect("opencode", cachedTuples)
		} else {
			fileCache.Put(openCodeKey, openCodeResult.mtime, openCodeResult.size, openCodeResult.tuples)
			result.Changed++
			collect("opencode", openCodeResult.tuples)
		}
	}

	othersStart := time.Now()
	collect("zcode", ReadZCode())
	collect("reasonix", ReadReasonix())
	collect("opengrok", ReadOpenGrok())
	collect("dsh", ReadDsh())
	if os.Getenv("TOKENMAXXING_TRACE") != "" {
		log.Printf("other sources: %s", time.Since(othersStart))
	}

	removed := fileCache.Prune(live)
	if result.Changed > 0 || removed > 0 {
		if _, _, err := fileCache.Save(maxCacheBytes); err != nil {
			return result, err
		}
	}
	return result, nil
}

// parseJobs runs the changed files through a small goroutine pool.
func parseJobs(jobs []job, fileCache *cache.File, collect func(string, []cache.Tuple)) int {
	// Parsing is CPU-bound (decompression + JSON), so use every core. Files are
	// independent, and the pool is bounded by the job list anyway.
	workers := runtime.NumCPU()
	if workers < 1 {
		workers = 1
	}
	if raw := os.Getenv("TOKENMAXXING_WORKERS"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			workers = parsed
		}
	}

	// Longest job first: one 3GB rollout would otherwise finish long after every
	// small session and define the whole makespan.
	sort.Slice(jobs, func(i, j int) bool { return jobs[i].size > jobs[j].size })

	queue := make(chan job)
	var wg sync.WaitGroup
	var mu sync.Mutex
	changed := 0
	perSource := map[string]time.Duration{}
	trace := os.Getenv("TOKENMAXXING_TRACE") != ""

	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for item := range queue {
				jobStart := time.Now()
				tuples, err := item.parse(item.path)
				if trace {
					mu.Lock()
					perSource[item.source] += time.Since(jobStart)
					mu.Unlock()
				}
				info, statErr := os.Stat(item.path)
				if statErr != nil {
					continue
				}
				mu.Lock()
				// Cache even a partial result: the next run compares mtime/size, so
				// an unreadable file is retried only when it changes.
				fileCache.Put(item.path, info.ModTime().UnixMilli(), info.Size(), tuples)
				if err == nil {
					changed++
				}
				mu.Unlock()
				if err == nil {
					collect(item.source, tuples)
				} else {
					println("read failed:", item.path, err.Error())
				}
			}
		}()
	}
	for _, item := range jobs {
		queue <- item
	}
	close(queue)
	wg.Wait()
	if trace {
		for source, duration := range perSource {
			log.Printf("cpu %s: %s", source, duration.Round(time.Millisecond))
		}
	}
	return changed
}
