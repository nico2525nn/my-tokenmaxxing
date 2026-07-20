
const COLORS = ['#f59e0b','#10b981','#3b82f6','#ef4444','#8b5cf6','#ec4899','#06b6d4','#84cc16','#f97316','#6366f1'];
const MODEL_COLORS = {};
let colorIdx = 0;
let userName = 'nico2525nn';
let avatarUrl = 'https://avatars.githubusercontent.com/u/173241093?v=4';

// Load saved profile from localStorage
try {
  const saved = JSON.parse(localStorage.getItem('tmx_profile') || '{}');
  if (saved.name) userName = saved.name;
  if (saved.avatar) avatarUrl = saved.avatar;
} catch {}

function normalizeModel(name) {
  let clean = (name || '').replace(/^\[.*?\]\s*/, '').trim();
  clean = clean.replace(/^(openrouter|opencode-zen|opencode|anthropic|google|openai|deepseek|moonshotai|xiaomi|tencent|nemotron|minimax|gemma|nvidia)\/+/g, '');
  if (clean.includes('/') && !clean.includes('-')) {
    clean = clean.split('/').filter(Boolean).join('-');
  }
  return clean;
}
function getModelColor(model) {
  const key = normalizeModel(model);
  if (!MODEL_COLORS[key]) { MODEL_COLORS[key] = COLORS[colorIdx % COLORS.length]; colorIdx++; }
  return MODEL_COLORS[key];
}
function formatTokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}
function shortenModel(name) {
  const clean = (name || '').replace(/^\[.*?\]\s*/, '').trim();
  if (clean.length > 22) {
    const parts = clean.split('/');
    return parts.length > 1 ? parts[parts.length - 1] : clean.slice(0, 20) + '\u2026';
  }
  return clean;
}

function showEditDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'edit-overlay';
  overlay.innerHTML = `
    <div class="edit-card">
      <h3>Edit Profile</h3>
      <label>Display Name</label>
      <input id="editName" type="text" value="${userName.replace(/"/g, '&quot;')}">
      <label>Avatar URL</label>
      <input id="editAvatar" type="text" value="${avatarUrl.replace(/"/g, '&quot;')}">
      <div class="edit-actions">
        <button class="cancel-btn" onclick="this.closest('.edit-overlay').remove()">Cancel</button>
        <button class="save-btn" onclick="saveProfile()">Save</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}
function saveProfile() {
  const name = document.getElementById('editName').value.trim() || 'nico2525nn';
  const avatar = document.getElementById('editAvatar').value.trim() || 'https://avatars.githubusercontent.com/u/173241093?v=4';
  userName = name;
  avatarUrl = avatar;
  localStorage.setItem('tmx_profile', JSON.stringify({ name, avatar }));
  document.querySelector('.edit-overlay')?.remove();
  // Reload data to re-render header
  loadData();
}

async function loadData() {
  const app = document.getElementById('app');
  try {
    const res = await fetch('/api/stats');
    if (!res.ok) throw new Error('API error');
    const { stats } = await res.json();
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
    app.innerHTML = `<div class="error-box"><p>Failed to load token data</p><p style="font-size:.75rem;margin-top:.25rem;color:var(--muted-foreground)">${e.message}</p><button class="retry-btn" onclick="location.reload()">Retry</button></div>`;
  }
}

function renderDashboard(app, stats) {
  app.innerHTML = `
    <header class="profile-header">
      <div class="profile-info">
        <img src="${avatarUrl}" alt="avatar" class="avatar" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2256%22 height=%2256%22><rect fill=%22oklch(27%25 .012 270)%22 width=%2256%22 height=%2256%22/><text x=%2228%22 y=%2232%22 text-anchor=%22middle%22 fill=%22oklch(65%25 .012 270)%22 font-size=%2224%22 font-family=%22sans-serif%22>${userName[0].toUpperCase()}</text></svg>'">
        <h1 class="username">${userName}</h1>
      </div>
      <button class="edit-btn" onclick="showEditDialog()">Edit Profile</button>
    </header>

    <div class="stats-grid">
      <div class="stats-inner">
        <div class="stat-card"><p class="stat-label">Total Tokens</p><p class="stat-value">${formatTokens(stats.totalTokens)}</p></div>
        <div class="stat-card"><p class="stat-label">Sessions</p><p class="stat-value">${stats.sessions}</p></div>
        <div class="stat-card"><p class="stat-label">Top Token Model</p><p class="stat-value small" title="${stats.topModel}">${shortenModel(stats.topModel)}</p></div>
        <div class="stat-spacer"></div>
        <div class="stat-card"><p class="stat-label">Current Streak</p><p class="stat-value">${stats.currentStreak}</p></div>
        <div class="stat-card"><p class="stat-label">Longest Streak</p><p class="stat-value">${stats.longestStreak}</p></div>
        <div class="stat-card"><p class="stat-label">Active Days</p><p class="stat-value">${stats.activeDays}</p></div>
        <div class="stat-card"><p class="stat-label">Total Input</p><p class="stat-value small">${formatTokens(stats.totalInput)}</p></div>
      </div>
      <div class="chart-section">
        <h2 class="chart-title">Daily Tokens</h2>
        <div class="canvas-wrapper"><canvas id="tokenChart"></canvas></div>
        <div class="chart-legend" id="chartLegend"></div>
      </div>
    </div>

    ${stats.sources ? `
    <div class="sources-section">
      <p class="sources-title">Data Sources</p>
      <div class="sources-list">
        ${['claude','codex','opencode','gemini','copilot','omp','zcode','reasonix'].map(s =>
          `<span class="source-badge${stats.sources.includes(s) ? ' active' : ''}">${s}</span>`
        ).join('')}
      </div>
    </div>` : ''}

    <div class="breakdown-section" id="modelBreakdown">
      <p class="breakdown-title">Model Breakdown</p>
      <div class="loading" style="padding:1rem"><div class="spinner"></div><span>Loading...</span></div>
    </div>

    <div class="footer-note">${stats.firstDate} &ndash; ${stats.lastDate} &middot; ${stats.daily?.length || 0} active days</div>
  `;
}

function renderModelBreakdown(records) {
  const container = document.getElementById('modelBreakdown');
  if (!container) return;
  const totals = {}, inputs = {}, outputs = {};
  for (const r of records) {
    const m = normalizeModel(r.model || 'unknown');
    totals[m] = (totals[m] || 0) + r.totalTokens;
    inputs[m] = (inputs[m] || 0) + r.inputTokens;
    outputs[m] = (outputs[m] || 0) + r.outputTokens;
  }
  const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((s, [,v]) => s + v, 0);
  let html = '<p class="breakdown-title">Model Breakdown</p><div class="breakdown-bar">';
  sorted.forEach(([m, t], i) => {
    html += `<div class="breakdown-segment" style="width:${(t/total*100).toFixed(1)}%;background:${getModelColor(m)}"></div>`;
  });
  html += '</div><div class="breakdown-items">';
  sorted.slice(0, 10).forEach(([m, t]) => {
    html += `<div class="breakdown-item"><span class="model-name"><span class="dot" style="background:${getModelColor(m)}"></span>${m}</span><span class="model-tokens">${formatTokens(t)} (${(t/total*100).toFixed(1)}%) &middot; in ${formatTokens(inputs[m])} / out ${formatTokens(outputs[m])}</span></div>`;
  });
  html += '</div>';
  container.innerHTML = html;
}

const hiddenModels = new Set();
function toggleModel(model) {
  hiddenModels.has(model) ? hiddenModels.delete(model) : hiddenModels.add(model);
  fetch('/api/stats').then(r => r.json()).then(({stats}) => {
    fetch('/api/records').then(r => r.json()).then(({records}) => drawMultiChart(stats.daily, records));
  });
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
    const pt = { date: d.date, total: d.total, models: {} };
    allModels.forEach(m => { pt.models[m] = 0; });
    if (d.byModel) {
      for (const [model, tokens] of Object.entries(d.byModel)) {
        const n = normalizeModel(model);
        if (pt.models[n] !== undefined) pt.models[n] += tokens;
      }
    }
    return pt;
  });
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  const w = rect.width || 600;
  const h = Math.min(320, Math.max(200, w * 0.35));
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  ctx.scale(dpr, dpr);
  const pad = { top: 20, bottom: 30, left: 50, right: 20 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;
  const maxVal = Math.max(...dataPoints.map(d => d.total), 1);
  const xPos = i => pad.left + (i / (dataPoints.length - 1 || 1)) * plotW;

  ctx.font = '11px "Geist Sans", sans-serif';
  ctx.fillStyle = 'oklch(65% .012 270)';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (plotH / 4) * i;
    ctx.fillText(formatTokens(maxVal - (maxVal / 4) * i), pad.left - 8, y + 4);
    ctx.strokeStyle = 'oklch(27% .012 270)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
  }
  const monthLabels = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const seen = new Set();
  for (let i = 0; i < dataPoints.length; i++) {
    const key = dataPoints[i].date.slice(0, 7);
    if (!seen.has(key) || i === dataPoints.length - 1) {
      seen.add(key);
      ctx.textAlign = 'center';
      ctx.fillText(monthLabels[parseInt(dataPoints[i].date.slice(5,7))-1], xPos(i), h - pad.bottom + 18);
    }
  }

  const visibleModels = allModels.filter(m => !hiddenModels.has(m));
  if (visibleModels.length === 0) visibleModels.push(allModels[0]);

  for (const model of visibleModels) {
    const color = modelColors[model];
    let baseLine = [];
    for (let i = 0; i < dataPoints.length; i++) {
      let below = 0;
      for (const m of visibleModels) { if (m === model) break; below += dataPoints[i].models[m] || 0; }
      baseLine.push(below);
    }
    ctx.beginPath();
    for (let i = 0; i < dataPoints.length; i++) {
      const y = pad.top + plotH - ((baseLine[i] + (dataPoints[i].models[model] || 0)) / maxVal) * plotH;
      i === 0 ? ctx.moveTo(xPos(i), y) : ctx.lineTo(xPos(i), y);
    }
    for (let i = dataPoints.length - 1; i >= 0; i--) {
      ctx.lineTo(xPos(i), pad.top + plotH - (baseLine[i] / maxVal) * plotH);
    }
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, pad.top, 0, h - pad.bottom);
    grad.addColorStop(0, color + '40'); grad.addColorStop(1, color + '05');
    ctx.fillStyle = grad; ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < dataPoints.length; i++) {
      const y = pad.top + plotH - ((baseLine[i] + (dataPoints[i].models[model] || 0)) / maxVal) * plotH;
      i === 0 ? ctx.moveTo(xPos(i), y) : ctx.lineTo(xPos(i), y);
    }
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
  }

  const legend = document.getElementById('chartLegend');
  if (legend) {
    legend.innerHTML = visibleModels.map(m =>
      `<span class="legend-item" onclick="toggleModel('${m.replace(/'/g, "\\'")}')"><span class="legend-dot" style="background:${modelColors[m]}"></span>${shortenModel(m)}</span>`
    ).join('');
  }
}

// Legacy single-color chart
function drawChart(daily) {
  if (!daily || !daily.length) return;
  const canvas = document.getElementById('tokenChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  const w = rect.width || 600;
  const h = Math.min(320, Math.max(200, w * 0.35));
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  ctx.scale(dpr, dpr);
  const pad = { top: 20, bottom: 30, left: 50, right: 20 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;
  const values = daily.map(d => d.total);
  const maxVal = Math.max(...values, 1);

  ctx.font = '11px "Geist Sans", sans-serif';
  ctx.fillStyle = 'oklch(65% .012 270)'; ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (plotH / 4) * i;
    ctx.fillText(formatTokens(maxVal - (maxVal/4)*i), pad.left-8, y+4);
    ctx.strokeStyle = 'oklch(27% .012 270)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w-pad.right, y); ctx.stroke();
  }
  const monthLabels = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const seen = new Set();
  for (let i = 0; i < daily.length; i++) {
    const key = daily[i].date.slice(0, 7);
    if (!seen.has(key) || i === daily.length - 1) {
      seen.add(key);
      ctx.textAlign = 'center';
      ctx.fillText(monthLabels[parseInt(daily[i].date.slice(5,7))-1], pad.left + (i/(daily.length-1||1))*plotW, h-pad.bottom+18);
    }
  }
  const gradient = ctx.createLinearGradient(0, pad.top, 0, h-pad.bottom);
  gradient.addColorStop(0, 'oklch(72% .18 45 / 0.25)'); gradient.addColorStop(1, 'oklch(72% .18 45 / 0.02)');
  ctx.beginPath();
  for (let i = 0; i < daily.length; i++) {
    const x = pad.left + (i/(daily.length-1||1))*plotW;
    const y = pad.top + plotH - (values[i]/maxVal)*plotH;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.lineTo(pad.left+plotW, h-pad.bottom); ctx.lineTo(pad.left, h-pad.bottom);
  ctx.closePath(); ctx.fillStyle = gradient; ctx.fill();
  ctx.beginPath();
  for (let i = 0; i < daily.length; i++) {
    const x = pad.left + (i/(daily.length-1||1))*plotW;
    const y = pad.top + plotH - (values[i]/maxVal)*plotH;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.strokeStyle = 'oklch(72% .18 45)'; ctx.lineWidth = 2; ctx.stroke();
  if (daily.length <= 60) {
    for (let i = 0; i < daily.length; i++) {
      const x = pad.left + (i/(daily.length-1||1))*plotW;
      const y = pad.top + plotH - (values[i]/maxVal)*plotH;
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI*2);
      ctx.fillStyle = 'oklch(72% .18 45)'; ctx.fill();
    }
  }
  const legend = document.getElementById('chartLegend');
  if (legend) legend.innerHTML = `<span class="legend-item"><span class="legend-dot" style="background:oklch(72% .18 45)"></span>Total Tokens</span>`;
}

loadData();
setInterval(loadData, 60000);
window.addEventListener('resize', () => { setTimeout(() => loadData(), 500); });
