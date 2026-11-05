// Package cache stores per-file parse results so a refresh only touches logs
// that changed since the previous run.
//
// Each file is keyed by mtime+size; its aggregated rows live once under a
// content hash, so files producing identical rows share one entry. The file is
// size-capped: when it would exceed the limit, the coldest entries are dropped
// and rebuilt later instead of growing without bound.
package cache

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
)

// Tuple is one aggregated (date, model) row: date, model, input, output,
// cacheRead, cacheCreation, total.
type Tuple struct {
	Date          string `json:"d"`
	Model         string `json:"m"`
	Input         int64  `json:"i"`
	Output        int64  `json:"o"`
	CacheRead     int64  `json:"cr"`
	CacheCreation int64  `json:"cc"`
	Total         int64  `json:"t"`
}

// Entry records a file's identity and the hash holding its rows.
type Entry struct {
	MTimeMS int64  `json:"mtime"`
	Size    int64  `json:"size"`
	Key     string `json:"key"`
}

// File is the on-disk cache document.
type File struct {
	Version int                `json:"version"`
	Files   map[string]*Entry  `json:"files"`
	Aggs    map[string][]Tuple `json:"aggs"`
	// OpenCode remembers the sqlite db/WAL signature it ran against.
	OpenCodeOpenCodeIgnored string `json:"-"`
	OpenCode                *Entry `json:"opencode,omitempty"`
}

const version = 1

// DefaultMaxBytes bounds the cache file size.
const DefaultMaxBytes = 8 << 20

// Path returns the cache location.
func Path() (string, error) {
	dir, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "tokenmaxxing", "readers-cache.json"), nil
}

// Load reads the cache, returning an empty document when it is missing or
// written by an incompatible version.
func Load() *File {
	empty := &File{Version: version, Files: map[string]*Entry{}, Aggs: map[string][]Tuple{}}
	path, err := Path()
	if err != nil {
		return empty
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return empty
	}
	var file File
	if json.Unmarshal(raw, &file) != nil || file.Version != version || file.Files == nil || file.Aggs == nil {
		return empty
	}
	return &file
}

// Key derives the stable identity of an aggregate row set.
func Key(tuples []Tuple) string {
	raw, _ := json.Marshal(tuples)
	sum := sha1.Sum(raw)
	return hex.EncodeToString(sum[:])[:20]
}

// Put stores a file's rows and returns whether anything changed.
func (f *File) Put(path string, mtimeMS, size int64, tuples []Tuple) bool {
	key := Key(tuples)
	if existing, ok := f.Files[path]; ok && existing.MTimeMS == mtimeMS && existing.Size == size && existing.Key == key {
		return false
	}
	f.Files[path] = &Entry{MTimeMS: mtimeMS, Size: size, Key: key}
	f.Aggs[key] = tuples
	return true
}

// Get returns cached rows for a file when its identity still matches.
func (f *File) Get(path string, mtimeMS, size int64) ([]Tuple, bool) {
	entry, ok := f.Files[path]
	if !ok || entry.MTimeMS != mtimeMS || entry.Size != size {
		return nil, false
	}
	tuples, ok := f.Aggs[entry.Key]
	return tuples, ok
}

// Prune drops entries for files that no longer exist and aggregates nothing
// references. It reports how many file entries were removed.
func (f *File) Prune(live []string) int {
	keep := make(map[string]struct{}, len(live))
	for _, path := range live {
		keep[path] = struct{}{}
	}
	removed := 0
	for path := range f.Files {
		if _, ok := keep[path]; !ok {
			delete(f.Files, path)
			removed++
		}
	}
	if removed > 0 {
		f.pruneAggs()
	}
	return removed
}

func (f *File) pruneAggs() {
	live := make(map[string]struct{}, len(f.Files))
	for _, entry := range f.Files {
		live[entry.Key] = struct{}{}
	}
	if f.OpenCode != nil {
		live[f.OpenCode.Key] = struct{}{}
	}
	for key := range f.Aggs {
		if _, ok := live[key]; !ok {
			delete(f.Aggs, key)
		}
	}
}

// Save writes the cache atomically, shrinking it to maxBytes first.
// It returns the bytes written and how many entries were dropped.
func (f *File) Save(maxBytes int64) (int, int, error) {
	path, err := Path()
	if err != nil {
		return 0, 0, err
	}
	raw, err := json.Marshal(f)
	if err != nil {
		return 0, 0, err
	}

	dropped := 0
	if int64(len(raw)) > maxBytes {
		// Coldest first: those are the least likely to be revisited.
		type pair struct {
			path  string
			mtime int64
		}
		entries := make([]pair, 0, len(f.Files))
		for path, entry := range f.Files {
			entries = append(entries, pair{path, entry.MTimeMS})
		}
		sort.Slice(entries, func(i, j int) bool { return entries[i].mtime < entries[j].mtime })
		for _, entry := range entries {
			if int64(len(raw)) <= maxBytes {
				break
			}
			delete(f.Files, entry.path)
			dropped++
			if raw, err = json.Marshal(f); err != nil {
				return 0, dropped, err
			}
		}
		f.pruneAggs()
		if raw, err = json.Marshal(f); err != nil {
			return 0, dropped, err
		}
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return 0, dropped, err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return 0, dropped, err
	}
	if err := os.Rename(tmp, path); err != nil {
		return 0, dropped, err
	}
	return len(raw), dropped, nil
}
