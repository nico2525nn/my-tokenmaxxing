// Package jsonx extracts a few named values from a JSON object without
// building one.
//
// encoding/json spends most of its time on reflection and allocation, which
// dominated log parsing: 206k Codex lines cost ~4s of unmarshalling on top of
// the 3.8s scan. These helpers walk the raw bytes, skip string contents
// correctly, and only materialize the values the caller asked for.
package jsonx

import "bytes"

// Value returns the raw bytes of `key`'s value in the object `data`.
// It reports false when the key is absent or `data` is not an object.
func Value(data []byte, key string) ([]byte, bool) {
	index := 0
	skipSpace(data, &index)
	if index >= len(data) || data[index] != '{' {
		return nil, false
	}
	index++

	want := []byte(key)
	for index < len(data) {
		skipSpace(data, &index)
		if index >= len(data) || data[index] == '}' {
			return nil, false
		}
		nameStart, nameEnd, next, ok := stringSpan(data, index)
		if !ok {
			return nil, false
		}
		index = next
		skipSpace(data, &index)
		if index >= len(data) || data[index] != ':' {
			return nil, false
		}
		index++
		skipSpace(data, &index)
		start := index
		end, ok := skipValue(data, index)
		if !ok {
			return nil, false
		}
		if nameEnd-nameStart == len(want) && bytesEqual(data[nameStart:nameEnd], want) {
			return data[start:end], true
		}
		index = end
		skipSpace(data, &index)
		if index < len(data) && data[index] == ',' {
			index++
		}
	}
	return nil, false
}

// String returns the decoded string value for `key`.
func String(data []byte, key string) (string, bool) {
	raw, ok := Value(data, key)
	if !ok || len(raw) < 2 || raw[0] != '"' {
		return "", false
	}
	decoded, _, ok := readString(raw, 0)
	if !ok {
		return "", false
	}
	return decoded, true
}

// Int returns the integer value for `key`.
func Int(data []byte, key string) (int64, bool) {
	raw, ok := Value(data, key)
	if !ok {
		return 0, false
	}
	index := 0
	skipSpace(raw, &index)
	negative := false
	if index < len(raw) && raw[index] == '-' {
		negative = true
		index++
	}
	var value int64
	digits := 0
	for index < len(raw) && raw[index] >= '0' && raw[index] <= '9' {
		value = value*10 + int64(raw[index]-'0')
		index++
		digits++
	}
	if digits == 0 {
		return 0, false
	}
	if negative {
		value = -value
	}
	return value, true
}

// Object is a convenience wrapper: the raw object stored at `key`.
func Object(data []byte, key string) ([]byte, bool) {
	raw, ok := Value(data, key)
	if !ok || len(raw) == 0 || raw[0] != '{' {
		return nil, false
	}
	return raw, true
}

// bytesEqual compares without importing bytes for a hot path.
func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func skipSpace(data []byte, index *int) {
	for *index < len(data) {
		switch data[*index] {
		case ' ', '\t', '\n', '\r':
			*index++
		default:
			return
		}
	}
}

// stringSpan locates a JSON string without allocating or decoding it.
func stringSpan(data []byte, start int) (contentStart, contentEnd, next int, ok bool) {
	if start >= len(data) || data[start] != '"' {
		return 0, 0, start, false
	}
	index := start + 1
	for index < len(data) {
		switch data[index] {
		case '\\':
			index += 2
			continue
		case '"':
			return start + 1, index, index + 1, true
		}
		index++
	}
	return 0, 0, start, false
}

// readString parses a JSON string starting at `start` (which must be '"'),
// returning the decoded value and the index just past the closing quote.
func readString(data []byte, start int) (string, int, bool) {
	if start >= len(data) || data[start] != '"' {
		return "", start, false
	}
	index := start + 1
	// Fast path: no escapes, so the value is a slice of the input.
	plain := true
	for index < len(data) {
		ch := data[index]
		if ch == '\\' {
			plain = false
			index += 2
			continue
		}
		if ch == '"' {
			if plain {
				return string(data[start+1 : index]), index + 1, true
			}
			return unescape(data[start+1 : index]), index + 1, true
		}
		index++
	}
	return "", start, false
}

func unescape(raw []byte) string {
	out := make([]byte, 0, len(raw))
	for index := 0; index < len(raw); index++ {
		if raw[index] != '\\' || index+1 >= len(raw) {
			out = append(out, raw[index])
			continue
		}
		index++
		switch raw[index] {
		case 'n':
			out = append(out, '\n')
		case 't':
			out = append(out, '\t')
		case 'r':
			out = append(out, '\r')
		case 'b':
			out = append(out, '\b')
		case 'f':
			out = append(out, '\f')
		case 'u':
			// Keep the escape verbatim: model ids and timestamps are ASCII, and
			// decoding \u sequences here would cost more than it is worth.
			out = append(out, '\\', 'u')
		default:
			out = append(out, raw[index])
		}
	}
	return string(out)
}

// skipValue returns the end index of the JSON value starting at `start`.
func skipValue(data []byte, start int) (int, bool) {
	if start >= len(data) {
		return start, false
	}
	switch data[start] {
	case '"':
		_, next, ok := readString(data, start)
		return next, ok
	case '{', '[':
		depth := 0
		for index := start; index < len(data); index++ {
			switch data[index] {
			case '"':
				_, _, next, ok := stringSpan(data, index)
				if !ok {
					return index, false
				}
				index = next - 1
			case '{', '[':
				depth++
			case '}', ']':
				depth--
				if depth == 0 {
					return index + 1, true
				}
			}
		}
		return len(data), false
	default:
		index := start
		for index < len(data) && data[index] != ',' && data[index] != '}' && data[index] != ']' {
			index++
		}
		return index, true
	}
}

// Find* helpers locate a key by scanning for its literal `"key":` spelling and
// read the value in place. This skips the surrounding document entirely, which
// matters for session logs whose `content` arrays dwarf the usage record.
//
// A JSON string escapes its quotes, so the byte sequence `"key":` cannot occur
// inside a string value; it only ever marks a key. That makes the search safe
// without a full parse.

func findValueStart(data []byte, key string) (int, bool) {
	needle := make([]byte, 0, len(key)+3)
	needle = append(needle, '"')
	needle = append(needle, key...)
	needle = append(needle, '"', ':')
	index := bytesIndex(data, needle)
	if index < 0 {
		return 0, false
	}
	start := index + len(needle)
	skipSpace(data, &start)
	if start >= len(data) {
		return 0, false
	}
	return start, true
}

// FindObject returns the object stored at `key`.
func FindObject(data []byte, key string) ([]byte, bool) {
	start, ok := findValueStart(data, key)
	if !ok || data[start] != '{' {
		return nil, false
	}
	end, ok := skipValue(data, start)
	if !ok {
		return nil, false
	}
	return data[start:end], true
}

// FindString returns the decoded string stored at `key`.
func FindString(data []byte, key string) (string, bool) {
	start, ok := findValueStart(data, key)
	if !ok || data[start] != '"' {
		return "", false
	}
	value, _, ok := readString(data, start)
	return value, ok
}

// FindInt returns the integer stored at `key`.
func FindInt(data []byte, key string) (int64, bool) {
	start, ok := findValueStart(data, key)
	if !ok {
		return 0, false
	}
	index := start
	negative := false
	if index < len(data) && data[index] == '-' {
		negative = true
		index++
	}
	var value int64
	digits := 0
	for index < len(data) && data[index] >= '0' && data[index] <= '9' {
		value = value*10 + int64(data[index]-'0')
		index++
		digits++
	}
	if digits == 0 {
		return 0, false
	}
	if negative {
		value = -value
	}
	return value, true
}

func bytesIndex(haystack, needle []byte) int { return bytes.Index(haystack, needle) }
