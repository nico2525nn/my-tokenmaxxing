// Shared dashboard engine: pure data helpers with no DOM access.
// Consumed by public/index.html (single-file dashboard).
const COLORS = ['#f59e0b','#10b981','#3b82f6','#ef4444','#8b5cf6','#ec4899','#06b6d4','#84cc16','#f97316','#6366f1','#14b8a6','#eab308'];
const SOURCE_COLORS = ['#94a3b8','#38bdf8','#34d399','#fbbf24','#a78bfa','#fb7185'];
const SOURCE_LABELS = { opencode:'OpenCode', opengrok:'OpenGrok', omp:'OMP', zcode:'ZCode', reasonix:'Reasonix', dsh:'DSH' };
const MODEL_COLORS = {};
let colorIdx = 0;
const SOURCE_COLOR_ASSIGN = {};
let sourceColorIdx = 0;

function getModelColor(m) {
  const key = m || 'unknown';
  if (!MODEL_COLORS[key]) { MODEL_COLORS[key] = COLORS[colorIdx % COLORS.length]; colorIdx++; }
  return MODEL_COLORS[key];
}
function getSourceColor(source) {
  if (!SOURCE_COLOR_ASSIGN[source]) {
    SOURCE_COLOR_ASSIGN[source] = SOURCE_COLORS[sourceColorIdx % SOURCE_COLORS.length];
    sourceColorIdx++;
  }
  return SOURCE_COLOR_ASSIGN[source];
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, function(ch) {
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch];
  });
}
function fmt(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}
function fmtShort(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return Math.round(n / 1e6) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'K';
  return String(Math.round(n));
}
function shortModel(name) {
  const value = name || 'unknown';
  if (value.length > 22) {
    const parts = value.split('/');
    return parts.length > 1 ? parts[parts.length - 1] : value.slice(0, 20) + '…';
  }
  return value;
}
function titleCase(value) {
  return value.replace(/(^|[-_])([a-z])/g, function(_, prefix, letter) { return prefix + letter.toUpperCase(); });
}
function sourceLabel(value) {
  return SOURCE_LABELS[value] || titleCase(value);
}
function dateFromIso(value) {
  const parts = value.split('-').map(Number);
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
}
function isoDate(date) {
  return date.toISOString().slice(0, 10);
}
function addDays(value, amount) {
  const date = dateFromIso(value);
  date.setUTCDate(date.getUTCDate() + amount);
  return isoDate(date);
}
function daySpan(first, last) {
  if (!first || !last) return 0;
  return Math.round((dateFromIso(last) - dateFromIso(first)) / 86400000) + 1;
}
function niceMax(value) {
  if (!value || value <= 0) return 1;
  const padded = value * 1.1;
  const exponent = Math.pow(10, Math.floor(Math.log10(padded)));
  const normalized = padded / exponent;
  const step = normalized <= 1.5 ? .25 : normalized <= 3 ? .5 : normalized <= 7 ? 1 : 2;
  return Math.ceil(padded / (step * exponent)) * step * exponent;
}
// Cache reads are a separate additive bucket in every source, so the hit rate
// is the share of prompt-side tokens served from cache: read / (input + read).
// Returns null when there is no prompt-side traffic to speak of.
function cacheHitRate(input, cacheRead) {
  const promptSide = (Number(input) || 0) + (Number(cacheRead) || 0);
  if (promptSide <= 0) return null;
  return (Number(cacheRead) || 0) / promptSide * 100;
}
function cacheHitText(input, cacheRead) {
  const rate = cacheHitRate(input, cacheRead);
  return rate === null ? '—' : rate.toFixed(1) + '%';
}

const EMPTY_STATS = {totalTokens:0,totalInput:0,totalOutput:0,totalCacheRead:0,totalCacheCreation:0,activeDays:0,sessions:0,topModel:'N/A',topModelTokens:0,currentStreak:0,longestStreak:0,daily:[],modelRows:[],firstDate:'',lastDate:''};

function streakStats(daily) {
  if (!daily.length) return {current:0, longest:0};
  const dateSet = new Set(daily.map(function(day) { return day.date; }));
  const today = new Date();
  let current = 0;
  if (dateSet.has(today.toISOString().slice(0, 10))) {
    for (let back = 0; ; back++) {
      const cursor = new Date(today);
      cursor.setDate(cursor.getDate() - back);
      if (!dateSet.has(cursor.toISOString().slice(0, 10))) break;
      current++;
    }
  }
  let longest = 0;
  let run = 0;
  for (let index = 0; index < daily.length; index++) {
    if (index === 0) run = 1;
    else run = (dateFromIso(daily[index].date) - dateFromIso(daily[index - 1].date)) / 86400000 === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }
  return {current, longest};
}

// DeepSeek Platform 風: 全体統計の期間絞り込み。null は無制限。
// Pure: period/custom are passed in instead of read from globals.
function statsPeriodWindow(days, period, custom) {
  if (period === 'custom') {
    if (custom && custom.from && custom.to && custom.from <= custom.to) {
      return {from:custom.from, to:custom.to};
    }
    return null;
  }
  if (!days || !days.length) return null;
  const span = parseInt(period, 10);
  if (period === 'all' || !isFinite(span) || span <= 0) return null;
  const last = days[days.length - 1].date;
  const first = days[0].date;
  return {from:addDays(last, -(Math.min(span, daySpan(first, last)) - 1)), to:last};
}

// Reduce the server summary to what the current filters show.
function buildView(summary, opts) {
  opts = opts || {};
  const hiddenSources = opts.hiddenSources || new Set();
  if (!summary) return Object.assign({}, EMPTY_STATS, {sourceRows:[]});
  const visible = new Set();
  for (const row of summary.sources || []) {
    if (!hiddenSources.has(row.source)) visible.add(row.source);
  }
  const win = statsPeriodWindow(summary.daily || [], opts.statsPeriod || 'all', opts.statsCustom || {from:'', to:''});
  const inWin = function(date) {
    if (!win || !win.from || !win.to) return true;
    return date >= win.from && date <= win.to;
  };

  const modelMap = new Map();
  const sourceMap = new Map();
  const dailyMap = new Map();
  let totalTokens = 0, totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheCreation = 0;
  let sessions = 0;

  const bump = function(slot, tokens, input, output, cacheRead, cacheCreation) {
    slot.tokens += tokens;
    slot.input += input;
    slot.output += output;
    slot.cacheRead += cacheRead;
    slot.cacheCreation += cacheCreation;
  };

  for (const day of summary.daily || []) {
    if (!inWin(day.date)) continue;
    let dayTotal = 0;
    let byModel = null;
    for (const point of day.points) {
      if (!visible.has(point.source)) continue;
      const tokens = point.tokens || 0;
      if (tokens <= 0) continue;
      const input = point.input || 0;
      const output = point.output || 0;
      const cacheRead = point.cacheRead || 0;
      const cacheCreation = point.cacheCreation || 0;
      sessions++;
      dayTotal += tokens;
      totalTokens += tokens;
      totalInput += input;
      totalOutput += output;
      totalCacheRead += cacheRead;
      totalCacheCreation += cacheCreation;
      if (!byModel) byModel = {};
      byModel[point.model] = (byModel[point.model] || 0) + tokens;
      let slot = modelMap.get(point.model);
      if (!slot) modelMap.set(point.model, slot = {model: point.model, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0});
      bump(slot, tokens, input, output, cacheRead, cacheCreation);
      let srow = sourceMap.get(point.source);
      if (!srow) sourceMap.set(point.source, srow = {source: point.source, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0});
      bump(srow, tokens, input, output, cacheRead, cacheCreation);
    }
    if (dayTotal > 0) dailyMap.set(day.date, {date: day.date, total: dayTotal, byModel: byModel || {}});
  }

  const daily = [...dailyMap.values()].sort(function(a, b) { return a.date.localeCompare(b.date); });
  const modelRows = [...modelMap.values()].sort(function(a, b) { return b.tokens - a.tokens; });
  const sourceRows = (summary.sources || []).map(function(row) {
    return sourceMap.get(row.source) || {source: row.source, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0};
  }).sort(function(a, b) { return b.tokens - a.tokens; });
  const streak = streakStats(daily);
  const stats = Object.assign({}, EMPTY_STATS, {
    totalTokens, totalInput, totalOutput, totalCacheRead, totalCacheCreation,
    activeDays: daily.length,
    sessions,
    daily,
    modelRows,
    sourceRows,
    firstDate: daily.length ? daily[0].date : '',
    lastDate: daily.length ? daily[daily.length - 1].date : '',
    currentStreak: streak.current,
    longestStreak: streak.longest,
  });
  if (modelRows.length) {
    stats.topModel = modelRows[0].model;
    stats.topModelTokens = modelRows[0].tokens;
  }
  return stats;
}

// グラフ用の全期間日別。統計の期間フィルタとは独立で、ハーネス絞り込みのみ反映。
function chartDaily(fullDaily, visible) {
  const out = [];
  for (const day of fullDaily || []) {
    let total = 0;
    const byModel = {};
    for (const point of day.points) {
      if (!visible.has(point.source) || !(point.tokens > 0)) continue;
      total += point.tokens;
      byModel[point.model] = (byModel[point.model] || 0) + point.tokens;
    }
    if (total > 0) out.push({date: day.date, total, byModel});
  }
  return out.sort(function(a, b) { return a.date.localeCompare(b.date); });
}

function chartWindow(daily, range, rangeDays, rangeMinDays) {
  if (!daily.length) return null;
  const first = daily[0].date;
  const last = daily[daily.length - 1].date;
  const span = daySpan(first, last);
  if (range === 'all') return {from:first, to:last, days:span, clamped:false};
  const wanted = Math.min(rangeDays, Math.max(rangeMinDays, span));
  const from = span > wanted ? addDays(last, -(wanted - 1)) : first;
  return {from, to:last, days:daySpan(from, last), clamped:span < rangeDays};
}

function makeCalendarBuckets(daily, from, to) {
  const span = Math.max(0, daySpan(from, to));
  const step = span > 180 ? 7 : span > 90 ? 3 : 1;
  const byDate = new Map(daily.map(function(day) { return [day.date, day]; }));
  const buckets = [];
  for (let offset = 0; offset < span; offset += step) {
    const start = addDays(from, offset);
    const bucket = {date:start, total:0, models:{}};
    for (let index = 0; index < step && offset + index < span; index++) {
      const day = byDate.get(addDays(from, offset + index));
      if (!day) continue;
      bucket.total += day.total;
      for (const model in day.byModel) bucket.models[model] = (bucket.models[model] || 0) + day.byModel[model];
    }
    buckets.push(bucket);
  }
  return {buckets,span,step,from,to};
}

function axisLabel(value, span) {
  const date = dateFromIso(value);
  if (span <= 45) return String(date.getUTCMonth() + 1).padStart(2, '0') + '-' + String(date.getUTCDate()).padStart(2, '0');
  return date.toLocaleDateString('en-US', {month:'short', timeZone:'UTC'});
}
