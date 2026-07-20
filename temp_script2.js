
const COLORS = ['#f59e0b','#10b981','#3b82f6','#ef4444','#8b5cf6','#ec4899','#06b6d4','#84cc16','#f97316','#6366f1'];
const MODEL_COLORS = {};
let colorIdx = 0;

function normalizeModel(name) {
  let clean = name.replace(/^\[.*?\]\s*/, '').trim();
  clean = clean.replace(/^(openrouter|opencode-zen|opencode|anthropic|google|openai|deepseek|moonshotai|xiaomi|tencent|nemotron|minimax|gemma|nvidia)\/+/g, '');
  if (clean.includes('/') && !clean.includes('-')) {
    const parts = clean.split('/').filter(Boolean);
    clean = parts.join('-');
  }
  return clean;
}

function getModelColor(model) {
  const key = normalizeModel(model);
  if (!MODEL_COLORS[key]) {
    MODEL_COLORS[key] = COLORS[colorIdx % COLORS.length];
    colorIdx++;
  }
  return MODEL_COLORS[key];
}

function formatTokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function shortenModel(name) {
  const clean = name.replace(/^\[.*?\]\s*/, '').trim();
  if (clean.length > 22) {
    const parts = clean.split('/');
    if (parts.length > 1) {
      return parts[parts.length - 1];
    }
    return clean.slice(0, 20) + '\u2026';
  }
  return clean;
}

async function loadData() {
  const app = document.getElementById('app');
  const lastUpdated = document.getElementById('lastUpdated');

  try {
    const res = await fetch('/api/stats');
    if (!res.ok) throw new Error('API error');
    const { stats } = await res.json();
    if (lastUpdated) lastUpdated.textContent = new Date().toLocaleString('ja-JP');
    renderDashboard(app, stats);

    const recRes = await fetch('/api/records');
    if (recRes.ok) {
      const { records } = await recRes.json();
      renderModelBreakdown(records);
      drawMultiChart(stats.daily, records);
    } else {
      drawChart(stats.daily);
    }
  } catch (e) {
    app.innerHTML = `
      <div class="error-box">
        <p>Failed to load token data</p>
        <p style="font-size:.75rem;margin-top:.25rem;color:var(--muted-foreground)">${e.message}</p>
        <button class="retry-btn" onclick="location.reload()">Retry</button>
      </div>`;
  }
}

function renderDashboard(app, stats) {
  const params = new URLSearchParams(location.search);
  const userName = params.get('name') || 'nico2525nn';
  const avatarUrl = params.get('avatar') || 'https://avatars.githubusercontent.com/u/173241093?v=4';

  app.innerHTML = `
    <header class="profile-header">
      <div class="profile-info">
        <img src="${avatarUrl}" alt="avatar" class="avatar" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2256%22 height=%2256%22><rect fill=%22oklch(27%25 .012 270)%22 width=%2256%22 height=%2256%22/><text x=%2228%22 y=%2232%22 text-anchor=%22middle%22 fill=%22oklch(65%25 .012 270)%22 font-size=%2224%22 font-family=%22sans-serif%22>${userName[0].toUpperCase()}</text></svg>'">
        <h1 class="username">${userName}</h1>
      </div>
    </header>

    <div class="stats-grid">
      <div class="stats-inner">
        <div class="stat-card">
          <p class="stat-label">Total Tokens</p>
          <p class="stat-value">${formatTokens(stats.totalTokens)}</p>
        </div>
        <div class="stat-card">
          <p class="stat-label">Sessions</p>
          <p class="stat-value">${stats.sessions}</p>
        </div>
        <div class="stat-card">
          <p class="stat-label">Top Token Model</p>
          <p class="stat-value small" title="${stats.topModel}">${shortenModel(stats.topModel)}</p>
        </div>
        <div class="stat-spacer"></div>
        <div class="stat-card">
          <p class="stat-label">Current Streak</p>
          <p class="stat-value">${stats.currentStreak}</p>
        </div>
        <div class="stat-card">
          <p class="stat-label">Longest Streak</p>
          <p class="stat-value">${stats.longestStreak}</p>
        </div>
        <div class="stat-card">
          <p class="stat-label">Active Days</p>
          <p class="stat-value">${stats.activeDays}</p>
        </div>
        <div class="stat-card">
          <p class="stat-label">Total Input</p>
          <p class="stat-value small">${formatTokens(stats.totalInput)}</p>
        </div>
      </div>

      <div class="chart-section">
        <h2 class="chart-title">Daily Tokens</h2>
        <div class="canvas-wrapper">
          <canvas id="tokenChart"></canvas>
        </div>
        <div class="chart-legend" id="chartLegend"></div>
      </div>
    </div>

    ${stats.sources ? `
    <div class="sources-section">
      <p class="sources-title">Data Sources</p>
      <div class="sources-list">
        ${['claude','codex','opencode','gemini','copilot','omp','zcode','reasonix'].map(s =>
          `<span class="source-badge ${stats.sources.includes(s) ? 'active' : ''}">${s}</span>`
        ).join('')}
      </div>
    </div>` : ''}
  `;
}

function renderModelBreakdown(records) {
  const container = document.getElementById('modelBreakdown');
  if (!container) return;

  const modelTotals = {};
  const modelInput = {};
  const modelOutput = {};

  for (const r of records) {
    const normalized = normalizeModel(r.model);
    const tokens = r.totalTokens || 0;
    modelTotals[normalized] = (modelTotals[normalized] || 0) + tokens;
    const inp = (r.inputTokens || r.input || 0);
    const out = (r.outputTokens || r.output || 0);
    modelInput[normalized] = (modelInput[normalized] || 0) + inp;
    modelOutput[normalized] = (modelOutput[normalized] || 0) + out;
  }

  const sorted = Object.entries(modelTotals).sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((s, [, v]) => s + v, 0);
  if (total === 0) return;

  let html = '<div class="breakdown-bar">';
  sorted.forEach(([model, tokens]) => {
    const pct = (tokens / total * 100).toFixed(1);
    html += `<div class="breakdown-segment" style="width:${pct}%;background:${getModelColor(model)}"></div>`;
  });
  html += '</div>';

  html += '<div class="breakdown-items">';
  sorted.slice(0, 10).forEach(([model, tokens]) => {
    const pct = (tokens / total * 100).toFixed(1);
    const inp = modelInput[model] || 0;
    const out = modelOutput[model] || 0;
    html += `
      <div class="breakdown-item">
        <span class="model-name">
          <span class="dot" style="background:${getModelColor(model)}"></span>
          ${model}
        </span>
        <span class="model-tokens">${formatTokens(tokens)} (${pct}%) \u00b7 in ${formatTokens(inp)} / out ${formatTokens(out)}</span>
      </div>`;
  });
  html += '</div>';

  container.innerHTML = html;
}

function drawMultiChart(daily, records) {
  if (!daily || !daily.length) return;
  const canvas = document.getElementById('tokenChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const modelNames = [...new Set(records.map(r => normalizeModel(r.model)).filter(Boolean))];
  const modelColors = {};
  modelNames.forEach(m => { modelColors[m] = getModelColor(m); });

  const allModels = modelNames;
  const dataPoints = daily.map(d => {
    const point = { date: d.date, total: d.total, models: {} };
    for (const m of allModels) point.models[m] = 0;
    if (d.byModel) {
      for (const [model, tokens] of Object.entries(d.byModel)) {
        const norm = normalizeModel(model);
        if (point.models[norm] !== undefined) point.models[norm] += tokens;
      }
    }
    return point;
  });

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  const w = rect.width || 600;
  const h = Math.min(320, Math.max(200, w * 0.35));

  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx.scale(dpr, dpr);

  const pad = { top: 20, bottom: 30, left: 50, right: 20 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  const maxVal = Math.max(...dataPoints.map(d => d.total), 1);

  const ySteps = 4;
  ctx.font = '11px "Geist Sans", sans-serif';
  ctx.fillStyle = 'oklch(65% .012 270)';
  ctx.textAlign = 'right';

  for (let i = 0; i <= ySteps; i++) {
    const y = pad.top + (plotH / ySteps) * i;
    const val = maxVal - (maxVal / ySteps) * i;
    ctx.fillText(formatTokens(val), pad.left - 8, y + 4);
    ctx.strokeStyle = 'oklch(27% .012 270)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();
  }

  const monthLabels = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const seenMonths = new Set();
  for (let i = 0; i < dataPoints.length; i++) {
    const month = parseInt(dataPoints[i].date.slice(5, 7)) - 1;
    const key = dataPoints[i].date.slice(0, 7);
    if (!seenMonths.has(key) || i === dataPoints.length - 1) {
      seenMonths.add(key);
      const x = pad.left + (i / (dataPoints.length - 1 || 1)) * plotW;
      ctx.textAlign = 'center';
      ctx.fillText(monthLabels[month], x, h - pad.bottom + 18);
    }
  }

  const xPos = i => pad.left + (i / (dataPoints.length - 1 || 1)) * plotW;

  const visibleModels = allModels.filter(m => !hiddenModels.has(m));
  if (visibleModels.length === 0) visibleModels.push(allModels[0]);

  for (const model of visibleModels) {
    const color = modelColors[model];

    let baseLine = [];
    for (let i = 0; i < dataPoints.length; i++) {
      let below = 0;
      for (const m of visibleModels) {
        if (m === model) break;
        below += dataPoints[i].models[m] || 0;
      }
      baseLine.push(below);
    }

    ctx.beginPath();
    for (let i = 0; i < dataPoints.length; i++) {
      const y = pad.top + plotH - ((baseLine[i] + (dataPoints[i].models[model] || 0)) / maxVal) * plotH;
      const x = xPos(i);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    for (let i = dataPoints.length - 1; i >= 0; i--) {
      const y = pad.top + plotH - (baseLine[i] / maxVal) * plotH;
      ctx.lineTo(xPos(i), y);
    }
    ctx.closePath();

    const grad = ctx.createLinearGradient(0, pad.top, 0, h - pad.bottom);
    grad.addColorStop(0, color + '40');
    grad.addColorStop(1, color + '05');
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < dataPoints.length; i++) {
      const y = pad.top + plotH - ((baseLine[i] + (dataPoints[i].models[model] || 0)) / maxVal) * plotH;
      const x = xPos(i);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  const legend = document.getElementById('chartLegend');
  if (legend) {
    legend.innerHTML = visibleModels.map((m, i) => `
      <span class="legend-item" data-model="${m}" onclick="toggleModel('${m}')">
        <span class="legend-dot" style="background:${modelColors[m]}"></span>
        ${shortenModel(m)}
      </span>
    `).join('');
  }
}

const hiddenModels = new Set();

function toggleModel(model) {
  if (hiddenModels.has(model)) {
    hiddenModels.delete(model);
  } else {
    hiddenModels.add(model);
  }
  fetch('/api/stats').then(r => r.json()).then(({ stats }) => {
    fetch('/api/records').then(r => r.json()).then(({ records }) => {
      drawMultiChart(stats.daily, records);
    });
  });
}

function drawChart(daily) {
  if (!daily || !daily.length) return;
  const canvas = document.getElementById('tokenChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  const w = rect.width || 600;
  const h = Math.min(320, Math.max(200, w * 0.35));

  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx.scale(dpr, dpr);

  const pad = { top: 20, bottom: 30, left: 50, right: 20 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  const values = daily.map(d => d.total);
  const maxVal = Math.max(...values, 1);

  const ySteps = 4;
  ctx.font = '11px "Geist Sans", sans-serif';
  ctx.fillStyle = 'oklch(65% .012 270)';
  ctx.textAlign = 'right';

  for (let i = 0; i <= ySteps; i++) {
    const y = pad.top + (plotH / ySteps) * i;
    const val = maxVal - (maxVal / ySteps) * i;
    ctx.fillText(formatTokens(val), pad.left - 8, y + 4);
    ctx.strokeStyle = 'oklch(27% .012 270)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();
  }

  const monthLabels = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const seenMonths = new Set();
  for (let i = 0; i < daily.length; i++) {
    const month = parseInt(daily[i].date.slice(5, 7)) - 1;
    const key = daily[i].date.slice(0, 7);
    if (!seenMonths.has(key) || i === daily.length - 1) {
      seenMonths.add(key);
      const x = pad.left + (i / (daily.length - 1 || 1)) * plotW;
      ctx.textAlign = 'center';
      ctx.fillText(monthLabels[month], x, h - pad.bottom + 18);
    }
  }

  const gradient = ctx.createLinearGradient(0, pad.top, 0, h - pad.bottom);
  gradient.addColorStop(0, 'oklch(72% .18 45 / 0.25)');
  gradient.addColorStop(1, 'oklch(72% .18 45 / 0.02)');
  ctx.beginPath();
  for (let i = 0; i < daily.length; i++) {
    const x = pad.left + (i / (daily.length - 1 || 1)) * plotW;
    const y = pad.top + plotH - (values[i] / maxVal) * plotH;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.lineTo(pad.left + plotW, h - pad.bottom);
  ctx.lineTo(pad.left, h - pad.bottom);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();
  for (let i = 0; i < daily.length; i++) {
    const x = pad.left + (i / (daily.length - 1 || 1)) * plotW;
    const y = pad.top + plotH - (values[i] / maxVal) * plotH;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.strokeStyle = 'oklch(72% .18 45)';
  ctx.lineWidth = 2;
  ctx.stroke();

  if (daily.length <= 60) {
    for (let i = 0; i < daily.length; i++) {
      const x = pad.left + (i / (daily.length - 1 || 1)) * plotW;
      const y = pad.top + plotH - (values[i] / maxVal) * plotH;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = 'oklch(72% .18 45)';
      ctx.fill();
    }
  }

  const legend = document.getElementById('chartLegend');
  if (legend) {
    legend.innerHTML = `
      <span class="legend-item">
        <span class="legend-dot" style="background:oklch(72% .18 45)"></span>
        Total Tokens
      </span>
      <span class="legend-item">
        <span style="color:var(--muted-foreground)">${formatTokens(values.reduce((a, b) => a + b, 0))} total</span>
      </span>`;
  }
}

loadData();
setInterval(loadData, 60000);

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const statsEl = document.querySelector('.stat-value');
    if (statsEl) loadData();
  }, 500);
});
