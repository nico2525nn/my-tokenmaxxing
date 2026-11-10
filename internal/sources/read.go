package sources

import (
	"log"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
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
	// Whole-file jobs use parse; range jobs use start/end and feed codexParts.
	parse      func(string) ([]cache.Tuple, error)
	start, end int64
	chunk      bool
	owner      string
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

// Options narrows a read pass. Archives are the only slice large enough to
// matter: they are old, immutable, and dominate a cold scan.
type Options struct {
	// Zstd selects whether compressed archives are read.
	Zstd bool
	// Plain selects whether uncompressed logs are read.
	Plain bool
	// Cache lets the caller share one cache document across concurrent passes.
	// When set, ReadAll neither loads nor saves it.
	Cache *cache.File
	// Mu guards Cache when several passes run at once.
	Mu *sync.Mutex
	// Partial is called once every uncompressed file has been read, so the caller
	// can publish a first snapshot while archives are still being folded in.
	Partial func([]model.Record)
}

// ReadAll walks every source, reusing cached rows for files whose mtime+size
// still match. Changed files are parsed in parallel across CPUs.
func ReadAll(maxCacheBytes int64, options ...Options) (Result, error) {
	opts := Options{Zstd: true, Plain: true}
	if len(options) > 0 {
		opts = options[0]
	}
	fileCache := opts.Cache
	if fileCache == nil {
		fileCache = cache.Load()
	}
	result := Result{Produced: map[string]int{}}

	var (
		mu      sync.Mutex
		live    []string
		jobs    []job
		pending = map[string]*pendingFile{}
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
	openCodeKey := "opencode:" + openCodePath()
	openCodeSignature, openCodePresent := OpenCodeSignature()
	cachedOpenCode, openCodeHit := []cache.Tuple(nil), false
	if opts.Plain && openCodePresent {
		cachedOpenCode, openCodeHit = fileCache.Get(openCodeKey, 0, signatureID(openCodeSignature))
	}
	openCodeChannel := make(chan openCodeOutcome, 1)
	if !opts.Plain {
		openCodeChannel <- openCodeOutcome{}
	} else {
		go func() {
			if openCodeHit {
				openCodeChannel <- openCodeOutcome{tuples: cachedOpenCode, ok: true}
				return
			}
			if !openCodePresent {
				openCodeChannel <- openCodeOutcome{}
				return
			}
			tuples, ok := ReadOpenCode()
			openCodeChannel <- openCodeOutcome{tuples: tuples, ok: ok}
		}()
	}

	for _, g := range groups() {
		if _, err := os.Stat(g.dir); err != nil {
			continue
		}
		groupStart := time.Now()
		for _, path := range scan.Collect(g.dir, g.suffix) {
			if strings.HasSuffix(path, ".zst") && !opts.Zstd {
				continue
			}
			if !strings.HasSuffix(path, ".zst") && !opts.Plain {
				continue
			}
			live = append(live, path)
			info, err := os.Stat(path)
			if err != nil {
				continue
			}
			if tuples, ok := fileCache.Get(path, info.ModTime().UnixMilli(), info.Size()); ok {
				collect(g.name, tuples)
				continue
			}
			// Big uncompressed rollouts become several chunk jobs so they share the
			// pool with everything else; zstd files need a sequential stream and stay
			// whole.
			if g.name == "codex" && info.Size() >= splitThreshold && filepath.Ext(path) == ".jsonl" {
				ranges := chunkRanges(info.Size())
				pending[path] = &pendingFile{path: path, mtimeMS: info.ModTime().UnixMilli(), size: info.Size(), want: len(ranges)}
				for _, span := range ranges {
					jobs = append(jobs, job{path: path, source: g.name, size: span[1] - span[0], chunk: true, start: span[0], end: span[1], owner: path})
				}
				continue
			}
			jobs = append(jobs, job{path: path, source: g.name, size: info.Size(), parse: g.parse})
		}
		if os.Getenv("TOKENMAXXING_TRACE") != "" {
			log.Printf("scan %s/%s: %d files in %s", g.name, filepath.Base(g.dir), len(jobs), time.Since(groupStart))
		}
	}

	plainRemaining := 0
	plainFiles := map[string]struct{}{}
	for _, item := range jobs {
		if strings.HasSuffix(item.path, ".zst") {
			continue
		}
		if _, seen := plainFiles[item.path]; seen {
			continue
		}
		plainFiles[item.path] = struct{}{}
		plainRemaining++
	}
	if len(jobs) > 0 {
		parseStart := time.Now()
		changed := parseJobs(jobs, pending, fileCache, collect, func(records []model.Record) {
			if opts.Partial != nil {
				opts.Partial(records)
			}
		}, &plainRemaining, &mu, &result)
		result.Changed += changed
		if os.Getenv("TOKENMAXXING_TRACE") != "" {
			log.Printf("parse %d files: %s", len(jobs), time.Since(parseStart))
		}
	}

	openCodeResult := <-openCodeChannel
	if openCodeResult.ok {
		if !openCodeHit {
			fileCache.Put(openCodeKey, 0, signatureID(openCodeSignature), openCodeResult.tuples)
			result.Changed++
		}
		collect("opencode", openCodeResult.tuples)
	}

	othersStart := time.Now()
	if opts.Plain {
		collect("zcode", ReadZCode())
		collect("reasonix", ReadReasonix())
		collect("opengrok", ReadOpenGrok())
		collect("dsh", ReadDsh())
	}
	if os.Getenv("TOKENMAXXING_TRACE") != "" {
		log.Printf("other sources: %s", time.Since(othersStart))
	}

	if opts.Cache == nil {
		// The OpenCode entry is keyed by the database, not by a path under `live`, so
		// it has to be protected from the path-based prune.
		if openCodePresent {
			live = append(live, openCodeKey)
		}
		removed := fileCache.Prune(live)
		if result.Changed > 0 || removed > 0 {
			if _, _, err := fileCache.Save(maxCacheBytes); err != nil {
				return result, err
			}
		}
	}
	return result, nil
}

// parseJobs runs the changed files through a small goroutine pool.
func parseJobs(
	jobs []job,
	pending map[string]*pendingFile,
	fileCache *cache.File,
	collect func(string, []cache.Tuple),
	onPlainDone func([]model.Record),
	plainRemaining *int,
	sharedMu *sync.Mutex,
	sharedResult *Result,
) int {
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

	// Uncompressed logs come first so the caller can publish a snapshot as soon as
	// they are done; within each class the longest job leads, because one 3GB
	// rollout would otherwise finish long after every small session.
	sort.Slice(jobs, func(i, j int) bool {
		iZst := strings.HasSuffix(jobs[i].path, ".zst")
		jZst := strings.HasSuffix(jobs[j].path, ".zst")
		if iZst != jZst {
			return !iZst
		}
		return jobs[i].size > jobs[j].size
	})

	queue := make(chan job)
	var wg sync.WaitGroup
	var mu sync.Mutex
	changed := 0

	// finishPlain publishes the first snapshot exactly once, after the last
	// uncompressed file has been folded in. Archives keep loading behind it.
	plainDone := false
	finishPlain := func(path string) {
		if plainRemaining == nil || sharedMu == nil || strings.HasSuffix(path, ".zst") {
			return
		}
		sharedMu.Lock()
		*plainRemaining--
		fire := *plainRemaining == 0 && !plainDone
		if fire {
			plainDone = true
		}
		var snapshot []model.Record
		if fire {
			snapshot = append([]model.Record(nil), sharedResult.Records...)
		}
		sharedMu.Unlock()
		if fire && onPlainDone != nil {
			onPlainDone(snapshot)
		}
	}
	perSource := map[string]time.Duration{}
	trace := os.Getenv("TOKENMAXXING_TRACE") != ""
	var traceErr func(string, error)
	if trace {
		traceErr = func(path string, err error) { log.Printf("chunk failed %s: %v", path, err) }
	}

	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for item := range queue {
				jobStart := time.Now()
				if item.chunk {
					usages, marks, err := codexChunk(item.path, item.start, item.end)
					mu.Lock()
					if err == nil {
						entry := pending[item.owner]
						entry.parts = append(entry.parts, codexPart{usages: usages, marks: marks})
						if entry.complete() {
							delete(pending, item.owner)
							tuples := mergeCodexChunks(entry.parts)
							fileCache.Put(entry.path, entry.mtimeMS, entry.size, tuples)
							// A chunked file is one change, counted when it finishes.
							changed++
							mu.Unlock()
							collect(item.source, tuples)
							finishPlain(entry.path)
							continue
						}
					} else if traceErr != nil {
						traceErr(item.path, err)
					}
					mu.Unlock()
					continue
				}
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
					finishPlain(item.path)
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
