#!/usr/bin/env node
// Layout overflow test.
//
// Overflow bugs here have never been loud: a calendar clipped at the right edge,
// a table wider than the phone, a label cut mid-date. None of them throw or fail
// a data assertion, so they only get noticed by looking. This drives a real
// headless Chrome over every viewport and UI state we care about and fails when
// any element paints outside it.
//
// Everything under <body> is checked, including nested children. Elements inside
// a scroll or clip container are allowed to exceed the viewport: that is what the
// container is for. The container itself is not.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WIDTHS = [320, 360, 390, 428, 640, 768, 1024, 1280, 1440];
const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const APP_PORT = 3820 + Math.floor(Math.random() * 40);
const DEBUG_PORT = 9420 + Math.floor(Math.random() * 40);
const BASE = `http://127.0.0.1:${APP_PORT}`;

// Blocks that must be present and populated. A renamed class would otherwise
// leave the probe checking nothing and still pass.
const BLOCKS = {
  ".topbar": 1,
  ".brand": 1,
  ".topbar-right": 1,
  ".page-head": 1,
  ".period-picker": 1,
  "#statsRangeGroup": 1,
  "#kpiGrid .card": 4,
  ".chart-card": 1,
  ".chart-canvas": 1,
  ".chart-key": 1,
  "#chartLegend button": 1,
  "#breakTabs button": 2,
  ".table-scroll": 1,
  ".data-table": 1,
  ".data-table tbody tr": 1,
  ".data-table td": 4,
  ".site-footer": 1,
};

// Each state exercises a different layout path: overlays, menus, and the
// collapsed/hidden variants that shrink or grow the grid.
const STATES = [
  ["dashboard", "true"],
  ["custom calendar", `(() => {
    document.querySelector('#statsRangeGroup [data-period="custom"]').click();
    document.getElementById('customFrom').dispatchEvent(new FocusEvent('focus'));
    return true;
  })()`],
  ["profile dialog", "showEdit(); true"],
  ["avatar menu", "toggleAvatarMenu(false); document.getElementById('avatarBtn').click(); true"],
  ["chart tooltip", `(() => {
    const canvas = document.getElementById('tokenChart');
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new MouseEvent('click', {clientX: rect.left + rect.width / 2, bubbles: true}));
    return true;
  })()`],
  ["hidden model row", `(() => {
    const row = document.querySelector('tr[data-model]');
    if (row) row.click();
    return true;
  })()`],
  ["harness tab", `(() => {
    document.querySelector('#breakTabs [data-tab="harness"]').click();
    return true;
  })()`],
  ["all-time preset", `(() => {
    document.querySelector('#breakTabs [data-tab="models"]').click();
    document.querySelector('#statsRangeGroup [data-period="all"]').click();
    return true;
  })()`],
];

const RESET = `(() => {
  closeCustomPopover();
  document.getElementById('dialogRoot').innerHTML = '';
  toggleAvatarMenu(false);
  hideChartTip();
  [...document.querySelectorAll('tr[data-model].off')].forEach(tr => tr.click());
  return true;
})()`;

const PROBE = `(() => {
  const vw = window.innerWidth;
  const scrolls = (el) => {
    const overflow = getComputedStyle(el).overflowX;
    return overflow === "auto" || overflow === "scroll" || overflow === "hidden";
  };
  const clippedByAncestor = (el) => {
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      if (scrolls(parent)) return true;
    }
    return false;
  };
  const describe = (el) => {
    const cls = typeof el.className === "string" ? el.className.trim().split(/\\s+/).slice(0, 2).join(".") : "";
    return el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (cls ? "." + cls : "");
  };
  const offenders = [];
  let probed = 0;
  for (const el of document.querySelectorAll("body *")) {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
    if (el.closest(".sr-only")) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    probed++;
    const outside = rect.right > vw + 1 || rect.left < -1;
    if (!outside) continue;
    if (clippedByAncestor(el)) continue;
    offenders.push({ el: describe(el), left: Math.round(rect.left), right: Math.round(rect.right) });
  }
  const coverage = {};
  for (const selector of ${JSON.stringify(Object.keys(BLOCKS))}) {
    coverage[selector] = document.querySelectorAll(selector).length;
  }
  const doc = document.documentElement;
  return {
    vw,
    docOverflow: doc.scrollWidth > doc.clientWidth + 1,
    scrollWidth: doc.scrollWidth,
    clientWidth: doc.clientWidth,
    probed,
    coverage,
    offenders: offenders.slice(0, 6),
    count: offenders.length,
  };
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  return spawn("./tokenmaxxing", ["-port", String(APP_PORT), "-public", "public"], {
    stdio: ["ignore", "ignore", "inherit"],
  });
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

async function main() {
  const profile = mkdtempSync(join(tmpdir(), "tmx-layout-"));
  const server = startServer();
  let chrome;
  try {
    await waitForServer();
    chrome = startChrome(profile);
    const ws = new WebSocket(await connect());
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
    let checks = 0;
    let probed = 0;

    for (const width of WIDTHS) {
      await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 2, mobile: width <= 640 });
      await send("Page.navigate", { url: `${BASE}/?w=${width}` });
      await evaluate("localStorage.clear()");
      await send("Page.navigate", { url: `${BASE}/?w=${width}` });

      // Wait for real content: the skeleton already renders `.card`s inside
      // #kpiGrid, so that selector alone would pass before any data arrives.
      let ready = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        ready = await evaluate("!!document.querySelector('#kpiGrid .stat-num')");
        if (ready) break;
        await sleep(250);
      }
      if (!ready) {
        failures.push({ width, state: "load", message: "dashboard never rendered" });
        continue;
      }

      // Guard the guard: every block must exist with at least the expected count.
      const coverage = await evaluate(PROBE).then((probe) => probe.coverage);
      for (const [selector, minimum] of Object.entries(BLOCKS)) {
        if ((coverage[selector] || 0) < minimum) {
          failures.push({ width, state: "coverage", message: `${selector}: ${coverage[selector] || 0} < ${minimum}` });
        }
      }

      for (const [state, setup] of STATES) {
        await evaluate(RESET);
        await evaluate(setup);
        await sleep(200);
        const probe = await evaluate(PROBE);
        checks++;
        probed += probe.probed;
        if (probe.docOverflow || probe.count > 0) {
          failures.push({ width, state, probe });
        }
      }
    }

    ws.close();

    if (failures.length) {
      console.error(`layout overflow: ${failures.length} failure(s)`);
      for (const failure of failures) {
        if (failure.message) {
          console.error(`  ${failure.width}px ${failure.state}: ${failure.message}`);
          continue;
        }
        const probe = failure.probe;
        console.error(`  ${failure.width}px ${failure.state}: document ${probe.scrollWidth}px wide in a ${probe.clientWidth}px box, ${probe.count} element(s) outside`);
        for (const offender of probe.offenders) {
          console.error(`    ${offender.el} [${offender.left}, ${offender.right}]`);
        }
      }
      process.exitCode = 1;
      return;
    }
    console.log(
      `layout overflow: none — ${WIDTHS.length} widths × ${STATES.length} states, ` +
      `${checks} checks, ${probed} elements probed, ${Object.keys(BLOCKS).length} blocks asserted`,
    );
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
