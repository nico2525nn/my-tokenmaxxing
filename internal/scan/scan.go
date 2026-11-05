// Package scan streams JSONL logs without decoding bytes it does not need.
//
// Logs are line-oriented JSON where only a small fraction of lines carry usage.
// Splitting on the newline byte and testing the raw slice for a marker keeps the
// work close to I/O speed: on a 6GB Codex backlog this is ~1s versus ~23s for
// decoding every line to a string first.
package scan

import (
	"bytes"
	"io"
	"os"
	"path/filepath"

	"github.com/klauspost/compress/zstd"
)

// Line is a raw JSONL line plus the path it came from.
type Line []byte

// Markers bundles the substrings a parser cares about.
type Markers [][]byte

// New builds a marker set from literal strings.
func New(values ...string) Markers {
	out := make(Markers, len(values))
	for i, value := range values {
		out[i] = []byte(value)
	}
	return out
}

// Lines calls fn for every line containing any marker. `fn` must not retain the
// slice: it aliases the read buffer.
//
// This is a fixed-buffer scanner rather than bufio.Scanner on purpose. Scanner
// grows its buffer up to the longest line, and Codex rollouts contain
// multi-megabyte lines, which turned a 6GB scan into gigabytes of memmove.
// Here the buffer never grows: anything past the last newline is carried into
// the next read.
func Lines(path string, markers Markers, fn func(Line) error) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()

	var reader io.Reader = file
	if filepath.Ext(path) == ".zst" {
		decoder, derr := zstd.NewReader(file, zstd.WithDecoderConcurrency(1), zstd.WithDecoderLowmem(true))
		if derr != nil {
			return derr
		}
		defer decoder.Close()
		reader = decoder
	}

	buf := make([]byte, readChunk)
	var carry []byte

	for {
		n, readErr := reader.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			start := 0
			for {
				offset := bytes.IndexByte(chunk[start:], newline)
				if offset == -1 {
					break
				}
				end := start + offset
				var line []byte
				if len(carry) > 0 {
					carry = append(carry, chunk[start:end]...)
					line = carry
					carry = nil
				} else {
					line = chunk[start:end]
				}
				if matches(line, markers) {
					if ferr := fn(line); ferr != nil {
						return ferr
					}
				}
				start = end + 1
			}
			if start < n {
				// Keep the tail for the next read; copy so `buf` can be reused.
				carry = append(carry[:0], chunk[start:]...)
			}
		}
		if readErr != nil {
			if readErr != io.EOF {
				return readErr
			}
			break
		}
	}
	if len(carry) > 0 && matches(carry, markers) {
		return fn(carry)
	}
	return nil
}

const (
	newline   = 0x0a
	readChunk = 1 << 20
)

// LinesRange scans [start, end) of a plain (uncompressed) file, reporting each
// matching line together with its absolute byte offset. Chunk boundaries are
// aligned to the next newline so a line is never split across two ranges.
func LinesRange(path string, start, end int64, markers Markers, fn func(offset int64, line Line) error) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()

	if _, err := file.Seek(start, io.SeekStart); err != nil {
		return err
	}
	if start > 0 {
		// If the byte before `start` is a newline, the chunk already begins on a
		// line boundary and nothing is owed to the previous chunk.
		previous := make([]byte, 1)
		if _, err := file.ReadAt(previous, start-1); err == nil && previous[0] != newline {
			// Drop the remainder of the line the previous chunk owns.
			skip := make([]byte, 64<<10)
			for {
				n, readErr := file.Read(skip)
				if n > 0 {
					if idx := bytes.IndexByte(skip[:n], newline); idx != -1 {
						break
					}
				}
				if readErr != nil {
					return nil
				}
			}
		}
	}

	var offset int64
	if current, err := file.Seek(0, io.SeekCurrent); err == nil {
		offset = current
	}

	buf := make([]byte, readChunk)
	var carry []byte
	carryStart := offset

	for {
		n, readErr := file.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			startIndex := 0
			for {
				index := bytes.IndexByte(chunk[startIndex:], newline)
				if index == -1 {
					break
				}
				lineEnd := startIndex + index
				var line []byte
				var lineOffset int64
				if len(carry) > 0 {
					carry = append(carry, chunk[startIndex:lineEnd]...)
					line = carry
					lineOffset = carryStart
					carry = nil
				} else {
					line = chunk[startIndex:lineEnd]
					lineOffset = offset + int64(startIndex)
				}
				if lineOffset >= end {
					return nil
				}
				if matches(line, markers) {
					if ferr := fn(lineOffset, line); ferr != nil {
						return ferr
					}
				}
				startIndex = lineEnd + 1
			}
			if startIndex < n {
				if len(carry) == 0 {
					carryStart = offset + int64(startIndex)
				}
				carry = append(carry[:0], chunk[startIndex:]...)
			}
			offset += int64(n)
		}
		if readErr != nil {
			if readErr != io.EOF {
				return readErr
			}
			break
		}
	}
	if len(carry) > 0 && carryStart < end && matches(carry, markers) {
		return fn(carryStart, carry)
	}
	return nil
}

// markerWindow bounds the prefix searched for a marker. Every supported log puts
// its `"type"` field within the first few dozen bytes, and searching the whole
// line would rescan gigabytes: a 3KB line times two million lines dominated the
// refresh more than the actual parsing.
const markerWindow = 128

func matches(line []byte, markers Markers) bool {
	probe := line
	if len(probe) > markerWindow {
		probe = probe[:markerWindow]
	}
	for _, marker := range markers {
		if bytes.Contains(probe, marker) {
			return true
		}
	}
	return false
}

// Collect walks dir and returns files ending with any of suffixes.
func Collect(dir string, suffixes []string) []string {
	var out []string
	_ = filepath.WalkDir(dir, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return nil
		}
		for _, suffix := range suffixes {
			if filepath.Ext(path) == suffix || hasSuffix(path, suffix) {
				out = append(out, path)
				return nil
			}
		}
		return nil
	})
	return out
}

func hasSuffix(value, suffix string) bool {
	return len(value) >= len(suffix) && value[len(value)-len(suffix):] == suffix
}
