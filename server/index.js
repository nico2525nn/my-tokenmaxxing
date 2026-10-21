import express from "express";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { spawn } from "child_process";
import { createGzip, createBrotliCompress, constants as zlibConstants } from "zlib";

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

// Dashboard cache.
//
// The aggregation reads hundreds of files and shells out to ccusage (~17s, all
// synchronous), so it runs in a child process and publishes to a cache file.
// Requests are served from memory and never wait on a rebuild: a stale snapshot
// is served immediately while a fresh one is produced in the background.
const CACHE_DIR = join(homedir(), ".cache", "tokenmaxxing");
const CACHE_FILE = join(CACHE_DIR, "dashboard.json");
const WORKER = join(__dirname, "refresh-dashboard.js");
const REFRESH_INTERVAL_MS = Number(process.env.REFRESH_INTERVAL_MS) || 60_000;

let dashboard = null;
let servedAt = 0;
let refreshPromise = null;

function readCache() {
  try {
    const payload = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
    if (!payload || !Array.isArray(payload.daily) || !Array.isArray(payload.models)) return null;
    return payload;
  } catch {
    return null;
  }
}

function refresh() {
  if (refreshPromise) return refreshPromise;
  const startedAt = Date.now();
  refreshPromise = new Promise((resolve) => {
    let stderr = "";
    const child = spawn(process.execPath, [WORKER], { stdio: ["ignore", "inherit", "pipe"], env: process.env });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    const settle = (ok) => {
      refreshPromise = null;
      if (ok) {
        dashboard = readCache() ?? dashboard;
        servedAt = Date.now();
        console.log(`[server] dashboard ready in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
      } else if (stderr.trim()) {
        console.error("[server] refresh failed:", stderr.trim().split("\n").pop());
      }
      resolve(ok);
    };
    child.on("error", (error) => {
      stderr += error.message;
      settle(false);
    });
    child.on("exit", (code) => settle(code === 0));
  });
  return refreshPromise;
}

app.get("/api/dashboard", async (_req, res) => {
  if (!dashboard) {
    const built = await refresh();
    if (!built || !dashboard) {
      return res.status(503).json({ ok: false, error: "dashboard is still building" });
    }
  } else if (Date.now() - servedAt >= REFRESH_INTERVAL_MS) {
    refresh();
  }
  res.json(dashboard);
});

app.get("/api/refresh", async (_req, res) => {
  const ok = await refresh();
  if (!ok || !dashboard) {
    return res.status(503).json({ ok: false, error: "refresh failed" });
  }
  res.json(dashboard);
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
  // Serve the last snapshot immediately; refresh it in the background.
  dashboard = readCache();
  if (dashboard) {
    servedAt = 0;
    console.log(`[server] serving cached snapshot from ${dashboard.generatedAt}`);
  }
  refresh();
});
