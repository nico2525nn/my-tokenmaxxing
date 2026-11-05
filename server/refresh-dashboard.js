import { mkdirSync, writeFileSync, renameSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { buildDashboard, sourceStamp } from "./data-fetcher.js";

// Runs as a child process so synchronous JSONL/db reading never blocks the HTTP
// server. Writes atomically: readers only ever see a complete file.
export const CACHE_DIR = join(homedir(), ".cache", "tokenmaxxing");
export const CACHE_FILE = join(CACHE_DIR, "dashboard.json");

const started = Date.now();

function readPrevious() {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
  } catch {
    return null;
  }
}

try {
  // Skip the whole rebuild when every input is untouched. Without this the
  // minute timer re-aggregated unchanged history forever.
  const previous = readPrevious();
  const stamp = sourceStamp();
  // A directory mtime cannot see an in-place append, so force a full sweep at
  // least every MAX_SKIP_MS instead of trusting the stamp indefinitely.
  const MAX_SKIP_MS = 10 * 60_000;
  const age = previous?.generatedAt ? Date.now() - Date.parse(previous.generatedAt) : Infinity;
  if (previous?.stamp && previous.stamp === stamp && age < MAX_SKIP_MS) {
    console.log(`[refresh] no source changes (${Math.round(age / 1000)}s since last build), keeping cached snapshot`);
    process.exit(0);
  }

  const payload = await buildDashboard();
  mkdirSync(CACHE_DIR, { recursive: true });
  const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload));
  renameSync(tmp, CACHE_FILE);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `[refresh] ${payload.daily.length} days, ${payload.models.length} model rows, ` +
    `${(payload.totals.tokens / 1e9).toFixed(2)}B tokens in ${seconds}s`,
  );
} catch (error) {
  console.error("[refresh] failed:", error?.message || error);
  process.exit(1);
}
