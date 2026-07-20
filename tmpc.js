
const COLORS = ['#f59e0b','#10b981','#3b82f6','#ef4444','#8b5cf6','#ec4899','#06b6d4','#84cc16','#f97316','#6366f1'];
const MODEL_COLORS = {};
let colorIdx = 0;
let userName = localStorage.getItem('tmx_name') || 'nico2525nn';
let avatarUrl = localStorage.getItem('tmx_avatar') || 'https://avatars.githubusercontent.com/u/173241093?v=4';

function normalizeModel(m) {
  let c = (m||'').replace(/^\[.*?\]\s*/,'').trim();
  c = c.replace(/^(openrouter|opencode-zen|opencode|anthropic|google|openai|deepseek|moonshotai|xiaomi|tencent|nemotron|minimax|gemma|nvidia)\/+/g,'');
  if (c.includes('/')&&!c.includes('-')) c = c.split('/').filter(Boolean).join('-');
  return c;
}
function getModelColor(m) {
  const k = normalizeModel(m);
  if (!MODEL_COLORS[k]) { MODEL_COLORS[k] = COLORS[colorIdx%COLORS.length]; colorIdx++; }
  return MODEL_COLORS[k];
}
function fmt(n) {
  if (n>=1e9) return (n/1e9).toFixed(2)+'B';
  if (n>=1e6) return (n/1e6).toFixed(1)+'M';
  if (n>=1e3) return (n/1e3).toFixed(1)+'K';
  return String(n);
}
function shortModel(n) {
  const c = (n||'').replace(/^\[.*?\]\s*/,'').trim();
  if (c.length>22) { const p=c.split('/'); return p.length>1?p[p.length-1]:c.slice(0,20)+'\u2026'; }
  return c;
}

function showEdit() {
  const o = document.createElement('div'); o.className='edit-overlay';
  o.innerHTML=`<div class="edit-card"><h3>Edit Profile</h3><label>Name</label><input id="edNm" value="${userName.replace(/"/g,'&quot;')}"><label>Avatar URL</label><input id="edAv" value="${avatarUrl.replace(/"/g,'&quot;')}"><div class="edit-actions"><button class="cancel-btn" onclick="this.closest('.edit-overlay').remove()">Cancel</button><button class="save-btn" onclick="saveEdit()">Save</button></div></div>`;
  document.body.appendChild(o);
}
function saveEdit() {
  const n = document.getElementById('edNm').value.trim()||'nico2525nn';
  const a = document.getElementById('edAv').value.trim()||'https://avatars.githubusercontent.com/u/173241093?v=4';
  userName=n; avatarUrl=a;
  localStorage.setItem('tmx_name',n); localStorage.setItem('tmx_avatar',a);
  document.querySelector('.edit-overlay')?.remove();
  loadData();
}

async function loadData() {
  const app = document.getElementById('app');
  try {
    const r = await fetch('/api/stats');
    if (!r.ok) throw Error('API error');
    const {stats} = await r.json();
    renderDash(app,stats);
    const rr = await fetch('/api/records');
    if (rr.ok) { const {records}=await rr.json(); renderBreakdown(records); drawChart(stats.daily,records); }
    else drawChart(stats.daily);
  } catch(e) {
    app.innerHTML=`<div class="error-box"><p>Failed to load token data</p><p style="font-size:.75rem;color:var(--muted-fg)">${e.message}</p><button class="retry-btn" onclick="location.reload()">Retry</button></div>`;
  }
}

function renderDash(app,s) {
  app.innerHTML=`
<header class="profile-header"><div class="profile-info"><img src="${avatarUrl}" alt="" class="avatar" onerror="this.style.display='none'"><h1 class="username">${userName}</h1></div><button class="edit-btn" onclick="showEdit()">Edit Profile</button></header>
<div class="stats-grid"><div class="stats-inner">
<div class="stat-card"><p class="stat-label">Total Tokens</p><p class="stat-value">${fmt(s.totalTokens)}</p></div>
<div class="stat-card"><p class="stat-label">Sessions</p><p class="stat-value">${s.sessions}</p></div>
<div class="stat-card"><p class="stat-label">Top Token Model</p><p class="stat-value small" title="${s.topModel}">${shortModel(s.topModel)}</p></div>
<div class="stat-spacer"></div>
<div class="stat-card"><p class="stat-label">Current Streak</p><p class="stat-value">${s.currentStreak}</p></div>
<div class="stat-card"><p class="stat-label">Longest Streak</p><p class="stat-value">${s.longestStreak}</p></div>
<div class="stat-card"><p class="stat-label">Active Days</p><p class="stat-value">${s.activeDays}</p></div>
<div class="stat-card"><p class="stat-label">Total Input</p><p class="stat-value small">${fmt(s.totalInput)}</p></div>
</div>
<div class="chart-section"><h2 class="chart-title">Daily Tokens</h2><div class="canvas-wrapper"><canvas id="tokenChart"></canvas></div><div class="chart-legend" id="chartLegend"></div></div>
</div>
${s.sources?`
<div class="sources-section"><p class="sources-title">Data Sources</p><div class="sources-list">${['claude','codex','opencode','gemini','copilot','omp','zcode','reasonix'].map(x=>'<span class="source-badge'+(s.sources.includes(x)?' active':'')+'">'+x+'</span>').join('')}</div></div>`:''}
<div class="breakdown-section" id="modelBreakdown"><p class="breakdown-title">Model Breakdown</p><div class="loading" style="padding:1rem"><div class="spinner"></div><span>Loading...</span></div></div>
<div class="footer-note">${s.firstDate} &ndash; ${s.lastDate} &middot; ${s.daily?.length||0} active days</div>`;
}

function renderBreakdown(records) {
  const el = document.getElementById('modelBreakdown'); if(!el) return;
  const t={},i={},o={};
  for(const r of records){const m=normalizeModel(r.model||'unknown');t[m]=(t[m]||0)+r.totalTokens;i[m]=(i[m]||0)+r.inputTokens;o[m]=(o[m]||0)+r.outputTokens;}
  const sorted=Object.entries(t).sort((a,b)=>b[1]-a[1]); const total=sorted.reduce((s,[,v])=>s+v,0);
  let h='<p class="breakdown-title">Model Breakdown</p><div class="breakdown-bar">';
  sorted.forEach(([m,val])=>{h+='<div class="breakdown-segment" style="width:'+((val/total*100).toFixed(1))+'%;background:'+getModelColor(m)+'"></div>';});
  h+='</div><div class="breakdown-items">';
  sorted.slice(0,10).forEach(([m,val])=>{h+='<div class="breakdown-item"><span class="model-name"><span class="dot" style="background:'+getModelColor(m)+'"></span>'+m+'</span><span class="model-tokens">'+fmt(val)+' ('+((val/total*100).toFixed(1))+'%) &middot; in '+fmt(i[m])+' / out '+fmt(o[m])+'</span></div>';});
  h+='</div>'; el.innerHTML=h;
}

// Chart: smooth flowing curves
function drawSmoothTop(ctx, pts) {
  if(pts.length<2) return;
  const t=0.25;
  ctx.moveTo(pts[0].x,pts[0].y);
  for(let i=0;i<pts.length-1;i++){
    const p0=pts[Math.max(0,i-1)],p1=pts[i],p2=pts[i+1],p3=pts[Math.min(pts.length-1,i+2)];
    ctx.bezierCurveTo(p1.x+(p2.x-p0.x)*t,p1.y+(p2.y-p0.y)*t,p2.x-(p3.x-p1.x)*t,p2.y-(p3.y-p1.y)*t,p2.x,p2.y);
  }
}

const hiddenModels=new Set();
function toggleModel(m){hiddenModels.has(m)?hiddenModels.delete(m):hiddenModels.add(m);loadData();}

function drawChart(daily,records){
  if(!daily||!daily.length) return;
  const canvas=document.getElementById('tokenChart'); if(!canvas) return;
  const ctx=canvas.getContext('2d');

  // Build model data
  let modelNames=[];
  if(records) modelNames=[...new Set(records.map(r=>normalizeModel(r.model)).filter(Boolean))];
  const mColors={}; modelNames.forEach(m=>{mColors[m]=getModelColor(m);});

  const dataPoints=daily.map(d=>{
    const pt={date:d.date,total:d.total,models:{}};
    modelNames.forEach(m=>{pt.models[m]=0;});
    if(d.byModel){for(const[m,t]of Object.entries(d.byModel)){const n=normalizeModel(m);if(pt.models[n]!==undefined)pt.models[n]+=t;}}
    return pt;
  });

  const dpr=window.devicePixelRatio||1;
  const w=canvas.parentElement.clientWidth||600;
  const h=Math.min(320,Math.max(200,w*0.35));
  canvas.width=w*dpr; canvas.height=h*dpr;
  canvas.style.width=w+'px'; canvas.style.height=h+'px';
  ctx.scale(dpr,dpr);

  const pad={top:20,bottom:30,left:50,right:20};
  const pw=w-pad.left-pad.right,ph=h-pad.top-pad.bottom;
  const maxVal=Math.max(...dataPoints.map(d=>d.total),1);
  const xp=i=>pad.left+(i/(dataPoints.length-1||1))*pw;

  // Grid
  ctx.font='11px "Geist Sans",sans-serif'; ctx.fillStyle='oklch(58% .005 270)'; ctx.textAlign='right';
  for(let i=0;i<=4;i++){const y=pad.top+(ph/4)*i;ctx.fillText(fmt(maxVal-(maxVal/4)*i),pad.left-8,y+4);ctx.strokeStyle='oklch(24% .005 270)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(pad.left,y);ctx.lineTo(w-pad.right,y);ctx.stroke();}
  // X labels
  const ml=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; const seen=new Set();
  for(let i=0;i<dataPoints.length;i++){const k=dataPoints[i].date.slice(0,7);if(!seen.has(k)||i===dataPoints.length-1){seen.add(k);ctx.textAlign='center';ctx.fillText(ml[parseInt(dataPoints[i].date.slice(5,7))-1],xp(i),h-pad.bottom+18);}}

  const vModels=modelNames.filter(m=>!hiddenModels.has(m));
  if(vModels.length===0) vModels.push(modelNames[0]);

  for(const model of vModels){
    const color=mColors[model];
    const base=[];
    for(let i=0;i<dataPoints.length;i++){let b=0;for(const m of vModels){if(m===model)break;b+=dataPoints[i].models[m]||0;}base.push(b);}
    const tp=[],bp=[];
    for(let i=0;i<dataPoints.length;i++){tp.push({x:xp(i),y:pad.top+ph-((base[i]+(dataPoints[i].models[model]||0))/maxVal)*ph});bp.push({x:xp(i),y:pad.top+ph-(base[i]/maxVal)*ph});}

    // Fill: smooth top, straight bottom
    ctx.beginPath();
    drawSmoothTop(ctx,tp);
    ctx.lineTo(bp[bp.length-1].x,bp[bp.length-1].y);
    for(let i=bp.length-2;i>=0;i--) ctx.lineTo(bp[i].x,bp[i].y);
    ctx.closePath();
    const g=ctx.createLinearGradient(0,pad.top,0,h-pad.bottom);
    g.addColorStop(0,color+'50'); g.addColorStop(1,color+'08');
    ctx.fillStyle=g; ctx.fill();

    // Stroke top
    ctx.beginPath(); drawSmoothTop(ctx,tp);
    ctx.strokeStyle=color; ctx.lineWidth=2; ctx.lineJoin='round'; ctx.stroke();
  }

  // Legend
  const legend=document.getElementById('chartLegend');
  if(legend) legend.innerHTML=vModels.map(m=>'<span class="legend-item" onclick="toggleModel(\''+m.replace(/'/g,"\\'")+'\')"><span class="legend-dot" style="background:'+mColors[m]+'"></span>'+shortModel(m)+'</span>').join('');
}

// Fallback single-color chart
function drawChartFallback(daily){drawChart(daily);}

loadData();
setInterval(loadData,60000);
window.addEventListener('resize',()=>setTimeout(loadData,500));
