package jsonx

import "testing"

func TestValueAndTypes(t *testing.T) {
	line := []byte(`{"timestamp":"2026-10-08T09:21:43Z","payload":{"model":"gpt-6-luna","usage":{"input_tokens":16660,"cached_input_tokens":16128,"output_tokens":463},"nested":{"a":[1,2,{"b":"x"}]}}}`)

	payload, ok := Object(line, "payload")
	if !ok {
		t.Fatal("payload missing")
	}
	usage, ok := Object(payload, "usage")
	if !ok {
		t.Fatal("usage missing")
	}
	if got, _ := Int(usage, "input_tokens"); got != 16660 {
		t.Fatalf("input_tokens = %d", got)
	}
	if got, _ := Int(usage, "cached_input_tokens"); got != 16128 {
		t.Fatalf("cached = %d", got)
	}
	if got, ok := String(payload, "model"); !ok || got != "gpt-6-luna" {
		t.Fatalf("model = %q ok=%v", got, ok)
	}
	if got, ok := String(line, "timestamp"); !ok || got != "2026-10-08T09:21:43Z" {
		t.Fatalf("timestamp = %q ok=%v", got, ok)
	}
}

func TestMissingKeysAndWrongShapes(t *testing.T) {
	if _, ok := Object([]byte(`{"a":1}`), "payload"); ok {
		t.Fatal("absent key reported present")
	}
	if _, ok := Int([]byte(`{"a":"text"}`), "a"); ok {
		t.Fatal("string accepted as int")
	}
	if _, ok := Object([]byte(`not json`), "a"); ok {
		t.Fatal("garbage accepted")
	}
}

func TestKeysInsideStringsAreIgnored(t *testing.T) {
	line := []byte(`{"content":"\"type\":\"token_usage_record\"","type":"message"}`)
	if got, ok := String(line, "type"); !ok || got != "message" {
		t.Fatalf("type = %q ok=%v", got, ok)
	}
	if _, ok := Object(line, "cached_input_tokens"); ok {
		t.Fatal("key inside a string value was matched")
	}
}

func TestEscapedStrings(t *testing.T) {
	line := []byte(`{"model":"a\"b\\c"}`)
	if got, ok := String(line, "model"); !ok || got != `a"b\c` {
		t.Fatalf("model = %q ok=%v", got, ok)
	}
}

func TestNestedObjectIsSkippedToFindSibling(t *testing.T) {
	line := []byte(`{"payload":{"deep":{"deeper":[{"x":1},{"y":2}]}},"tail":42}`)
	if got, ok := Int(line, "tail"); !ok || got != 42 {
		t.Fatalf("tail = %d ok=%v", got, ok)
	}
}
