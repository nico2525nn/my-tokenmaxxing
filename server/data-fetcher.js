import { execSync, execFileSync } from "child_process";
import { readFileSync, readdirSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const HOME = homedir();

// bunx stages the package (and its ~4.7MB platform-native binary) under TMPDIR,
// which on many machines is a quota'd tmpfs (/tmp). When staging is interrupted
// it leaves a half-written tree behind, and the next bunx run reuses that tree
// and dies with SIGSEGV instead of re-extracting. Two defences:
//   1. stage into a directory we own on the real filesystem, and
//   2. fall back to npx (which stages into ~/.npm) if bunx fails anyway,
//      so a broken runner never silently drops every ccusage source.
const CCUSAGE_ARGS = "daily --json --breakdown --no-cost --by-agent";
const CCUSAGE_CANDIDATES = process.platform === "win32"
  ? [`npx -y ccusage@^20`]
  : [`bunx ccusage@^20`, `npx -y ccusage@^20`];

function ccusageEnv() {
  const staging = join(HOME, ".cache", "tokenmaxxing", "staging");
  try {
    mkdirSync(staging, { recursive: true });
    return { ...process.env, TMPDIR: staging, TMP: staging, TEMP: staging };
  } catch {
    return process.env;
  }
}

// Try to use bun:sqlite (available in Bun runtime)
let BUN_SQLITE = null;
try {
  BUN_SQLITE = await import("bun:sqlite");
} catch {
  // Not in Bun runtime, try child_process fallback
}

/**
 * Fetch data from ccusage CLI for external tools.
 * Tries each runner in turn and keeps the first one that yields real report
 * data, because "exited 0 with empty stdout" is a real failure mode here.
 */
function fetchFromCcusage() {
  console.log("[fetcher] Fetching from ccusage...");
  const failures = [];
  for (const command of CCUSAGE_CANDIDATES) {
    try {
      const stdout = execSync(`${command} ${CCUSAGE_ARGS}`, {
        timeout: 120_000,
        maxBuffer: 256 * 1024 * 1024,
        shell: process.platform === "win32" ? "cmd.exe" : true,
        encoding: "utf-8",
        env: ccusageEnv(),
      });
      const trimmed = stdout.trim();
      if (!trimmed) throw new Error("empty stdout");
      const data = JSON.parse(trimmed);
      const daily = Array.isArray(data.daily) ? data.daily : null;
      if (!daily) throw new Error("stdout has no daily array");
      console.log(`[fetcher] ccusage (${command.split(" ")[0]}): ${daily.length} days`);
      return daily;
    } catch (e) {
      const reason = (e.stderr || e.stdout || e.message || "").toString().trim().split("\n").pop();
      console.error(`[fetcher] ccusage via ${command.split(" ")[0]} failed: ${reason || e.message}`);
      failures.push(`${command.split(" ")[0]}: ${reason || e.message}`);
    }
  }
  console.error(`[fetcher] ccusage unavailable, dropping Codex/OpenCode/Claude/Gemini/Copilot/pi. ${failures.join(" | ")}`);
  return [];
}

/**
 * Read OMP session files
 */
function fetchFromOmp() {
  console.log("[fetcher] Fetching from OMP sessions...");
  const sessionsDir = join(HOME, ".omp", "agent", "sessions");
  if (!existsSync(sessionsDir)) {
    console.log("[fetcher] OMP dir not found");
    return [];
  }

  const results = [];
  const files = [];
  collectFiles(sessionsDir, files, ".jsonl");

  for (const file of files) {
    try {
      const content = readFileSync(file, "utf-8");
      const lines = content.split("\n").filter(Boolean);
      let currentModel = "unknown";

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === "model_change") {
            currentModel = normalizeModel(entry.message?.model || entry.model || "unknown");
          }
          if (entry.type === "message" && entry.message?.role === "assistant" && entry.message?.usage) {
            const u = entry.message.usage;
            const date = (entry.timestamp || "").slice(0, 10);
            if (!date) continue;
            const model = normalizeModel(entry.message.model || currentModel);
            results.push({
              period: date,
              agent: "omp",
              modelName: model,
              inputTokens: u.input || 0,
              outputTokens: u.output || 0,
              cacheReadTokens: u.cacheRead || 0,
              cacheCreationTokens: u.cacheWrite || 0,
              totalTokens: u.totalTokens || (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0),
            });
          }
        } catch {
          // skip malformed lines
        }
      }
    } catch (e) {
      console.error(`[fetcher] Error reading OMP file ${file}:`, e.message);
    }
  }

  console.log(`[fetcher] OMP: ${results.length} entries`);
  return results;
}

/**
 * Read ZCode SQLite database using bun:sqlite
 */
async function fetchFromZCode() {
  console.log("[fetcher] Fetching from ZCode...");
  const dbPath = join(HOME, ".zcode", "cli", "db", "db.sqlite");
  if (!existsSync(dbPath)) {
    console.log("[fetcher] ZCode db not found");
    return [];
  }

  try {
    if (BUN_SQLITE) {
      const { Database } = BUN_SQLITE;
      const db = new Database(dbPath);
      const rows = db.query(`
        SELECT date(started_at/1000,'unixepoch') as day, model_id,
               SUM(input_tokens) as input, SUM(output_tokens) as output,
               SUM(cache_read_input_tokens) as cache_read,
               SUM(cache_creation_input_tokens) as cache_creation,
               SUM(computed_total_tokens) as total
        FROM model_usage
        GROUP BY day, model_id
        ORDER BY day
      `).all();
      db.close();
      console.log(`[fetcher] ZCode: ${rows.length} rows`);
      return rows.map(r => ({
        period: r.day,
        agent: "zcode",
        modelName: r.model_id || "unknown",
        inputTokens: Number(r.input) || 0,
        outputTokens: Number(r.output) || 0,
        cacheReadTokens: Number(r.cache_read) || 0,
        cacheCreationTokens: Number(r.cache_creation) || 0,
        totalTokens: Number(r.total) || 0,
      }));
    }
  } catch (e) {
    console.error("[fetcher] ZCode failed:", e.message);
  }
  return [];
}

/**
 * Read Reasonix local data
 * Checks both .reasonix/sessions (events.jsonl) and APPDATA/reasonix/projects (telemetry.json)
 */
function fetchFromReasonix() {
  console.log("[fetcher] Fetching from Reasonix...");
  const results = [];
  const searchPaths = [
    join(HOME, ".reasonix", "sessions"),
    join(HOME, "AppData", "Roaming", "reasonix", "projects"),
  ];

  for (const basePath of searchPaths) {
    if (!existsSync(basePath)) continue;
    const files = [];
    if (basePath.endsWith("sessions")) {
      collectFiles(basePath, files, ".events.jsonl");
      collectFiles(basePath, files, ".telemetry.json");
    } else {
      // projects/*/sessions/
      try {
        for (const proj of readdirSync(basePath)) {
          const sesDir = join(basePath, proj, "sessions");
          if (existsSync(sesDir)) {
            collectFiles(sesDir, files, ".telemetry.json");
          }
        }
      } catch {}
    }

    for (const file of files) {
      try {
        const content = readFileSync(file, "utf-8");
        const lines = content.split("\n").filter(Boolean);

        // Try parsing as JSON lines (events.jsonl format)
        let found = false;
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            // Check various Reasonix usage formats
            const usage = entry.usage || (entry.message?.usage);
            if (usage && (usage.totalTokens || usage.completionTokens || usage.promptTokens || usage.input)) {
              found = true;
              const date = (entry.ts || entry.timestamp || "").slice(0, 10);
              const model = entry.model || entry.message?.model || "unknown";
              results.push({
                period: date,
                agent: "reasonix",
                modelName: normalizeModel(model),
                inputTokens: usage.promptTokens || usage.input || 0,
                outputTokens: usage.completionTokens || usage.output || 0,
                cacheReadTokens: usage.cacheHitTokens || usage.cacheRead || 0,
                cacheCreationTokens: usage.cacheMissTokens || usage.cacheWrite || 0,
                totalTokens: usage.totalTokens || (usage.promptTokens || 0) + (usage.completionTokens || 0),
              });
            }
          } catch {}
        }

        // If not found in lines, try as single JSON (telemetry.json format)
        if (!found) {
          try {
            const json = JSON.parse(content);
            const usage = json.usage;
        if (usage && (usage.totalTokens || usage.completionTokens || usage.promptTokens)) {
          // Extract date from filename: YYYYMMDD-HHMMSS.<id>-<model>.jsonl.telemetry.json
          const fileMatch = file.match(/(\d{4})(\d{2})(\d{2})/);
          const date = fileMatch ? `${fileMatch[1]}-${fileMatch[2]}-${fileMatch[3]}` : "";
          // Extract model name
          const modelRaw = file.match(/-([^/\\]+?)\.jsonl\.telemetry\.json$/);
          let model = modelRaw ? modelRaw[1] : "unknown";
          // Strip the unique ID prefix: numbers and period before the first hyphen after the ID
          // e.g., "024751.672111200-deepseek-deepseek-v4-flash" → "deepseek-deepseek-v4-flash"
          model = model.replace(/^\d+(\.\d+)?-/, "");
          // The model might have a duplicated provider prefix (deepseek-deepseek-v4-flash)
          // Remove the first occurrence if it matches a known provider
          model = model.replace(/^(deepseek|gemma|nemotron|gpt|moonshotai|xiaomi|tencent|minimax|hy3|mimo)-/i, "");
          model = normalizeModel(model);
          results.push({
            period: date,
            agent: "reasonix",
            modelName: model,
            inputTokens: usage.promptTokens || 0,
            outputTokens: usage.completionTokens || 0,
            cacheReadTokens: usage.cacheHitTokens || 0,
            cacheCreationTokens: usage.cacheMissTokens || 0,
            totalTokens: usage.totalTokens || (usage.promptTokens || 0) + (usage.completionTokens || 0),
          });
        }
          } catch {}
        }
      } catch (e) {
        console.error(`[fetcher] Error reading Reasonix file ${file}:`, e.message);
      }
    }
  }

  console.log(`[fetcher] Reasonix: ${results.length} entries`);
  return results;
}

/**
 * Read OpenGrok per-session usage files.
 * OpenGrok writes cumulative session totals plus per-turn deltas to
 * $OPENGROK_HOME/sessions/<cwd>/<session>/usage.json. Use turns so a session
 * contributes to the day on which each turn finished instead of double-counting
 * its cumulative summary.
 */
function fetchFromOpenGrok() {
  console.log("[fetcher] Fetching from OpenGrok...");
  const configuredHome = process.env.OPENGROK_HOME?.trim();
  const sessionsDir = join(configuredHome || join(HOME, ".opengrok"), "sessions");
  if (!existsSync(sessionsDir)) {
    console.log("[fetcher] OpenGrok dir not found");
    return [];
  }

  const files = [];
  collectFiles(sessionsDir, files, "usage.json");
  const results = [];

  for (const file of files) {
    try {
      const session = JSON.parse(readFileSync(file, "utf-8"));
      const turns = Array.isArray(session.turns) ? session.turns : [];
      for (const turn of turns) {
        const dateValue = turn?.endedAt || session.updatedAt;
        const endedAt = new Date(dateValue);
        if (Number.isNaN(endedAt.getTime())) continue;
        const date = endedAt.toISOString().slice(0, 10);

        const modelRows = turn?.modelUsage && typeof turn.modelUsage === "object"
          ? Object.entries(turn.modelUsage)
          : [];
        if (!modelRows.length) {
          modelRows.push([
            turn?.primaryModelId || session.session?.primaryModelId || "unknown",
            turn,
          ]);
        }

        for (const [modelName, usage] of modelRows) {
          // OpenGrok reports Responses-wire semantics: `inputTokens` already
          // contains `cachedReadTokens` (its own totalTokens is input+output).
          // Every other source reports cache reads as a separate additive
          // bucket, so subtract them here instead of double counting them.
          const reportedInput = Number(usage?.inputTokens) || 0;
          const outputTokens = Number(usage?.outputTokens) || 0;
          const reasoningTokens = Number(usage?.reasoningTokens) || 0;
          const cacheReadTokens = Number(usage?.cachedReadTokens) || 0;
          const cacheCreationTokens = Number(usage?.cacheCreationTokens) || 0;
          const inputTokens = Math.max(0, reportedInput - cacheReadTokens);
          const totalTokens = inputTokens + outputTokens + reasoningTokens
            + cacheReadTokens + cacheCreationTokens;
          if (totalTokens <= 0) continue;

          results.push({
            period: date,
            agent: "opengrok",
            modelName: normalizeModel(modelName),
            inputTokens,
            // OpenGrok stores reasoning separately; keep it in the output bucket
            // to match the existing dashboard token contract.
            outputTokens: outputTokens + reasoningTokens,
            cacheReadTokens,
            cacheCreationTokens,
            totalTokens,
          });
        }
      }
    } catch (e) {
      console.error(`[fetcher] Error reading OpenGrok file ${file}:`, e.message);
    }
  }

  console.log(`[fetcher] OpenGrok: ${results.length} entries`);
  return results;
}

/**
 * Read DSH (DeepSeek Harness, `dsh`) usage.
 *
 * The harness maintains a projection cache per session that already contains
 * its own authoritative token accounting (`tokenUsage.totals`), including cache
 * reads. Those totals are used directly rather than re-summing the event log,
 * which only records usage for a subset of steps. Subagent sessions are absent
 * from the projection cache and are already folded into the parent's totals, so
 * nothing extra is added for them.
 *
 * Dates come from the last prompt (falling back to session creation). Models
 * come from the session's model selection; older sessions that predate that row
 * are resolved from the `request/context` line in their event log.
 */
function fetchFromDsh() {
  console.log("[fetcher] Fetching from DSH...");
  const dshHome = process.env.DSH_HOME?.trim() || join(HOME, ".dsh");
  const projections = join(dshHome, "storages", "session_projcache", "sessions");
  if (!existsSync(projections)) {
    console.log("[fetcher] DSH projection cache not found");
    return [];
  }

  let files;
  try {
    files = readdirSync(projections).filter(name => name.endsWith(".json"));
  } catch (e) {
    console.error("[fetcher] Error listing DSH sessions:", e.message);
    return [];
  }

  const sessionsDir = join(dshHome, "sessions");
  const logIndex = new Map();
  let logIndexed = false;
  const logFor = (sessionId) => {
    if (!logIndexed) {
      logIndexed = true;
      try {
        for (const project of readdirSync(sessionsDir, { withFileTypes: true })) {
          if (!project.isDirectory()) continue;
          const projectDir = join(sessionsDir, project.name);
          for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const id = entry.name.replace(/^session-/, "");
            const dir = join(projectDir, entry.name);
            const log = readdirSync(dir).find(name => name.endsWith(".zstd"));
            if (log) logIndex.set(id, join(dir, log));
          }
        }
      } catch {
        // Older/newer layout: leave the index empty and fall back to "unknown".
      }
    }
    return logIndex.get(sessionId) || null;
  };

  const results = [];
  for (const file of files) {
    try {
      const cache = JSON.parse(readFileSync(join(projections, file), "utf-8"));
      const record = cache?.record;
      const rows = record?.rows;
      const totals = rows?.tokenUsage?.val?.totals;
      if (!totals) continue;

      const inputTokens = Number(totals.uncachedInputTokens) || 0;
      const outputTokens = Number(totals.outputTokens) || 0;
      const cacheReadTokens = Number(totals.cacheReadTokens) || 0;
      const cacheCreationTokens = Number(totals.cacheWriteTokens) || 0;
      const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;
      if (totalTokens <= 0) continue;

      const stamp = Number(rows.sessionListMetadata?.val?.lastPromptAt)
        || Number(record?.identity?.createdAt);
      if (!stamp) continue;
      const period = new Date(stamp).toISOString().slice(0, 10);

      const sessionId = (record?.identity?.id || file.replace(/\.json$/, "")).replace(/^session-/, "");
      let model = rows.modelSelection?.val?.lastUsed?.model;
      if (!model) model = dshModelFromLog(logFor(sessionId));
      if (!model) model = "unknown";

      results.push({
        period,
        agent: "dsh",
        modelName: normalizeModel(model),
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        totalTokens,
      });
    } catch (e) {
      console.error(`[fetcher] Error reading DSH session ${file}:`, e.message);
    }
  }

  console.log(`[fetcher] DSH: ${results.length} sessions`);
  return results;
}

function dshModelFromLog(logPath) {
  if (!logPath) return null;
  try {
    const raw = execFileSync("zstd", ["-dc", logPath], {
      maxBuffer: 256 * 1024 * 1024,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    let model = null;
    for (const line of raw.split("\n")) {
      if (!line.includes('"request/context"')) continue;
      try {
        const found = JSON.parse(line)?.data?.model;
        if (typeof found === "string" && found) model = found;
      } catch {
        // ignore malformed lines
      }
    }
    return model;
  } catch {
    return null;
  }
}

function collectFiles(dir, files, ext) {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          collectFiles(fullPath, files, ext);
        } else if (entry.name.endsWith(ext)) {
          files.push(fullPath);
        }
      } catch {}
    }
  } catch {}
}

function normalizeModel(model) {
  if (!model) return "unknown";
  // Strip [source] prefixes like "[pi] "
  let clean = model.replace(/^\[.*?\]\s*/, "").trim();
  // Strip known provider prefix paths (with slashes)
  clean = clean.replace(/^(openrouter|opencode-zen|opencode|anthropic|google|openai|deepseek|moonshotai|xiaomi|tencent|nemotron|minimax|gemma|nvidia)\/+/g, "");
  // For models from filenames that still have path-like structure (e.g., deepseek/v4/flash),
  // use the last meaningful part. But don't touch clean model names like "deepseek-v4-flash"
  if (clean.includes("/") && !clean.includes("-")) {
    const parts = clean.split("/").filter(Boolean);
    clean = parts.join("-");
  }
  return clean;
}

function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Aggregate all sources into unified daily records
 */
export async function aggregateAllData() {
  const ccusageDays = fetchFromCcusage();
  const ompEntries = fetchFromOmp();
  const zcodeEntries = await fetchFromZCode();
  const reasonixEntries = fetchFromReasonix();
  const opengrokEntries = fetchFromOpenGrok();
  const dshEntries = fetchFromDsh();
  const allRecords = [];

  // Process ccusage format into records
  for (const day of ccusageDays) {
    if (day.agents) {
      for (const agent of day.agents) {
        const agentName = agent.agent || "unknown";
        if (agent.modelBreakdowns) {
          for (const m of agent.modelBreakdowns) {
            const total = m.totalTokens || (m.inputTokens || 0) + (m.outputTokens || 0) + (m.cacheReadTokens || 0) + (m.cacheCreationTokens || 0);
            allRecords.push({
              date: day.period,
              source: agentName,
              model: m.modelName,
              inputTokens: m.inputTokens || 0,
              outputTokens: m.outputTokens || 0,
              cacheReadTokens: m.cacheReadTokens || 0,
              cacheCreationTokens: m.cacheCreationTokens || 0,
              totalTokens: total,
            });
          }
        }
      }
    } else if (day.modelBreakdowns) {
      const agents = day.metadata?.agents || ["unknown"];
      for (const agentName of agents) {
        for (const m of day.modelBreakdowns) {
          allRecords.push({
            date: day.period,
            source: agentName,
            model: m.modelName,
            inputTokens: m.inputTokens || 0,
            outputTokens: m.outputTokens || 0,
            cacheReadTokens: m.cacheReadTokens || 0,
            cacheCreationTokens: m.cacheCreationTokens || 0,
            totalTokens: m.totalTokens || (m.inputTokens || 0) + (m.outputTokens || 0) + (m.cacheReadTokens || 0) + (m.cacheCreationTokens || 0),
          });
        }
      }
    } else {
      allRecords.push({
        date: day.period,
        source: day.agent || "unknown",
        model: (day.modelsUsed || ["unknown"])[0],
        inputTokens: day.inputTokens || 0,
        outputTokens: day.outputTokens || 0,
        cacheReadTokens: day.cacheReadTokens || 0,
        cacheCreationTokens: day.cacheCreationTokens || 0,
        totalTokens: day.totalTokens || 0,
      });
    }
  }

  // Add OMP entries
  for (const e of ompEntries) {
    allRecords.push({
      date: e.period,
      source: "omp",
      model: e.modelName,
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      cacheReadTokens: e.cacheReadTokens,
      cacheCreationTokens: e.cacheCreationTokens,
      totalTokens: e.totalTokens,
    });
  }

  // Add ZCode entries
  for (const e of zcodeEntries) {
    allRecords.push({
      date: e.period,
      source: "zcode",
      model: e.modelName,
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      cacheReadTokens: e.cacheReadTokens,
      cacheCreationTokens: e.cacheCreationTokens,
      totalTokens: e.totalTokens,
    });
  }

  // Add Reasonix entries
  for (const e of reasonixEntries) {
    allRecords.push({
      date: e.period,
      source: "reasonix",
      model: e.modelName,
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      cacheReadTokens: e.cacheReadTokens,
      cacheCreationTokens: e.cacheCreationTokens,
      totalTokens: e.totalTokens,
    });
  }

  // Add OpenGrok entries
  for (const e of opengrokEntries) {
    allRecords.push({
      date: e.period,
      source: "opengrok",
      model: e.modelName,
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      cacheReadTokens: e.cacheReadTokens,
      cacheCreationTokens: e.cacheCreationTokens,
      totalTokens: e.totalTokens,
    });
  }

  // Add DSH entries
  for (const e of dshEntries) {
    allRecords.push({
      date: e.period,
      source: "dsh",
      model: e.modelName,
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      cacheReadTokens: e.cacheReadTokens,
      cacheCreationTokens: e.cacheCreationTokens,
      totalTokens: e.totalTokens,
    });
  }

  const records = allRecords.filter(record => isValidDate(record.date));
  if (records.length !== allRecords.length) {
    console.warn(`[fetcher] Skipped ${allRecords.length - records.length} records with invalid dates`);
  }
  console.log(`[fetcher] Total records: ${records.length}`);
  return { records };
}

const DAY_MS = 86_400_000;

/**
 * Collapse records into the compact payload the dashboard actually renders.
 *
 * Records are already keyed by (date, source, model), so grouping turns tens of
 * thousands of rows into a few hundred entries. Shipping that summary is what
 * keeps page load flat as history grows: the client no longer downloads every
 * row and re-aggregates it on each refresh.
 */
export function summarizeDashboard(records) {
  const totals = { tokens: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  const sources = new Map();
  const models = new Map();
  const days = new Map();

  const bump = (row, tokens, input, output, cacheRead, cacheCreation) => {
    row.tokens += tokens;
    row.input += input;
    row.output += output;
    row.cacheRead += cacheRead;
    row.cacheCreation += cacheCreation;
  };

  for (const record of records) {
    const tokens = Number(record.totalTokens) || 0;
    if (tokens <= 0) continue;
    const input = Number(record.inputTokens) || 0;
    const output = Number(record.outputTokens) || 0;
    const cacheRead = Number(record.cacheReadTokens) || 0;
    const cacheCreation = Number(record.cacheCreationTokens) || 0;
    const source = String(record.source || "unknown");
    const model = normalizeModel(record.model || "unknown");
    const date = record.date;

    bump(totals, tokens, input, output, cacheRead, cacheCreation);

    let sourceRow = sources.get(source);
    if (!sourceRow) {
      sources.set(source, sourceRow = { source, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
    }
    bump(sourceRow, tokens, input, output, cacheRead, cacheCreation);

    const modelKey = source + "\u0000" + model;
    let modelRow = models.get(modelKey);
    if (!modelRow) {
      models.set(modelKey, modelRow = { source, model, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
    }
    bump(modelRow, tokens, input, output, cacheRead, cacheCreation);

    let day = days.get(date);
    if (!day) days.set(date, day = new Map());
    let point = day.get(modelKey);
    if (!point) {
      day.set(modelKey, point = {
        source, model, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0,
      });
    }
    bump(point, tokens, input, output, cacheRead, cacheCreation);
  }

  const dates = [...days.keys()].sort();
  const perModel = new Map();
  for (const row of models.values()) {
    perModel.set(row.model, (perModel.get(row.model) || 0) + row.tokens);
  }
  const top = [...perModel.entries()].sort((a, b) => b[1] - a[1])[0];

  const dateSet = new Set(dates);
  const today = new Date();
  let currentStreak = 0;
  if (dateSet.has(today.toISOString().slice(0, 10))) {
    for (let back = 0; ; back++) {
      const cursor = new Date(today);
      cursor.setDate(cursor.getDate() - back);
      if (!dateSet.has(cursor.toISOString().slice(0, 10))) break;
      currentStreak++;
    }
  }
  let longestStreak = 0;
  let run = 0;
  for (let index = 0; index < dates.length; index++) {
    if (index === 0) {
      run = 1;
    } else {
      const gap = Date.parse(`${dates[index]}T00:00:00Z`) - Date.parse(`${dates[index - 1]}T00:00:00Z`);
      run = gap === DAY_MS ? run + 1 : 1;
    }
    if (run > longestStreak) longestStreak = run;
  }

  let sessions = 0;
  for (const day of days.values()) sessions += day.size;

  return {
    generatedAt: new Date().toISOString(),
    totals,
    sessions,
    activeDays: dates.length,
    topModel: top ? top[0] : "N/A",
    topModelTokens: top ? top[1] : 0,
    firstDate: dates[0] || "",
    lastDate: dates[dates.length - 1] || "",
    currentStreak,
    longestStreak,
    sources: [...sources.values()].sort((a, b) => b.tokens - a.tokens),
    models: [...models.values()].sort((a, b) => b.tokens - a.tokens),
    daily: dates.map((date) => ({
      date,
      points: [...days.get(date).values()].sort((a, b) => b.tokens - a.tokens),
    })),
  };
}

/**
 * Full pipeline: read every source, then collapse to the dashboard payload.
 */
export async function buildDashboard() {
  const { records } = await aggregateAllData();
  return summarizeDashboard(records);
}
