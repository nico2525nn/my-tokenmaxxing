import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { summarizeDashboard } from "../server/data-fetcher.js";
import { localIsoDate, aggregateTuples, tuplesToRecords } from "../server/readers.js";

function loadTmx() {
  const src = readFileSync(new URL("../public/tmx.js", import.meta.url), "utf-8");
  const factory = new Function(`${src}; return {buildView, statsPeriodWindow, streakStats, cacheHitText, EMPTY_STATS};`);
  return factory();
}

const { buildView, statsPeriodWindow, streakStats, cacheHitText, EMPTY_STATS } = loadTmx();

function point(date, source, model, tokens, extra = {}) {
  return { source, model, tokens, input: tokens, output: 0, cacheRead: 0, cacheCreation: 0, ...extra };
}

test("summarizeDashboard counts records, not sessions", () => {
  const records = [
    { date: "2026-10-27", source: "a", model: "m1", inputTokens: 60, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 60 },
    { date: "2026-10-27", source: "a", model: "m2", inputTokens: 30, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 30 },
    { date: "2026-10-28", source: "a", model: "m1", inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 10 },
  ];
  const payload = summarizeDashboard(records);
  assert.equal(payload.records, 3);
  assert.equal(payload.activeDays, 2);
  assert.equal(payload.totals.tokens, 100);
  assert.equal(payload.topModel, "m1");
  assert.equal(payload.topModelTokens, 70);
  assert.equal("sessions" in payload, false);
});

test("summarizeDashboard skips zero-token records", () => {
  const payload = summarizeDashboard([
    { date: "2026-10-28", source: "a", model: "m", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0 },
  ]);
  assert.equal(payload.records, 0);
  assert.equal(payload.activeDays, 0);
  assert.equal(payload.topModel, "N/A");
});

test("buildView excludes hidden models from every aggregate", () => {
  const summary = {
    sources: [{ source: "a" }],
    daily: [{ date: "2026-10-28", points: [point("2026-10-28", "a", "m1", 90), point("2026-10-28", "a", "m2", 10)] }],
  };
  const view = buildView(summary, { hiddenSources: new Set(), hiddenModels: new Set(["m1"]), statsPeriod: "all", statsCustom: { from: "", to: "" } });
  assert.equal(view.totalTokens, 10);
  assert.equal(view.topModel, "m2");
  assert.equal(view.topModelTokens, 10);
  assert.deepEqual(view.modelRows.map((r) => [r.model, r.tokens]), [["m2", 10], ["m1", 0]]);
});

test("buildView with everything hidden is a clean empty state", () => {
  const summary = {
    sources: [{ source: "a" }],
    daily: [{ date: "2026-10-28", points: [point("2026-10-28", "a", "m1", 90)] }],
  };
  const view = buildView(summary, { hiddenSources: new Set(), hiddenModels: new Set(["m1"]), statsPeriod: "all", statsCustom: { from: "", to: "" } });
  assert.equal(view.totalTokens, 0);
  assert.equal(view.topModel, "N/A");
  assert.equal(view.activeDays, 0);
});

test("buildView omits hidden sources from source rows", () => {
  const summary = {
    sources: [{ source: "a" }, { source: "b" }],
    daily: [{ date: "2026-10-28", points: [point("2026-10-28", "a", "m1", 50), point("2026-10-28", "b", "m1", 50)] }],
  };
  const view = buildView(summary, { hiddenSources: new Set(["b"]), hiddenModels: new Set(), statsPeriod: "all", statsCustom: { from: "", to: "" } });
  assert.equal(view.totalTokens, 50);
  assert.deepEqual(view.sourceRows.map((r) => [r.source, r.tokens]), [["a", 50], ["b", 0]]);
});

test("statsPeriodWindow anchors presets to the last recorded day", () => {
  const days = [{ date: "2026-10-20" }, { date: "2026-10-28" }];
  assert.deepEqual(statsPeriodWindow(days, "7", { from: "", to: "" }), { from: "2026-10-22", to: "2026-10-28" });
  assert.equal(statsPeriodWindow(days, "all", { from: "", to: "" }), null);
  assert.deepEqual(statsPeriodWindow(days, "custom", { from: "2026-10-01", to: "2026-10-02" }), { from: "2026-10-01", to: "2026-10-02" });
});

test("streakStats handles empty and gapped histories", () => {
  assert.deepEqual(streakStats([]), { current: 0, longest: 0 });
  assert.equal(streakStats([{ date: "2026-10-26" }, { date: "2026-10-28" }]).longest, 1);
  assert.equal(streakStats([{ date: "2026-10-26" }, { date: "2026-10-27" }]).longest, 2);
});

test("cacheHitText reports prompt-side share", () => {
  assert.equal(cacheHitText(25, 75), "75.0%");
  assert.equal(cacheHitText(0, 0), "—");
});

test("EMPTY_STATS exposes records instead of sessions", () => {
  assert.equal(EMPTY_STATS.records, 0);
  assert.equal("sessions" in EMPTY_STATS, false);
});

test("localIsoDate buckets on the viewer's calendar day", () => {
  // 2026-01-01T15:30Z is still 01-01 in UTC but already 01-02 in JST.
  const utc = new Date("2026-01-01T15:30:00Z");
  const expected = `${utc.getFullYear()}-${String(utc.getMonth() + 1).padStart(2, "0")}-${String(utc.getDate()).padStart(2, "0")}`;
  assert.equal(localIsoDate(utc), expected);
  assert.equal(localIsoDate(""), "");
});

test("isoDate stays local while addDays keeps UTC date math", () => {
  const src = readFileSync(new URL("../public/tmx.js", import.meta.url), "utf-8");
  const fn = new Function(`${src}; return {isoDate, addDays};`)();
  const local = new Date(2026, 0, 2, 0, 30);
  assert.equal(fn.isoDate(local), "2026-01-02");
  assert.equal(fn.addDays("2026-01-31", 1), "2026-02-01");
  assert.equal(fn.addDays("2026-03-01", -1), "2026-02-28");
});

test("aggregateTuples collapses per-file rows by date and model", () => {
  const tuples = aggregateTuples([
    { period: "2026-10-28", modelName: "m1", inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 11 },
    { period: "2026-10-28", modelName: "m1", inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 7 },
    { period: "2026-10-28", modelName: "m2", inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 1 },
  ]);
  assert.equal(tuples.length, 2);
  const m1 = tuples.find((t) => t[1] === "m1");
  assert.deepEqual(m1.slice(2), [15, 3, 0, 0, 18]);
});

test("tuplesToRecords emits the pipeline record shape", () => {
  const records = tuplesToRecords([["2026-10-28", "m1", 10, 2, 3, 4, 19]], "codex");
  assert.deepEqual(records, [{
    date: "2026-10-28", source: "codex", model: "m1",
    inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4, totalTokens: 19,
  }]);
});
