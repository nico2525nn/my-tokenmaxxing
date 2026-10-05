import express from "express";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { createGzip, createBrotliCompress, constants as zlibConstants } from "zlib";
import { aggregateAllData } from "./data-fetcher.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3642;
const app = express();

app.disable("etag");

// The records payload is tens of thousands of repetitive JSON rows and gzips
// roughly 12x smaller. Remote clients (a phone on the tailnet, say) otherwise
// pull megabytes on every refresh and the transfer can die part-way, which the
// page surfaces as "Failed to load token data".
const COMPRESS_MIN_BYTES = 1024;

app.use((req, res, next) => {
  const accept = String(req.headers["accept-encoding"] || "");
  const encoding = /\bbr\b/.test(accept) ? "br" : /\bgzip\b/.test(accept) ? "gzip" : null;
  if (!encoding) return next();

  const originalJson = res.json.bind(res);
  const makeStream = () => encoding === "br"
    ? createBrotliCompress({
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
          [zlibConstants.BROTLI_PARAM_SIZE_HINT]: 1 << 20,
        },
      })
    : createGzip({ level: 6 });

  // Pipe into the response instead of res.send(stream): Express routes objects
  // back through res.json, so handing it a stream re-enters this override and
  // recurses until the stack blows.
  res.json = (body) => {
    const payload = JSON.stringify(body);
    if (Buffer.byteLength(payload) < COMPRESS_MIN_BYTES) return originalJson(body);
    const stream = makeStream();
    stream.on("error", () => res.destroy());
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Encoding", encoding);
    res.setHeader("Vary", "Accept-Encoding");
    res.removeHeader("Content-Length");
    stream.pipe(res);
    stream.end(payload);
    return res;
  };
  next();
});
app.use((_req, res, next) => {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
  });
  next();
});

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

// Serve static frontend (no caching so edits always show on reload)
const publicDir = join(__dirname, "..", "public");
app.use(express.static(publicDir, {
  etag: false,
  lastModified: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.set("Cache-Control", "no-store");
  },
}));

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
