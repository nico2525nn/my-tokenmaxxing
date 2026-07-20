
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
  o.innerHTML='<div class="edit-card"><h3>Edit Profile</h3><label>Name</label><input id="edNm" value="'+userName.replace(/"/g,'&quot;')+'"><label>Avatar URL</label><input id="edAv" value="'+avatarUrl.replace(/"/g,'&quot;')+'"><div class="edit-actions"><button class="cancel-btn" onclick="this.closest(\'.edit-overlay\').remove()">Cancel</button><button class="save-btn" onclick="saveEdit()">Save</button></div></div>';
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
    app.innerHTML='<div class="error-box"><p>Failed to load token data</p><p style="font-size:.75rem;color:var(--muted-fg)">'+e.message+'</p><button class="retry-btn" onclick="location.reload()">Retry</button></div>';
  }
}

function renderDash(app,s) {
  app.innerHTML='<header class="profile-header"><div class="profile-info"><img src="'+avatarUrl+'" alt="" class="avatar" onerror="this.style.display=\'none\'"><h1 class="username">'+userName+'</h1></div><button class="edit-btn" onclick="showEdit()">Edit Profile</button></header><div class="stats-grid"><div class="stats-inner"><div class="stat-card"><p class="stat-label">Total Tokens</p><p class="stat-value">'+fmt(s.totalTokens)+'</p></div><div class="stat-card"><p class="stat-label">Sessions</p><p class="stat-value">'+s.sessions+'</p></div><div class="stat-card"><p class="stat-label">Top Token Model</p><p class="stat-value small" title="'+s.topModel+'">'+shortModel(s.topModel)+'</p></div><div class="stat-spacer"></div><div class="stat-card"><p class="stat-label">Current Streak</p><p class="stat-value">'+s.currentStreak+'</p></div><div class="stat-card"><p class="stat-label">Longest Streak</p><p class="stat-value">'+s.longestStreak+'</p></div><div class="stat-card"><p class="stat-label">Active Days</p><p class="stat-value">'+s.activeDays+'</p></div><div class="stat-card"><p class="stat-label">Total Input</p><p class="stat-value small">'+fmt(s.totalInput)+'</p></div></div><div class="chart-section"><h2 class="chart-title">Daily Tokens</h2><div class="canvas-wrapper"><canvas id="tokenChart"></canvas></div><div class="chart-legend" id="chartLegend"></div></div></div>'+(s.sources?'<div class="sources-section"><p class="sources-title">Data Sources</p><div class="sources-list">'+['claude','codex','opencode','gemini','copilot','omp','zcode','reasonix'].map(function(x){return '<span class="source-badge'+(s.sources.includes(x)?' active':'')+'">'+x+'</span>';}).join('')+'</div></div>':'')+'<div class="breakdown-section" id="modelBreakdown"><p class="breakdown-title">Model Breakdown</p><div class="loading" style="padding:1rem"><div class="spinner"></div><span>Loading...</span></div></div><div class="footer-note">'+s.firstDate+' &ndash; '+s.lastDate+' &middot; '+(s.daily?.length||0)+' active days</div>';
}

function renderBreakdown(records) {
  const el = document.getElementById('modelBreakdown'); if(!el) return;
  const t={},i={},o={};
  for(const r of records){const m=normalizeModel(r.model||'unknown');t[m]=(t[m]||0)+r.totalTokens;i[m]=(i[m]||0)+r.inputTokens;o[m]=(o[m]||0)+r.outputTokens;}
  const sorted=Object.entries(t).sort(function(a,b){return b[1]-a[1];}); const total=sorted.reduce(function(s,x){return s+x[1];},0);
  let h='<p class="breakdown-title">Model Breakdown</p><div class="breakdown-bar">';
  sorted.forEach(function(x){h+='<div class="breakdown-segment" style="width:'+((x[1]/total*100).toFixed(1))+'%;background:'+getModelColor(x[0])+'"></div>';});
  h+='</div><div class="breakdown-items">';
  sorted.slice(0,10).forEach(function(x){h+='<div class="breakdown-item"><span class="model-name"><span class="dot" style="background:'+getModelColor(x[0])+'"></span>'+x[0]+'</span><span class="model-tokens">'+fmt(x[1])+' ('+((x[1]/total*100).toFixed(1))+'%) &middot; in '+fmt(i[x[0]])+' / out '+fmt(o[x[0]])+'</span></div>';});
  h+='</div>'; el.innerHTML=h;
}

const hiddenModels=new Set();
function toggleModel(m){hiddenModels.has(m)?hiddenModels.delete(m):hiddenModels.add(m);loadData();}

function drawChart(daily,records){
  if(!daily||!daily.length) return;
  const canvas=document.getElementById('tokenChart'); if(!canvas) return;
  const ctx=canvas.getContext('2d');
  let modelNames=[];
  if(records) modelNames=[...new Set(records.map(function(r){return normalizeModel(r.model);}).filter(Boolean))];
  const mColors={}; modelNames.forEach(function(m){mColors[m]=getModelColor(m);});

  // Group: ≤14d → daily bars, else 3-day groups, else weekly
  const n=daily.length;
  const gs=n>60?7:n>30?3:1;
  const grps=[];
  for(let i=0;i<n;i+=gs){
    const end=Math.min(i+gs,n);
    const slc=daily.slice(i,end);
    const lab=slc[0].date.slice(5);
    const a={label:lab,total:0,models:{}};
    modelNames.forEach(function(m){a.models[m]=0;});
    for(const d of slc){
      a.total+=d.total;
      if(d.byModel){for(const m in d.byModel){const nm=normalizeModel(m);if(a.models[nm]!==undefined)a.models[nm]+=d.byModel[m];}}
    }
    grps.push(a);
  }
  const dpr=window.devicePixelRatio||1;
  const w=canvas.parentElement.clientWidth||600;
  const h=Math.min(320,Math.max(200,w*0.35));
  canvas.width=w*dpr; canvas.height=h*dpr;
  canvas.style.width=w+'px'; canvas.style.height=h+'px';
  ctx.scale(dpr,dpr);
  const pad={top:24,bottom:30,left:50,right:20};
  const pw=w-pad.left-pad.right,ph=h-pad.top-pad.bottom;
  const maxVal=Math.max(...grps.map(function(g){return g.total;}),1);
  const barW=Math.min(pw/grps.length*0.65,28);
  const gap=(pw-barW*grps.length)/(grps.length+1);

  // Grid
  ctx.font='11px "Geist Sans",sans-serif'; ctx.fillStyle='oklch(58% .005 270)'; ctx.textAlign='right';
  for(let i=0;i<=4;i++){const y=pad.top+(ph/4)*i;ctx.fillText(fmt(maxVal-(maxVal/4)*i),pad.left-8,y+4);ctx.strokeStyle='oklch(24% .005 270)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(pad.left,y);ctx.lineTo(w-pad.right,y);ctx.stroke();}

  const vModels=modelNames.filter(function(m){return !hiddenModels.has(m);});
  if(vModels.length===0&&modelNames.length>0) vModels.push(modelNames[0]);

  // Stacked bars
  for(let gi=0;gi<grps.length;gi++){
    const g=grps[gi];
    const x=pad.left+gap+gi*(barW+gap);
    let yBot=pad.top+ph;
    for(let vi=0;vi<vModels.length;vi++){
      const m=vModels[vi]; const val=g.models[m]||0;
      if(val===0) continue;
      const hBar=(val/maxVal)*ph;
      ctx.fillStyle=mColors[m];
      ctx.fillRect(x,yBot-hBar,barW,hBar);
      yBot-=hBar;
    }
  }

  // X labels (thin every N, skip last to avoid crowding)
  const ls=grps.length>15?Math.ceil(grps.length/10):1;
  for(let gi=0;gi<grps.length-1;gi+=ls){
    const x=pad.left+gap+gi*(barW+gap)+barW/2;
    ctx.textAlign='center'; ctx.fillStyle='oklch(58% .005 270)';
    ctx.fillText(grps[gi].label,x,h-pad.bottom+16);
  }

  // Legend
  const legend=document.getElementById('chartLegend');
  if(legend) legend.innerHTML=vModels.map(function(m){return '<span class="legend-item" onclick="toggleModel(\''+m.replace(/'/g,"\\'")+'\')"><span class="legend-dot" style="background:'+mColors[m]+'"></span>'+shortModel(m)+'</span>';}).join('');
}

loadData();
setInterval(loadData,60000);
window.addEventListener('resize',function(){setTimeout(loadData,500);});
