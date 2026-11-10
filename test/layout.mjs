#!/usr/bin/env node
// Layout overflow test.
//
// Overflow bugs here have never been loud: a calendar clipped at the right edge,
// a table wider than the phone, a label cut mid-date. None of them throw or fail
// a data assertion, so they only get noticed by looking. This drives a real
// headless Chrome over every viewport we care about and fails when any element
// paints outside it.
//
// Elements inside a scroll container are allowed to exceed the viewport: that is
// what the container is for. The containers themselves are not.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WIDTHS = [320, 360, 390, 428, 640, 768, 1024, 1280, 1440];
const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const APP_PORT = 3820 + Math.floor(Math.random() * 40);
const DEBUG_PORT = 9420 + Math.floor(Math.random() * 40);
const BASE = `http://127.0.0.1:${APP_PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const child = spawn("./tokenmaxxing", ["-port", String(APP_PORT), "-public", "public"], {
    stdio: ["ignore", "ignore", "inherit"],
    detached: false,
  });
  return child;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(`${BASE}/api/dashboard`);
      if (response.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error("server did not become ready");
}

function startChrome(profile) {
  return spawn(
    CHROME,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--hide-scrollbars",
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
}

async function connect() {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      const page = list.find((entry) => entry.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error("devtools endpoint unavailable");
}

// Elements whose layout is intentionally wider than the viewport live inside one
// of these, and are clipped by it.
const PROBE = `(() => {
  const vw = window.innerWidth;
  const scrollers = (el) => {
    const overflow = getComputedStyle(el).overflowX;
    return overflow === "auto" || overflow === "scroll" || overflow === "hidden";
  };
  const clippedByAncestor = (el) => {
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      if (scrollers(parent)) return true;
    }
    return false;
  };
  const describe = (el) => {
    const cls = typeof el.className === "string" ? el.className.trim().split(/\\s+/).slice(0, 2).join(".") : "";
    return el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (cls ? "." + cls : "");
  };
  const offenders = [];
  for (const el of document.querySelectorAll("body *")) {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
    if (el.closest(".sr-only")) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const outside = rect.right > vw + 1 || rect.left < -1;
    if (!outside) continue;
    // Anything inside a scroll/clip container is supposed to be wider than it.
    if (clippedByAncestor(el)) continue;
    offenders.push({ el: describe(el), left: Math.round(rect.left), right: Math.round(rect.right) });
  }
  const doc = document.documentElement;
  return {
    vw,
    docOverflow: doc.scrollWidth > doc.clientWidth + 1,
    scrollWidth: doc.scrollWidth,
    offenders: offenders.slice(0, 6),
    count: offenders.length,
  };
})()`;

async function main() {
  const profile = mkdtempSync(join(tmpdir(), "tmx-layout-"));
  const server = startServer();
  let chrome;
  try {
    await waitForServer();
    chrome = startChrome(profile);
    const wsUrl = await connect();

    const ws = new WebSocket(wsUrl);
    await new Promise((resolve) => { ws.onopen = resolve; });
    let id = 0;
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const current = ++id;
      ws.send(JSON.stringify({ id: current, method, params }));
      const onMessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== current) return;
        ws.removeEventListener("message", onMessage);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      };
      ws.addEventListener("message", onMessage);
    });

    const evaluate = async (expression) => {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      return result.result.value;
    };

    const failures = [];
    for (const width of WIDTHS) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 900,
        deviceScaleFactor: 2,
        mobile: width <= 640,
      });
      await send("Page.navigate", { url: `${BASE}/?w=${width}` });

      // Wait for the dashboard to render rather than for a fixed delay.
      let ready = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        ready = await evaluate("!!document.querySelector('#kpiGrid .card')");
        if (ready) break;
        await sleep(250);
      }
      if (!ready) {
        failures.push({ width, state: "load", detail: "dashboard never rendered" });
        continue;
      }

      const states = [
        ["dashboard", "closeCustomPopover(); document.getElementById('dialogRoot').innerHTML = ''; true"],
        ["custom calendar", `(() => {
          document.querySelector('#statsRangeGroup [data-period="custom"]').click();
          const input = document.getElementById('customFrom');
          input.dispatchEvent(new FocusEvent('focus'));
          return true;
        })()`],
        ["profile dialog", "showEdit(); document.getElementById('editDialog') !== null"],
        ["harness tab", `(() => {
          closeCustomPopover();
          document.querySelector('#breakTabs [data-tab="harness"]').click();
          return true;
        })()`],
      ];

      for (const [state, setup] of states) {
        await evaluate(setup);
        await sleep(150);
        const probe = await evaluate(PROBE);
        if (probe.docOverflow || probe.count > 0) {
          failures.push({ width, state, detail: probe });
        }
      }
    }

    ws.close();

    if (failures.length) {
      console.error(`layout overflow: ${failures.length} failure(s)`);
      for (const failure of failures) {
        const detail = failure.detail;
        if (typeof detail === "string") {
          console.error(`  ${failure.width}px ${failure.state}: ${detail}`);
          continue;
        }
        console.error(`  ${failure.width}px ${failure.state}: scrollWidth ${detail.scrollWidth} > ${detail.vw}, ${detail.count} element(s)`);
        for (const offender of detail.offenders) {
          console.error(`    ${offender.el} [${offender.left}, ${offender.right}]`);
        }
      }
      process.exitCode = 1;
      return;
    }
    console.log(`layout overflow: none at ${WIDTHS.join(", ")}px across 4 states`);
  } finally {
    chrome?.kill("SIGKILL");
    server.kill("SIGKILL");
    await sleep(200);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error("layout test failed:", error.message);
  process.exitCode = 1;
});
