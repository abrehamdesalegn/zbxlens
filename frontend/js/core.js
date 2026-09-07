/**
 * core.js — global state, API client, auth, timezone helpers, health pulse, charts
 * Loaded as classic script (global scope). Order matters — see index.html.
 */

let lastRequest = null;
let appConfig = { tz_offset_minutes: 0, max_raw_points: 20000 };
let sessionToken = localStorage.getItem('zr_session') || '';
let currentUser = null;

function apiHeaders(extra){
  const h = Object.assign({'Content-Type': 'application/json'}, extra || {});
  if(sessionToken){
    h['X-Session-Token'] = sessionToken;
    h['Authorization'] = 'Bearer ' + sessionToken;
  }
  return h;
}

async function apiFetch(url, opts){
  opts = opts || {};
  opts.headers = apiHeaders(opts.headers);
  opts.credentials = 'same-origin';
  const timeoutMs = opts.timeoutMs || 15000;
  delete opts.timeoutMs;
  const ctrl = new AbortController();
  const timer = setTimeout(function(){ ctrl.abort(); }, timeoutMs);
  opts.signal = ctrl.signal;
  try{
    const res = await fetch(url, opts);
    if(res.status === 401 && url !== '/api/auth/me'){
      currentUser = null;
      sessionToken = '';
      _pinsCache = null;
      localStorage.removeItem('zr_session');
      renderUserBadge();
      showLoginModal();
      throw new Error('Unauthorized');
    }
    return res;
  }catch(err){
    if(err && err.name === 'AbortError'){
      throw new Error('Request timed out after '+timeoutMs+'ms: '+url);
    }
    throw err;
  }finally{
    clearTimeout(timer);
  }
}

function canManage(){
  return !!(currentUser && currentUser.is_admin);
}

function renderUserBadge(){
  const el = document.getElementById('userBadge');
  if(!el) return;
  if(!currentUser){
    el.style.display = 'none'; el.innerHTML = '';
    if(typeof updateHealthButtonState === 'function') updateHealthButtonState();
    return;
  }
  el.style.display = '';
  el.innerHTML =
    '<span class="ub-name"></span>'+
    '<span class="ub-role"></span>'+
    '<button type="button" id="logoutBtn">Log out</button>';
  el.querySelector('.ub-name').textContent = currentUser.username || currentUser.alias || '';
  el.querySelector('.ub-name').title = currentUser.username || '';
  el.querySelector('.ub-role').textContent = currentUser.role_label || '';
  const btn = document.getElementById('logoutBtn');
  if(btn) btn.addEventListener('click', doLogout);
  if(typeof updateHealthButtonState === 'function') updateHealthButtonState();
}

async function doLogout(){
  try{ await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: apiHeaders() }); }catch(e){ console.warn(e); }
  currentUser = null;
  sessionToken = '';
  _pinsCache = null;
  localStorage.removeItem('zr_session');
  renderUserBadge();
  showLoginModal();
}

function showLoginModal(msg){
  const modal = document.getElementById('loginModal');
  if(!modal) return;
  modal.classList.add('show');
  const err = document.getElementById('loginError');
  if(err){
    if(msg){ err.textContent = msg; err.style.display = ''; }
    else { err.style.display = 'none'; err.textContent = ''; }
  }
  const u = document.getElementById('loginUsername');
  if(u) u.focus();
}

function hideLoginModal(){
  const modal = document.getElementById('loginModal');
  if(modal) modal.classList.remove('show');
}

async function attemptLogin(){
  const btn = document.getElementById('loginSubmit');
  const err = document.getElementById('loginError');
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  if(!username || !password){
    if(err){ err.textContent = 'Enter your Zabbix username and password.'; err.style.display = ''; }
    return;
  }
  if(btn){ btn.classList.add('loading'); btn.disabled = true; }
  if(err){ err.style.display = 'none'; }
  try{
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username, password: password }),
    });
    const data = await res.json().catch(function(){ return {}; });
    if(!res.ok){
      throw new Error(data.detail || 'Sign-in failed');
    }
    currentUser = data.user;
    if(data.session){
      sessionToken = data.session;
      localStorage.setItem('zr_session', sessionToken);
    }
    document.getElementById('loginPassword').value = '';
    hideLoginModal();
    renderUserBadge();
    await startApp();
  }catch(e){
    if(err){ err.textContent = e.message || String(e); err.style.display = ''; }
  }finally{
    if(btn){ btn.classList.remove('loading'); btn.disabled = false; }
  }
}

document.getElementById('loginForm').addEventListener('submit', function(e){
  e.preventDefault();
  attemptLogin();
});

/**
 * Minutes east of UTC for wall-clock display and HOURS filtering.
 * Prefer server TZ_OFFSET_MINUTES (e.g. 180 for UTC+3). If unset (0),
 * fall back to the browser timezone so labels match the HOURS preset.
 */
function effectiveTzOffsetMinutes(){
  if(appConfig && typeof appConfig.tz_offset_minutes === 'number' && appConfig.tz_offset_minutes !== 0){
    return appConfig.tz_offset_minutes;
  }
  // getTimezoneOffset is minutes *west* of UTC → invert
  return -new Date().getTimezoneOffset();
}

/** Value for API tz_offset_min (JavaScript getTimezoneOffset convention). */
function apiTzOffsetMin(){
  return -effectiveTzOffsetMinutes();
}

function tzLabel(){
  const m = effectiveTzOffsetMinutes();
  if(m === 0) return 'UTC';
  const sign = m > 0 ? '+' : '-';
  const abs = Math.abs(m);
  const h = Math.floor(abs/60), mm = abs % 60;
  return 'UTC' + sign + h + (mm ? ':' + String(mm).padStart(2,'0') : '');
}

function updateTzLabels(){
  const lab = tzLabel();
  const fl = document.getElementById('fromLabel');
  const tl = document.getElementById('toLabel');
  if(fl) fl.textContent = 'From (' + lab + ')';
  if(tl) tl.textContent = 'To (' + lab + ')';
}

function toEpoch(datetimeLocal){
  // datetime-local is wall time in the configured / effective offset
  if(!datetimeLocal) return 0;
  const m = String(datetimeLocal).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if(!m) return 0;
  const y = +m[1], mo = +m[2]-1, d = +m[3], h = +m[4], mi = +m[5];
  const utcMs = Date.UTC(y, mo, d, h, mi, 0);
  const offsetMin = effectiveTzOffsetMinutes();
  return Math.floor(utcMs / 1000) - offsetMin * 60;
}

function fromEpochToLocalInput(clock){
  const offsetMin = effectiveTzOffsetMinutes();
  const ms = (Number(clock) + offsetMin * 60) * 1000;
  const dt = new Date(ms);
  if(isNaN(dt.getTime())) return '';
  const p = function(n){ return String(n).padStart(2, '0'); };
  return dt.getUTCFullYear()+'-'+p(dt.getUTCMonth()+1)+'-'+p(dt.getUTCDate())+'T'+p(dt.getUTCHours())+':'+p(dt.getUTCMinutes());
}

function fmtTime(clock){
  const offsetMin = effectiveTzOffsetMinutes();
  const ms = (Number(clock) + offsetMin * 60) * 1000;
  const dt = new Date(ms);
  if(isNaN(dt.getTime())) return '—';
  const p = function(n){ return String(n).padStart(2, '0'); };
  return p(dt.getUTCDate())+'/'+p(dt.getUTCMonth()+1)+'/'+dt.getUTCFullYear()+' '+p(dt.getUTCHours())+':'+p(dt.getUTCMinutes());
}

function fmtTimeShort(clock){
  const offsetMin = effectiveTzOffsetMinutes();
  const ms = (Number(clock) + offsetMin * 60) * 1000;
  const dt = new Date(ms);
  if(isNaN(dt.getTime())) return '—';
  const p = function(n){ return String(n).padStart(2, '0'); };
  // MM-DD HH:MM in effective timezone (e.g. UTC+3)
  return p(dt.getUTCMonth()+1)+'-'+p(dt.getUTCDate())+' '+p(dt.getUTCHours())+':'+p(dt.getUTCMinutes());
}



(function pulse(){
  const canvas = document.getElementById('pulse');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const points = new Array(60).fill(H/2);
  function step(){
    points.shift();
    const last = points[points.length-1];
    let next = last + (Math.random()-0.5)*6;
    if(Math.random() < 0.04) next += (Math.random()>0.5?1:-1)*10;
    next = Math.max(4, Math.min(H-4, next*0.7 + (H/2)*0.3));
    points.push(next);
    ctx.clearRect(0,0,W,H);
    ctx.beginPath();
    ctx.strokeStyle = '#E8A33D';
    ctx.globalAlpha = .8;
    ctx.lineWidth = 1.4;
    points.forEach((y,i) => {
      const x = i*(W/(points.length-1));
      if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    });
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  step();
  setInterval(step, 220);
})();

let _lastHealth = null;
let _healthModal = null;

function ensureHealthModal(){
  if(_healthModal) return _healthModal;
  const el = document.createElement('div');
  el.className = 'modal-backdrop';
  el.id = 'healthModal';
  el.innerHTML =
    '<div class="modal" style="width:min(420px,94vw);">'+
      '<h3>Zabbix database</h3>'+
      '<div id="healthModalBody" style="font-size:13px;color:var(--text-dim);line-height:1.55;"></div>'+
      '<div class="row" style="margin-top:16px;">'+
        '<button class="btn btn-ghost" type="button" id="healthRefreshBtn">Refresh</button>'+
        '<button class="btn btn-primary" type="button" id="healthCloseBtn">Close</button>'+
      '</div>'+
    '</div>';
  document.body.appendChild(el);
  el.querySelector('#healthCloseBtn').addEventListener('click', function(){ el.classList.remove('show'); });
  el.addEventListener('click', function(e){ if(e.target === el) el.classList.remove('show'); });
  el.querySelector('#healthRefreshBtn').addEventListener('click', async function(){
    await checkHealth();
    renderHealthModalBody();
  });
  _healthModal = el;
  return el;
}

function renderHealthModalBody(){
  const body = document.getElementById('healthModalBody');
  if(!body) return;
  const d = _lastHealth;
  if(!d){
    body.innerHTML = '<p style="margin:0;color:var(--danger);">No status yet — still checking…</p>';
    return;
  }
  if(d.error){
    const c = d.connection || {};
    body.innerHTML =
      '<div class="status-msg warn" style="margin-bottom:12px;">Unreachable</div>'+
      '<div class="health-kv">'+
        '<div><span>Error</span><b>'+escHtml(String(d.error))+'</b></div>'+
        '<div><span>Host</span><b>'+escHtml(String(c.host||'—'))+':'+(c.port!=null?c.port:'')+'</b></div>'+
        '<div><span>Database</span><b>'+escHtml(String(c.database||'—'))+'</b></div>'+
        '<div><span>User</span><b>'+escHtml(String(c.user||'—'))+'</b></div>'+
      '</div>';
    return;
  }
  const c = d.connection || {};
  const rows = [
    ['Status', d.db === 'reachable' ? 'Connected' : (d.status || 'OK')],
    ['Latency', (d.latency_ms != null ? d.latency_ms + ' ms' : '—')],
    ['Host', (c.host || '—') + (c.port != null ? ':' + c.port : '')],
    ['Database', c.database || '—'],
    ['User', c.user || '—'],
    ['MySQL', d.server_version || '—'],
    ['App', d.version ? ('v' + d.version) : '—'],
    ['Open problems', d.problem_open != null ? String(d.problem_open) : '—'],
    ['Monitored hosts', d.hosts_monitored != null ? String(d.hosts_monitored) : '—'],
  ];
  body.innerHTML =
    '<div class="health-kv">'+
      rows.map(function(r){
        return '<div><span>'+escHtml(r[0])+'</span><b>'+escHtml(r[1])+'</b></div>';
      }).join('')+
    '</div>';
}

function canViewDbStatus(){
  return !!(currentUser && currentUser.is_superadmin);
}

function updateHealthButtonState(){
  const dot = document.getElementById('liveDot');
  if(!dot) return;
  if(canViewDbStatus()){
    dot.classList.add('is-btn');
    dot.setAttribute('role', 'button');
    dot.setAttribute('tabindex', '0');
    dot.title = 'Click for Zabbix database status';
  } else {
    dot.classList.remove('is-btn');
    dot.removeAttribute('role');
    dot.removeAttribute('tabindex');
    dot.title = '';
    if(_healthModal) _healthModal.classList.remove('show');
  }
}

async function showHealthStatus(){
  if(!canViewDbStatus()) return;
  ensureHealthModal();
  await checkHealth();
  renderHealthModalBody();
  _healthModal.classList.add('show');
}

async function checkHealth(){
  const dot = document.getElementById('liveDot');
  const label = document.getElementById('liveLabel');
  try{
    const res = await fetch('/api/health', { cache: 'no-store' });
    if(res.ok){
      const data = await res.json();
      _lastHealth = data;
      if(dot) dot.className = 'live-dot ok';
      if(label) label.textContent = 'DB connected';
      updateHealthButtonState();
    } else {
      let errMsg = 'DB unreachable';
      let conn = null;
      try{
        const err = await res.json();
        if(err && err.detail){
          if(typeof err.detail === 'string') errMsg = err.detail;
          else if(err.detail.message){ errMsg = err.detail.message; conn = err.detail.connection; }
        }
      }catch(e){}
      _lastHealth = { error: errMsg, connection: conn };
      if(dot) dot.className = 'live-dot bad';
      if(label) label.textContent = 'DB unreachable';
      updateHealthButtonState();
    }
  }catch(e){
    const msg = (e && e.name === 'AbortError') ? 'Health timeout' : 'DB unreachable';
    _lastHealth = { error: msg };
    if(dot) dot.className = 'live-dot bad';
    if(label) label.textContent = msg;
    updateHealthButtonState();
  }
}

function themeColor(darkHex, lightHex){
  return (document.body && document.body.getAttribute('data-theme') === 'light') ? lightHex : darkHex;
}

function drawLineChart(canvas, tooltipEl, opts){
  // opts.viewFrom / opts.viewTo — inclusive index range into labels/datasets (zoom window)
  // opts.onZoom(fromIdx, toIdx) — called after a drag-select; indices are absolute into full data
  // opts.enableZoom — default true when onZoom is provided
  const fullLabels = opts.labels || [];
  const fullDatasets = opts.datasets || [];
  const showLegend = opts.showLegend;
  const valueFmt = opts.valueFmt;
  const thresholds = opts.thresholds || null;
  const fullN = fullLabels.length;
  let viewFrom = (typeof opts.viewFrom === 'number') ? opts.viewFrom : 0;
  let viewTo = (typeof opts.viewTo === 'number') ? opts.viewTo : (fullN - 1);
  if(viewFrom < 0) viewFrom = 0;
  if(viewTo >= fullN) viewTo = fullN - 1;
  if(viewFrom > viewTo){ const t = viewFrom; viewFrom = viewTo; viewTo = t; }

  // Slice visible window
  const labels = fullLabels.slice(viewFrom, viewTo + 1);
  const datasets = fullDatasets.map(function(ds){
    return Object.assign({}, ds, { data: (ds.data || []).slice(viewFrom, viewTo + 1) });
  });

  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 560;
  const cssH = (opts.height && opts.height > 0) ? opts.height : 230;
  canvas.width = cssW*dpr; canvas.height = cssH*dpr;
  canvas.style.height = cssH+'px';
  canvas.style.cursor = opts.onZoom ? 'crosshair' : 'default';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1,0,0,1,0,0);
  ctx.scale(dpr,dpr);
  ctx.clearRect(0,0,cssW,cssH);

  const allVals = datasets.flatMap(function(d){return d.data.filter(function(v){return typeof v==='number'&&!isNaN(v);});});
  if(!allVals.length) return;
  let min=Math.min.apply(null,allVals), max=Math.max.apply(null,allVals);
  if(min===max){min-=1; max+=1;}
  const pad=(max-min)*0.1; min-=pad; max+=pad;

  // Measure Y-axis labels so left padding is wide enough (avoids clipped ticks)
  const padR=12, padT= showLegend?26:12, padB=22;
  const gridLines=4;
  ctx.font='10px IBM Plex Mono, monospace';
  let maxLabelW = 0;
  for(let g=0; g<=gridLines; g++){
    const v = min+(max-min)*g/gridLines;
    const tw = ctx.measureText(valueFmt(v)).width;
    if(tw > maxLabelW) maxLabelW = tw;
  }
  const padL = Math.max(48, Math.ceil(maxLabelW) + 14);
  const plotW=cssW-padL-padR, plotH=cssH-padT-padB;

  const n = labels.length;
  const xAt = function(i){ return padL + (n<=1? plotW/2 : plotW*i/(n-1)); };
  const yAt = function(v){ return padT + plotH - ((v-min)/(max-min))*plotH; };
  const idxAtX = function(mx){
    if(n <= 1) return 0;
    const t = (mx - padL) / plotW;
    return Math.max(0, Math.min(n - 1, Math.round(t * (n - 1))));
  };

  // Threshold band colors (match CSS --success / --accent / --danger)
  const BAND = { good: '#3FBF6F', warn: '#E8A33D', bad: '#E5566D' };
  function bandColor(v){
    if(!thresholds || !thresholds.mode || thresholds.mode === 'off') return null;
    if(typeof v !== 'number' || isNaN(v)) return null;
    const yellow = thresholds.yellow != null && !isNaN(thresholds.yellow) ? thresholds.yellow : 75;
    const red = thresholds.red != null && !isNaN(thresholds.red) ? thresholds.red : 90;
    const mode = thresholds.mode;
    if(mode === 'high_bad' || mode === 'bad_high'){
      if(v >= red) return BAND.bad;
      if(v >= yellow) return BAND.warn;
      return BAND.good;
    }
    if(mode === 'high_good' || mode === 'good_high'){
      if(v <= red) return BAND.bad;
      if(v <= yellow) return BAND.warn;
      return BAND.good;
    }
    return null;
  }
  /** Threshold levels used to split line segments so each piece is one solid band colour. */
  function thresholdLevels(){
    if(!thresholds || !thresholds.mode || thresholds.mode === 'off') return [];
    const levels = [];
    const y = thresholds.yellow, r = thresholds.red;
    if(y != null && !isNaN(y)) levels.push(+y);
    if(r != null && !isNaN(r) && +r !== +y) levels.push(+r);
    return levels;
  }
  /**
   * Split a value-span at every threshold crossing.
   * Returns ordered t in (0,1) where the value crosses a level between v0 and v1.
   */
  function crossingTs(v0, v1, levels){
    const ts = [];
    if(typeof v0 !== 'number' || typeof v1 !== 'number' || v0 === v1) return ts;
    levels.forEach(function(L){
      if((v0 < L && v1 > L) || (v0 > L && v1 < L)){
        const t = (L - v0) / (v1 - v0);
        if(t > 0.0005 && t < 0.9995) ts.push(t);
      }
    });
    ts.sort(function(a,b){ return a - b; });
    return ts;
  }
  const useThresholds = !!(thresholds && thresholds.mode && thresholds.mode !== 'off');
  const thLevels = useThresholds ? thresholdLevels() : [];

  function paintChart(selX0, selX1){
    ctx.setTransform(1,0,0,1,0,0);
    ctx.scale(dpr,dpr);
    ctx.clearRect(0,0,cssW,cssH);

    ctx.strokeStyle=themeColor('#1c2530','#e2e5ea'); ctx.fillStyle=themeColor('#5C6570','#848D99');
    ctx.font='10px IBM Plex Mono, monospace'; ctx.textBaseline='middle';
    for(let g=0; g<=gridLines; g++){
      const v=min+(max-min)*g/gridLines, y=yAt(v);
      ctx.beginPath(); ctx.moveTo(padL,y); ctx.lineTo(cssW-padR,y); ctx.stroke();
      ctx.textAlign='right';
      ctx.fillText(valueFmt(v), padL-8, y);
    }
    ctx.textAlign='center'; ctx.textBaseline='top';
    const maxTicks=Math.max(2, Math.floor(plotW/95));
    const step=Math.max(1, Math.ceil(n/maxTicks));
    for(let i=0;i<n;i+=step) ctx.fillText(labels[i], xAt(i), cssH-padB+7);

    if(showLegend){
      let lx=padL;
      datasets.forEach(function(ds){
        ctx.fillStyle=ds.color; ctx.fillRect(lx, padT-18, 8, 8);
        ctx.fillStyle=themeColor('#8D97A3','#5B6470'); ctx.textAlign='left'; ctx.textBaseline='middle';
        ctx.fillText(ds.label, lx+12, padT-14);
        lx += ctx.measureText(ds.label).width + 30;
      });
    }

    const primary = datasets[0];
    if(primary && primary.fill){
      const fillBase = useThresholds ? '#8D97A3' : primary.color;
      const grad = ctx.createLinearGradient(0,padT,0,padT+plotH);
      grad.addColorStop(0, fillBase+'33');
      grad.addColorStop(1, fillBase+'00');
      ctx.beginPath();
      let started=false;
      primary.data.forEach(function(v,i){
        if(typeof v!=='number') return;
        const x=xAt(i), y=yAt(v);
        if(!started){ ctx.moveTo(x, padT+plotH); ctx.lineTo(x,y); started=true; }
        else ctx.lineTo(x,y);
      });
      const lastIdx = primary.data.length-1;
      if(started){
        ctx.lineTo(xAt(lastIdx), padT+plotH);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
      }
    }

    datasets.forEach(function(ds){
      const lineW = ds.width || 2;
      if(ds.dash) ctx.setLineDash(ds.dash); else ctx.setLineDash([]);
      if(useThresholds && ds === primary){
        ctx.lineWidth = lineW;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        let prevIdx = -1;
        for(let i = 0; i < ds.data.length; i++){
          const v = ds.data[i];
          if(typeof v !== 'number' || isNaN(v)){ prevIdx = -1; continue; }
          if(prevIdx >= 0){
            const a = prevIdx, b = i;
            const v0 = ds.data[a], v1 = ds.data[b];
            const x0 = xAt(a), y0 = yAt(v0);
            const x1 = xAt(b), y1 = yAt(v1);
            // Split at threshold crossings so the portion above/below a
            // threshold is a single solid colour — no mixed segment colour.
            const ts = [0].concat(crossingTs(v0, v1, thLevels), [1]);
            for(let k = 0; k < ts.length - 1; k++){
              const tA = ts[k], tB = ts[k + 1];
              if(tB - tA < 1e-6) continue;
              const xa = x0 + (x1 - x0) * tA, ya = y0 + (y1 - y0) * tA;
              const xb = x0 + (x1 - x0) * tB, yb = y0 + (y1 - y0) * tB;
              const vMid = v0 + (v1 - v0) * ((tA + tB) / 2);
              const col = bandColor(vMid) || ds.color;
              ctx.beginPath();
              ctx.strokeStyle = col;
              ctx.moveTo(xa, ya);
              ctx.lineTo(xb, yb);
              ctx.stroke();
            }
          }
          prevIdx = i;
        }
      } else {
        ctx.beginPath(); ctx.strokeStyle=ds.color; ctx.lineWidth=lineW;
        let started=false;
        ds.data.forEach(function(v,i){
          if(typeof v!=='number'||isNaN(v)) return;
          const x=xAt(i), y=yAt(v);
          if(!started){ctx.moveTo(x,y); started=true;} else ctx.lineTo(x,y);
        });
        ctx.stroke();
      }
      ctx.setLineDash([]);
    });

    // Drag-select overlay
    if(typeof selX0 === 'number' && typeof selX1 === 'number' && selX0 !== selX1){
      const left = Math.max(padL, Math.min(selX0, selX1));
      const right = Math.min(cssW - padR, Math.max(selX0, selX1));
      if(right > left){
        ctx.fillStyle = 'rgba(63,201,201,0.18)';
        ctx.fillRect(left, padT, right - left, plotH);
        ctx.strokeStyle = 'rgba(63,201,201,0.7)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(left, padT); ctx.lineTo(left, padT + plotH);
        ctx.moveTo(right, padT); ctx.lineTo(right, padT + plotH);
        ctx.stroke();
      }
    }
  }

  paintChart();

  // --- Interaction: tooltip + drag-to-zoom ---
  let dragging = false;
  let dragStartX = null;
  let dragCurX = null;
  const enableZoom = !!(opts.onZoom && typeof opts.onZoom === 'function');

  function clientXToCanvas(e){
    const r = canvas.getBoundingClientRect();
    return e.clientX - r.left;
  }

  canvas.onmousedown = function(e){
    if(!enableZoom || e.button !== 0) return;
    const mx = clientXToCanvas(e);
    if(mx < padL || mx > cssW - padR) return;
    dragging = true;
    dragStartX = mx;
    dragCurX = mx;
    if(tooltipEl) tooltipEl.style.opacity = 0;
    e.preventDefault();
  };

  canvas.onmousemove = function(e){
    const mx = clientXToCanvas(e);
    if(dragging && enableZoom){
      dragCurX = Math.max(padL, Math.min(cssW - padR, mx));
      paintChart(dragStartX, dragCurX);
      if(tooltipEl) tooltipEl.style.opacity = 0;
      return;
    }
    if(mx < padL || mx > cssW-padR){ if(tooltipEl) tooltipEl.style.opacity=0; return; }
    const idx = idxAtX(mx);
    if(idx<0||idx>=n){ if(tooltipEl) tooltipEl.style.opacity=0; return; }
    const x = xAt(idx);
    let html = '<div class="t-time">'+labels[idx]+'</div>';
    datasets.forEach(function(ds){
      const v = ds.data[idx];
      if(typeof v!=='number') return;
      const swatch = (useThresholds && ds === datasets[0]) ? (bandColor(v) || ds.color) : ds.color;
      html += '<div class="t-row"><span class="t-swatch" style="background:'+swatch+'"></span>'+ds.label+': '+valueFmt(v)+'</div>';
    });
    if(tooltipEl){
      tooltipEl.innerHTML = html;
      tooltipEl.style.left = Math.min(x+10, cssW-140) + 'px';
      tooltipEl.style.top = '8px';
      tooltipEl.style.opacity = 1;
    }
  };

  function endDrag(e){
    if(!dragging) return;
    dragging = false;
    const mx = e ? clientXToCanvas(e) : dragCurX;
    const x0 = dragStartX, x1 = Math.max(padL, Math.min(cssW - padR, mx));
    dragStartX = null;
    dragCurX = null;
    const pxSpan = Math.abs(x1 - x0);
    // Require a meaningful drag (~12px) and at least 2 points in the window
    if(enableZoom && pxSpan >= 12 && n >= 2){
      let i0 = idxAtX(Math.min(x0, x1));
      let i1 = idxAtX(Math.max(x0, x1));
      if(i1 < i0){ const t = i0; i0 = i1; i1 = t; }
      if(i1 > i0){
        // Map view-relative indices back to absolute full-series indices
        opts.onZoom(viewFrom + i0, viewFrom + i1);
        return;
      }
    }
    paintChart();
  }

  canvas.onmouseup = endDrag;
  canvas.onmouseleave = function(e){
    if(dragging) endDrag(e);
    if(tooltipEl) tooltipEl.style.opacity = 0;
  };
}

function formatValue(v, units){
  let out;
  if(Math.abs(v) >= 1e9) out = (v/1e9).toFixed(2)+'G';
  else if(Math.abs(v) >= 1e6) out = (v/1e6).toFixed(2)+'M';
  else if(Math.abs(v) >= 1e3) out = (v/1e3).toFixed(2)+'k';
  else out = v < 10 ? v.toFixed(2) : v.toFixed(1);
  return units ? out+units : out;
}

