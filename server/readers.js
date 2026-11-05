// Direct usage readers for the sources ccusage used to cover.
//
// ccusage shells out and re-scans every log on each run (~8s here; with a 6GB
// Codex backlog it is disk-bound and re-reads unchanged history forever). These
// readers parse the same logs in-process and keep a per-file cache keyed by
// mtime+size, so a refresh only touches sessions that actually changed.
//
// Day bucketing uses the machine's local date, matching what ccusage reports
// and what "a day" means to the person reading the dashboard.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync, renameSync, createReadStream } from "fs";
import { join } from "path";
import { homedir } from "os";
import { spawn } from "node:child_process";
import readline from "node:readline";

const HOME = homedir();
const CACHE_DIR = join(HOME, ".cache", "tokenmaxxing");
const CACHE_FILE = join(CACHE_DIR, "readers-cache.json");
const CACHE_VERSION = 3;

/** `YYYY-MM-DD` in local time. Date bucketing never uses UTC here. */
export function localIsoDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function loadCache() {
  try {
    const raw = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
    if (raw?.version !== CACHE_VERSION || !raw.files || typeof raw.files !== "object") {
      return { version: CACHE_VERSION, files: {} };
    }
    return raw;
  } catch {
    return { version: CACHE_VERSION, files: {} };
  }
}

function saveCache(cache) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache));
    renameSync(tmp, CACHE_FILE);
  } catch {
    // A cache write failure only costs a rescan next time.
  }
}

function collectFiles(dir, suffixes, out = []) {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      try {
        if (entry.isDirectory()) collectFiles(full, suffixes, out);
        else if (suffixes.some((s) => entry.name.endsWith(s))) out.push(full);
      } catch {}
    }
  } catch {}
  return out;
}

async function forEachLine(file, onLine) {
  const rl = readline.createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line) onLine(line);
  }
}

// Archived Codex rollouts ship as `.jsonl.zst`; decompress through zstd so the
// parser sees the same line stream as plain files.
async function forEachLineZst(file, onLine) {
  const child = spawn("zstd", ["-dc", file], { stdio: ["ignore", "pipe", "ignore"] });
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (line) onLine(line);
    }
  } finally {
    await new Promise((resolve) => child.on("close", resolve));
  }
}

function eachLineFor(file, onLine) {
  return file.endsWith(".zst") ? forEachLineZst(file, onLine) : forEachLine(file, onLine);
}

// Aggregate one file's rows into [date, model, input, output, cacheRead,
// cacheCreation, total] tuples. A six-month rollout collapses from tens of
// thousands of turns to a handful of date/model rows, which keeps the on-disk
// cache small enough to rewrite on every refresh.
function aggregateTuples(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = `${row.period}\u0000${row.modelName}`;
    let tuple = map.get(key);
    if (!tuple) {
      tuple = [row.period, row.modelName, 0, 0, 0, 0, 0];
      map.set(key, tuple);
    }
    tuple[2] += row.inputTokens || 0;
    tuple[3] += row.outputTokens || 0;
    tuple[4] += row.cacheReadTokens || 0;
    tuple[5] += row.cacheCreationTokens || 0;
    tuple[6] += row.totalTokens || 0;
  }
  return [...map.values()];
}

function tuplesToRecords(tuples, source) {
  const out = [];
  for (const [period, model, input, output, cacheRead, cacheCreation, total] of tuples) {
    out.push({
      date: period, source, model,
      inputTokens: input, outputTokens: output,
      cacheReadTokens: cacheRead, cacheCreationTokens: cacheCreation,
      totalTokens: total,
    });
  }
  return out;
}

// Reuse a cached tuple array while the file's identity (mtime + size) holds.
async function cachedTuples(cache, file, parse) {
  let st;
  try {
    st = statSync(file);
  } catch {
    return [];
  }
  const hit = cache.files[file];
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size && Array.isArray(hit.agg)) {
    return hit.agg;
  }
  const tuples = aggregateTuples(await parse(file));
  cache.files[file] = { mtimeMs: st.mtimeMs, size: st.size, agg: tuples };
  return tuples;
}

// Drop cache entries whose files disappeared so the cache cannot grow forever.
function pruneCache(cache, livePaths) {
  const live = new Set(livePaths);
  let pruned = 0;
  for (const key of Object.keys(cache.files)) {
    if (!live.has(key)) { delete cache.files[key]; pruned++; }
  }
  return pruned;
}

/**
 * Codex rollout logs: one JSON object per line. Model choice lives on
 * `turn_context`, usage on `token_usage_record` where `input_tokens` already
 * contains `cached_input_tokens`; subtract it so cache reads stay an additive
 * bucket like every other source.
 */
async function parseCodex(file) {
  const records = [];
  let model = "unknown";
  await eachLineFor(file, (line) => {
    if (!line.includes('"type":"turn_context"') && !line.includes('"type":"token_usage_record"')) return;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    if (entry.type === "turn_context") {
      const next = entry.payload?.model;
      if (typeof next === "string" && next) model = next;
      return;
    }
    if (entry.type !== "token_usage_record") return;
    const usage = entry.payload?.usage;
    if (!usage) return;
    const date = localIsoDate(entry.timestamp);
    if (!date) return;
    const cached = Number(usage.cached_input_tokens) || 0;
    const reportedInput = Number(usage.input_tokens) || 0;
    const input = Math.max(0, reportedInput - cached);
    const output = Number(usage.output_tokens) || 0;
    const cacheCreation = Number(usage.cache_write_input_tokens) || 0;
    const total = input + output + cached + cacheCreation;
    if (total <= 0) return;
    records.push({
      period: date,
      agent: "codex",
      modelName: model,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cached,
      cacheCreationTokens: cacheCreation,
      totalTokens: total,
    });
  });
  return records;
}

/**
 * OMP and pi share a session format: `model_change` lines carry the model,
 * `message` lines carry per-turn usage. Cache reads are already additive here.
 */
function makeJsonlUsageParser(source, modelKey) {
  return async function parse(file) {
    const records = [];
    let currentModel = "unknown";
    await eachLineFor(file, (line) => {
      if (!line.includes('"model_change"') && !line.includes('"usage"')) return;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        return;
      }
      if (entry.type === "model_change") {
        const next = entry[modelKey] || entry.message?.model || entry.model;
        if (typeof next === "string" && next) currentModel = next;
        return;
      }
      if (entry.type !== "message" || entry.message?.role !== "assistant" || !entry.message?.usage) return;
      const usage = entry.message.usage;
      const date = localIsoDate(entry.timestamp);
      if (!date) return;
      const input = Number(usage.input) || 0;
      const output = Number(usage.output) || 0;
      const cacheRead = Number(usage.cacheRead) || 0;
      const cacheCreation = Number(usage.cacheWrite) || 0;
      const total = Number(usage.totalTokens) || input + output + cacheRead + cacheCreation;
      if (total <= 0) return;
      records.push({
        period: date,
        agent: source,
        modelName: entry.message.model || currentModel,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheCreation,
        totalTokens: total,
      });
    });
    return records;
  };
}

/**
 * OpenCode keeps per-message usage in SQLite. `tokens` is additive
 * (input + output + reasoning + cache.read + cache.write); reasoning is folded
 * into the output bucket to match the dashboard token contract.
 */
async function readOpenCode() {
  const dbPath = join(HOME, ".local", "share", "opencode", "opencode.db");
  if (!existsSync(dbPath)) {
    console.log("[readers] OpenCode db not found");
    return [];
  }
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    console.log("[readers] OpenCode skipped: node:sqlite unavailable (need Node 22.5+)");
    return [];
  }
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare(`
      SELECT json_extract(data, '$.time.created') AS created,
             json_extract(data, '$.model.id')     AS model,
             json_extract(data, '$.tokens.input') AS input,
             json_extract(data, '$.tokens.output') AS output,
             json_extract(data, '$.tokens.reasoning') AS reasoning,
             json_extract(data, '$.tokens.cache.read')  AS cache_read,
             json_extract(data, '$.tokens.cache.write') AS cache_write
      FROM session_message
      WHERE json_extract(data, '$.tokens') IS NOT NULL
    `).all();
    db.close();
    const records = [];
    for (const row of rows) {
      if (!row.created) continue;
      const input = Number(row.input) || 0;
      const output = (Number(row.output) || 0) + (Number(row.reasoning) || 0);
      const cacheRead = Number(row.cache_read) || 0;
      const cacheCreation = Number(row.cache_write) || 0;
      const total = input + output + cacheRead + cacheCreation;
      if (total <= 0) continue;
      records.push({
        date: localIsoDate(Number(row.created)),
        source: "opencode",
        model: row.model || "unknown",
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheCreation,
        totalTokens: total,
      });
    }
    console.log(`[readers] OpenCode: ${records.length} messages`);
    return records;
  } catch (e) {
    console.error("[readers] OpenCode failed:", e.message);
    return [];
  }
}

/**
 * Read every direct source. Returns normalized records ready for aggregation.
 * `produced` reports which readers found data so the caller can decide whether
 * the ccusage fallback is needed.
 */
export async function readDirectSources(options = {}) {
  const only = Array.isArray(options.only) ? new Set(options.only) : null;
  const wants = (name) => !only || only.has(name);
  const cache = loadCache();
  const live = [];
  const records = [];
  const produced = {};

  let changedFiles = 0;
  const take = async (label, files, parse, agent) => {
    let count = 0;
    for (const file of files) {
      live.push(file);
      const before = cache.files[file];
      const tuples = await cachedTuples(cache, file, parse);
      const after = cache.files[file];
      if (!before || before.mtimeMs !== after.mtimeMs || before.size !== after.size) changedFiles++;
      if (tuples.length) {
        for (const record of tuplesToRecords(tuples, agent)) records.push(record);
        count += tuples.length;
      }
    }
    if (count) produced[label] = (produced[label] || 0) + count;
    console.log(`[readers] ${label}: ${count} rows from ${files.length} files`);
  };

  const codexDir = join(HOME, ".codex", "sessions");
  if (wants("codex") && existsSync(codexDir)) {
    await take("codex", collectFiles(codexDir, [".jsonl", ".jsonl.zst"]), parseCodex, "codex");
  }
  const codexArchive = join(HOME, ".codex", "archived_sessions");
  if (wants("codex") && existsSync(codexArchive)) {
    await take("codex", collectFiles(codexArchive, [".jsonl", ".jsonl.zst"]), parseCodex, "codex");
  }

  const piDir = join(HOME, ".pi", "agent", "sessions");
  if (wants("pi") && existsSync(piDir)) {
    await take("pi", collectFiles(piDir, [".jsonl", ".jsonl.zst"]), makeJsonlUsageParser("pi", "modelId"), "pi");
  }

  const ompDir = join(HOME, ".omp", "agent", "sessions");
  if (wants("omp") && existsSync(ompDir)) {
    await take("omp", collectFiles(ompDir, [".jsonl"]), makeJsonlUsageParser("omp"), "omp");
  }

  const opencode = wants("opencode") ? await readOpenCode() : [];
  if (opencode.length) {
    for (const row of opencode) records.push(row);
    produced.opencode = opencode.length;
  }

  const pruned = pruneCache(cache, live);
  // Only rewrite the cache when its contents actually changed; the mtime is a
  // cheap "did anything move?" signal for the scheduler.
  if (changedFiles > 0 || pruned > 0) saveCache(cache);
  return { records, produced, changedFiles };
}

export { makeJsonlUsageParser, aggregateTuples, tuplesToRecords, collectFiles, pruneCache, saveCache, loadCache };
