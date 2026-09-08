import { execSync } from "child_process";
import { readFileSync, readdirSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const HOME = homedir();
const CCUSAGE_CMD = process.platform === "win32"
  ? `npx -y ccusage@^20`
  : `bunx ccusage@^20`;

// Try to use bun:sqlite (available in Bun runtime)
let BUN_SQLITE = null;
try {
  BUN_SQLITE = await import("bun:sqlite");
} catch {
  // Not in Bun runtime, try child_process fallback
}

/**
 * Fetch data from ccusage CLI for external tools
 */
function fetchFromCcusage() {
  console.log("[fetcher] Fetching from ccusage...");
  try {
    const stdout = execSync(`${CCUSAGE_CMD} daily --json --breakdown --no-cost --by-agent`, {
      timeout: 120_000,
      maxBuffer: 256 * 1024 * 1024,
      shell: process.platform === "win32" ? "cmd.exe" : true,
      encoding: "utf-8",
    });
    const data = JSON.parse(stdout);
    console.log(`[fetcher] ccusage: ${data.daily?.length || 0} days`);
    return data.daily || [];
  } catch (e) {
    console.error("[fetcher] ccusage failed:", e.message);
    return [];
  }
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
 * Read OpenCode2 session data from the shared opencode SQLite DB.
 * OpenCode2 (beta, `opencode2` binary) stores sessions in session_v2.
 */
async function fetchFromOpenCode2() {
  console.log("[fetcher] Fetching from OpenCode2...");
  const dbPath = join(HOME, ".local", "share", "opencode", "opencode.db");
  if (!existsSync(dbPath)) {
    console.log("[fetcher] OpenCode2 db not found");
    return [];
  }

  let db = null;
  try {
    if (!BUN_SQLITE) return [];
    const { Database } = BUN_SQLITE;
    db = new Database(dbPath, { readonly: true });
    const rows = db.query(`
      SELECT time_created, model, tokens_input, tokens_output,
             tokens_reasoning, tokens_cache_read, tokens_cache_write
      FROM session_v2
      WHERE tokens_input IS NOT NULL OR tokens_output IS NOT NULL
            OR tokens_cache_read IS NOT NULL OR tokens_cache_write IS NOT NULL
    `).all();

    const results = [];
    for (const r of rows) {
      const rawTime = Number(r.time_created);
      const timeMs = Number.isFinite(rawTime) ? (rawTime < 1e12 ? rawTime * 1000 : rawTime) : Date.parse(r.time_created);
      const createdAt = new Date(timeMs);
      if (Number.isNaN(createdAt.getTime())) continue;
      const date = createdAt.toISOString().slice(0, 10);
      if (date === "1970-01-01") continue;
      let model = "unknown";
      try {
        const parsed = JSON.parse(r.model || "{}");
        if (parsed && typeof parsed.id === "string") model = parsed.id;
        else if (typeof r.model === "string") model = r.model;
      } catch {
        if (typeof r.model === "string") model = r.model;
      }
      const input = Number(r.tokens_input) || 0;
      const output = Number(r.tokens_output) || 0;
      const reasoning = Number(r.tokens_reasoning) || 0;
      const cacheRead = Number(r.tokens_cache_read) || 0;
      const cacheWrite = Number(r.tokens_cache_write) || 0;
      if (input + output + reasoning + cacheRead + cacheWrite === 0) continue;
      results.push({
        period: date,
        agent: "opencode2",
        modelName: normalizeModel(model),
        inputTokens: input,
        outputTokens: output + reasoning,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheWrite,
        totalTokens: input + output + reasoning + cacheRead + cacheWrite,
      });
    }
    console.log(`[fetcher] OpenCode2: ${results.length} sessions`);
    return results;
  } catch (e) {
    console.error("[fetcher] OpenCode2 failed:", e.message);
    return [];
  } finally {
    db?.close();
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
  const opencode2Entries = await fetchFromOpenCode2();
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
  // Add OpenCode2 entries
  for (const e of opencode2Entries) {
    allRecords.push({
      date: e.period,
      source: "opencode2",
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

  const stats = computeStats(records);
  return { records, stats };
}

function computeStats(records) {
  if (!records.length) return emptyStats();

  const totalTokens = records.reduce((s, r) => s + r.totalTokens, 0);
  const totalInput = records.reduce((s, r) => s + r.inputTokens, 0);
  const totalOutput = records.reduce((s, r) => s + r.outputTokens, 0);
  const totalCacheRead = records.reduce((s, r) => s + r.cacheReadTokens, 0);
  const totalCacheCreation = records.reduce((s, r) => s + r.cacheCreationTokens, 0);

  const dates = [...new Set(records.map(r => r.date))].sort();
  const dateSet = new Set(dates);
  const activeDays = dates.length;

  // Sessions: count distinct (date, source) combos
  const sessionSet = new Set(records.map(r => `${r.date}|${r.source}|${r.model}`));
  const sessions = sessionSet.size;
  const modelTotals = {};
  for (const r of records) {
    const key = normalizeModel(r.model || "unknown");
    modelTotals[key] = (modelTotals[key] || 0) + r.totalTokens;
  }
  const sortedModels = Object.entries(modelTotals).sort((a, b) => b[1] - a[1]);
  const topModel = sortedModels[0];

  // Streaks
  let currentStreak = 0;
  let longestStreak = 0;
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  // Current streak: only count a run that includes today.
  if (dateSet.has(todayStr)) {
    for (let i = 0; ; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dStr = d.toISOString().slice(0, 10);
      if (dateSet.has(dStr)) currentStreak++;
      else break;
    }
  }

  // Longest streak
  let current = 0;
  for (let i = 0; i < dates.length; i++) {
    if (i === 0) {
      current = 1;
    } else {
      const prev = new Date(dates[i - 1]);
      const curr = new Date(dates[i]);
      const diffDays = (curr - prev) / (1000 * 60 * 60 * 24);
      if (diffDays === 1) {
        current++;
      } else {
        current = 1;
      }
    }
    longestStreak = Math.max(longestStreak, current);
  }

  const sources = [...new Set(records.map(r => r.source))];

  const dailyMap = {};
  for (const r of records) {
    if (!dailyMap[r.date]) dailyMap[r.date] = { date: r.date, total: 0, byModel: {} };
    dailyMap[r.date].total += r.totalTokens;
    const model = normalizeModel(r.model || "unknown");
    dailyMap[r.date].byModel[model] = (dailyMap[r.date].byModel[model] || 0) + r.totalTokens;
  }
  const daily = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

  return {
    totalTokens,
    totalInput,
    totalOutput,
    totalCacheRead,
    totalCacheCreation,
    activeDays,
    sessions,
    topModel: topModel?.[0] || "N/A",
    topModelTokens: topModel?.[1] || 0,
    currentStreak,
    longestStreak,
    sources,
    daily,
    firstDate: dates[0] || "",
    lastDate: dates[dates.length - 1] || "",
  };
}

function emptyStats() {
  return {
    totalTokens: 0, totalInput: 0, totalOutput: 0,
    totalCacheRead: 0, totalCacheCreation: 0,
    activeDays: 0, sessions: 0,
    topModel: "N/A", topModelTokens: 0,
    currentStreak: 0, longestStreak: 0,
    sources: [], daily: [],
    firstDate: "", lastDate: "",
  };
}
