BINARY := tokenmaxxing
GO     := go
# The Go env on some machines points GOCACHE at a stale path; keep the build
# self-contained so `make` works from a clean checkout.
export GOCACHE ?= $(HOME)/.cache/go-build

.PHONY: all build run test layout-test tidy clean

all: build

build:
	$(GO) build -trimpath -ldflags "-s -w" -o $(BINARY) ./cmd/tokenmaxxing

run: build
	./$(BINARY) -public public

test:
	$(GO) test ./...

# Drives headless Chrome across 320-1440px and fails if anything paints outside
# the viewport. Needs Chrome; no extra dependencies.
layout-test: build
	node test/layout.mjs

tidy:
	$(GO) mod tidy

clean:
	rm -f $(BINARY)
