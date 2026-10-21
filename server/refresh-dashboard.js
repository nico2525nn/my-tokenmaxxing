import { mkdirSync, writeFileSync, renameSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { buildDashboard } from "./data-fetcher.js";

// Runs as a child process so the 15-20s of synchronous JSONL/CLI reading never
// blocks the HTTP server. Writes atomically: readers only ever see a complete
// file.
export const CACHE_DIR = join(homedir(), ".cache", "tokenmaxxing");
export const CACHE_FILE = join(CACHE_DIR, "dashboard.json");

const started = Date.now();

try {
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
