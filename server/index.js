import express from "express";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { aggregateAllData } from "./data-fetcher.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3642;
const app = express();

// Cache
let cachedData = null;
let lastFetch = 0;
const CACHE_TTL = 60_000;

async function getData() {
  const now = Date.now();
  if (!cachedData || now - lastFetch > CACHE_TTL) {
    console.log("[server] Fetching fresh data...");
    cachedData = await aggregateAllData();
    lastFetch = now;
    console.log(`[server] Data ready: ${cachedData.records.length} records, ${(cachedData.stats.totalTokens / 1e6).toFixed(1)}M tokens`);
  }
  return cachedData;
}

app.get("/api/stats", async (_req, res) => {
  try {
    const { stats } = await getData();
    res.json({ ok: true, stats });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/records", async (_req, res) => {
  try {
    const { records } = await getData();
    res.json({ ok: true, records });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/refresh", async (_req, res) => {
  cachedData = null;
  lastFetch = 0;
  try {
    const { stats } = await getData();
    res.json({ ok: true, stats });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Serve static frontend
const publicDir = join(__dirname, "..", "public");
app.use(express.static(publicDir));

// SPA fallback
app.get("*", (_req, res) => {
  const indexPath = join(publicDir, "index.html");
  if (existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).json({ error: "not found" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[server] TokenMaxxing Dashboard running at http://localhost:${PORT}`);
  // Warm up cache
  setTimeout(async () => {
    try { await getData(); } catch {}
  }, 500);
});
