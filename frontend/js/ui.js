/**
 * ui.js — toasts, modals, command palette, drawer, theme icons, recents, pins helpers
 * Loaded as classic script (global scope). Order matters — see index.html.
 */


const ICON_SUN = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="4.5" stroke="currentColor" stroke-width="1.8"/><path d="M12 2.5v2.4M12 19.1v2.4M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const ICON_MOON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';

function escHtml(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
  });
}

// ---------- Toasts ----------
function showToast(message, opts){
  opts = opts || {};
  const stack = document.getElementById('toastStack');
  if(!stack){ return; }
  const el = document.createElement('div');
  el.className = 'toast' + (opts.type ? ' ' + opts.type : '');
  el.innerHTML = '<span class="toast-msg"></span><button type="button" class="toast-close" aria-label="Dismiss">&times;</button>';
  el.querySelector('.toast-msg').textContent = message;
  stack.appendChild(el);
  const remove = function(){
    el.classList.add('leaving');
    setTimeout(function(){ el.remove(); }, 180);
  };
  el.querySelector('.toast-close').addEventListener('click', remove);
  setTimeout(remove, opts.duration || 4200);
}

// ---------- Confirm modal (replaces window.confirm) ----------
let _confirmEl = null;
function ensureConfirmEl(){
  if(_confirmEl) return _confirmEl;
  const el = document.createElement('div');
  el.className = 'modal-backdrop';
  el.innerHTML =
    '<div class="modal">'+
      '<h3 id="confirmTitle">Are you sure?</h3>'+
      '<p id="confirmMsg"></p>'+
      '<div class="row">'+
        '<button class="btn btn-ghost" type="button" id="confirmCancel">Cancel</button>'+
        '<button class="btn btn-primary" type="button" id="confirmOk" style="background:var(--danger);color:#fff;">Confirm</button>'+
      '</div>'+
    '</div>';
  document.body.appendChild(el);
  _confirmEl = el;
  return el;
}
function confirmModal(message, opts){
  opts = opts || {};
  const el = ensureConfirmEl();
  el.querySelector('#confirmTitle').textContent = opts.title || 'Are you sure?';
  el.querySelector('#confirmMsg').textContent = message || '';
  const okBtn = el.querySelector('#confirmOk');
  okBtn.textContent = opts.okLabel || 'Delete';
  return new Promise(function(resolve){
    function cleanup(result){
      el.classList.remove('show');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    }
    function onOk(){ cleanup(true); }
    function onCancel(){ cleanup(false); }
    const cancelBtn = el.querySelector('#confirmCancel');
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    el.classList.add('show');
  });
}

// ---------- Text-input modal (replaces window.prompt) ----------
let _promptEl = null;
function ensurePromptEl(){
  if(_promptEl) return _promptEl;
  const el = document.createElement('div');
  el.className = 'modal-backdrop';
  el.innerHTML =
    '<div class="modal">'+
      '<h3 id="promptTitle">Name</h3>'+
      '<p id="promptMsg" style="display:none;"></p>'+
      '<form id="promptForm"><input type="text" id="promptInput" autocomplete="off">'+
      '<div class="row" style="margin-top:12px;">'+
        '<button class="btn btn-ghost" type="button" id="promptCancel">Cancel</button>'+
        '<button class="btn btn-primary" type="submit" id="promptOk">Save</button>'+
      '</div></form>'+
    '</div>';
  document.body.appendChild(el);
  _promptEl = el;
  return el;
}
function promptModal(message, defaultValue, opts){
  opts = opts || {};
  const el = ensurePromptEl();
  el.querySelector('#promptTitle').textContent = opts.title || 'Name';
  const msgEl = el.querySelector('#promptMsg');
  if(message){ msgEl.textContent = message; msgEl.style.display = ''; } else { msgEl.style.display = 'none'; }
  const input = el.querySelector('#promptInput');
  input.value = defaultValue || '';
  el.querySelector('#promptOk').textContent = opts.okLabel || 'Save';
  return new Promise(function(resolve){
    function cleanup(result){
      el.classList.remove('show');
      form.removeEventListener('submit', onSubmit);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    }
    function onSubmit(e){ e.preventDefault(); cleanup(input.value.trim() || null); }
    function onCancel(){ cleanup(null); }
    const form = el.querySelector('#promptForm');
    const cancelBtn = el.querySelector('#promptCancel');
    form.addEventListener('submit', onSubmit);
    cancelBtn.addEventListener('click', onCancel);
    el.classList.add('show');
    setTimeout(function(){ input.focus(); input.select(); }, 30);
  });
}

// ---------- Template picker modal (replaces window.prompt for "New dashboard") ----------
let _tplEl = null;
function ensureTplEl(){
  if(_tplEl) return _tplEl;
  const el = document.createElement('div');
  el.className = 'modal-backdrop';
  el.innerHTML =
    '<div class="modal" style="width:min(460px,92vw);">'+
      '<h3>New dashboard</h3>'+
      '<p>Start blank, or from a template you can adjust before saving.</p>'+
      '<div class="tpl-list" id="tplList"></div>'+
      '<div class="row"><button class="btn btn-ghost" type="button" id="tplCancel">Cancel</button></div>'+
    '</div>';
  document.body.appendChild(el);
  _tplEl = el;
  return el;
}
function pickTemplateModal(templates){
  const el = ensureTplEl();
  const list = el.querySelector('#tplList');
  list.innerHTML = '<button type="button" class="tpl-item" data-idx="-1">'+
      '<span class="tpl-name">Blank dashboard</span>'+
      '<span class="tpl-desc">Pick hosts and columns yourself</span></button>'+
    templates.map(function(t, i){
      const cols = (t.columns||[]).map(function(c){ return c.label; }).join(', ');
      return '<button type="button" class="tpl-item" data-idx="'+i+'">'+
        '<span class="tpl-name">'+escHtml(t.name)+'</span>'+
        '<span class="tpl-desc">'+escHtml(cols)+'</span></button>';
    }).join('');
  return new Promise(function(resolve){
    function cleanup(result){
      el.classList.remove('show');
      list.removeEventListener('click', onClick);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    }
    function onClick(e){
      const btn = e.target.closest('.tpl-item');
      if(!btn) return;
      const idx = parseInt(btn.dataset.idx, 10);
      cleanup(idx >= 0 ? templates[idx] : null);
    }
    function onCancel(){ cleanup(undefined); }
    const cancelBtn = el.querySelector('#tplCancel');
    list.addEventListener('click', onClick);
    cancelBtn.addEventListener('click', onCancel);
    el.classList.add('show');
  });
}

// ---------- API docs viewer (backend already exposes /api/docs) ----------
let _docsEl = null;
function ensureDocsEl(){
  if(_docsEl) return _docsEl;
  const el = document.createElement('div');
  el.className = 'modal-backdrop docs-modal';
  el.innerHTML = '<div class="modal"><h3>API endpoints</h3><div id="docsBody"><p>Loading…</p></div>'+
    '<div class="row" style="margin-top:14px;"><button class="btn btn-ghost" type="button" id="docsClose">Close</button></div></div>';
  document.body.appendChild(el);
  el.querySelector('#docsClose').addEventListener('click', function(){ el.classList.remove('show'); });
  el.addEventListener('click', function(e){ if(e.target === el) el.classList.remove('show'); });
  _docsEl = el;
  return el;
}
async function showApiDocsModal(){
  const el = ensureDocsEl();
  el.classList.add('show');
  const body = el.querySelector('#docsBody');
  try{
    const res = await apiFetch('/api/docs');
    const data = await res.json();
    body.innerHTML = '<p style="color:var(--text-dim);font-size:12.5px;">Version '+escHtml(data.version)+'</p>'+
      '<table><thead><tr><th>Method</th><th>Path</th><th>Description</th></tr></thead><tbody>'+
      data.endpoints.map(function(e){
        return '<tr><td><code>'+escHtml(e.method)+'</code></td><td><code>'+escHtml(e.path)+'</code></td><td>'+escHtml(e.desc)+'</td></tr>';
      }).join('')+
      '</tbody></table>';
  }catch(err){
    body.innerHTML = '<p>Failed to load: '+(err.message||err)+'</p>';
  }
}

// ---------- Recently viewed (client convenience only; scoped per Zabbix account) ----------
function _recentKey(kind){
  const uid = (currentUser && currentUser.userid) || 'anon';
  return 'zr_recent_'+kind+'_'+uid;
}
function pushRecent(kind, id, name){
  try{
    const key = _recentKey(kind);
    let list = JSON.parse(localStorage.getItem(key) || '[]');
    list = list.filter(function(x){ return x.id !== id; });
    list.unshift({ id: id, name: name, t: Date.now() });
    localStorage.setItem(key, JSON.stringify(list.slice(0, 6)));
  }catch(e){ /* localStorage unavailable — non-critical */ }
}
function getRecents(kind){
  try{ return JSON.parse(localStorage.getItem(_recentKey(kind)) || '[]'); }
  catch(e){ return []; }
}
function recentStripHtml(kind, items, existingIds){
  const valid = items.filter(function(r){ return existingIds.has(r.id); });
  if(!valid.length) return '';
  return '<div class="recent-strip">'+valid.map(function(r){
    return '<button type="button" class="recent-chip" data-recent-id="'+r.id+'">'+
      '<svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M12 7v5l3.5 2M21 12a9 9 0 11-9-9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'+
      escHtml(r.name||'Untitled')+'</button>';
  }).join('')+'</div>';
}

// ---------- Pins (server-side, per user — see /api/pins) ----------
let _pinsCache = null; // { dashboard: [ids], problem_dashboard: [ids] }
async function loadPins(force){
  if(_pinsCache && !force) return _pinsCache;
  try{
    const res = await apiFetch('/api/pins');
    _pinsCache = res.ok ? await res.json() : { dashboard: [], problem_dashboard: [] };
  }catch(e){
    _pinsCache = { dashboard: [], problem_dashboard: [] };
  }
  return _pinsCache;
}
function isPinned(itemType, id){
  return !!(_pinsCache && (_pinsCache[itemType]||[]).indexOf(id) !== -1);
}
async function togglePin(itemType, id, currentlyPinned, onDone){
  try{
    const res = await apiFetch('/api/pins', {
      method: 'POST',
      body: JSON.stringify({ item_type: itemType, item_id: id, pinned: !currentlyPinned }),
    });
    if(!res.ok) throw new Error('HTTP '+res.status);
    await loadPins(true);
    if(onDone) onDone();
  }catch(err){
    showToast('Failed to update pin: '+(err.message||err), { type: 'warn' });
  }
}

// ---------- Command palette ----------
const cmdk = { open: false, items: [], active: 0 };
let _cmdkEl = null;
function ensureCmdkEl(){
  if(_cmdkEl) return _cmdkEl;
  const el = document.createElement('div');
  el.className = 'cmdk-backdrop';
  el.id = 'cmdkBackdrop';
  el.innerHTML =
    '<div class="cmdk">'+
      '<input class="cmdk-input" id="cmdkInput" placeholder="Jump to a dashboard or action…" autocomplete="off">'+
      '<div class="cmdk-list" id="cmdkList"></div>'+
    '</div>';
  document.body.appendChild(el);
  el.addEventListener('click', function(e){ if(e.target === el) closeCommandPalette(); });
  el.querySelector('#cmdkInput').addEventListener('input', function(e){ renderCmdkResults(e.target.value); });
  el.querySelector('#cmdkInput').addEventListener('keydown', function(e){
    if(e.key === 'ArrowDown'){ e.preventDefault(); moveCmdkActive(1); }
    else if(e.key === 'ArrowUp'){ e.preventDefault(); moveCmdkActive(-1); }
    else if(e.key === 'Enter'){ e.preventDefault(); runCmdkActive(); }
  });
  _cmdkEl = el;
  return el;
}

function clickNavTab(nav){
  const btn = document.querySelector('#navTabs button[data-nav="'+nav+'"]');
  if(btn) btn.click();
}

async function buildCmdkItems(){
  const items = [
    { title: 'Go to Metrics', sub: 'Dashboards & quick view', group: 'Navigate', run: function(){ clickNavTab('dashboards'); } },
    { title: 'Go to Problems', sub: 'Open problems & saved views', group: 'Navigate', run: function(){ clickNavTab('problems'); } },
    { title: 'Toggle theme', sub: uiPrefs.theme === 'light' ? 'Switch to dark' : 'Switch to light', group: 'Actions', run: toggleTheme },
    { title: 'Toggle compact tables', sub: uiPrefs.density === 'compact' ? 'Switch to comfortable' : 'Switch to compact', group: 'Actions', run: function(){ uiPrefs.density = uiPrefs.density === 'compact' ? 'comfortable' : 'compact'; localStorage.setItem('zr_density', uiPrefs.density); applyUiPrefs(); } },
    { title: 'API endpoints', sub: 'View backend routes (/api/docs)', group: 'Actions', run: showApiDocsModal },
  ];
  if(canManage()){
    items.push({ title: 'New metrics dashboard', sub: 'Blank or from a template', group: 'Actions', run: function(){ clickNavTab('dashboards'); const c = document.getElementById('newDashCard'); if(c) c.click(); } });
    items.push({ title: 'New problem view', sub: 'Save a host/group + severity scope', group: 'Actions', run: function(){ clickNavTab('problems'); const c = document.getElementById('newProbDashCard'); if(c) c.click(); } });
  }
  try{
    const res = await apiFetch('/api/dashboards');
    if(res.ok){
      (await res.json()).forEach(function(d){
        items.push({ title: d.name || 'Untitled', sub: 'Metrics dashboard'+(isPinned('dashboard', d.id)?' · pinned':''), group: 'Metrics dashboards', run: function(){ clickNavTab('dashboards'); openRun(d.id); } });
      });
    }
  }catch(e){ /* ignore */ }
  try{
    const res = await apiFetch('/api/problem-dashboards');
    if(res.ok){
      (await res.json()).forEach(function(d){
        items.push({ title: d.name || 'Untitled', sub: 'Problem view'+(isPinned('problem_dashboard', d.id)?' · pinned':''), group: 'Problem views', run: function(){ clickNavTab('problems'); openProblemRun(d.id); } });
      });
    }
  }catch(e){ /* ignore */ }
  return items;
}

let _cmdkAllItems = [];
async function openCommandPalette(){
  const el = ensureCmdkEl();
  cmdk.open = true;
  el.classList.add('show');
  const input = el.querySelector('#cmdkInput');
  input.value = '';
  input.focus();
  el.querySelector('#cmdkList').innerHTML = '<div class="cmdk-empty">Loading…</div>';
  await loadPins();
  _cmdkAllItems = await buildCmdkItems();
  renderCmdkResults('');
}
function closeCommandPalette(){
  cmdk.open = false;
  if(_cmdkEl) _cmdkEl.classList.remove('show');
}
function renderCmdkResults(filter){
  const f = (filter||'').trim().toLowerCase();
  const filtered = !f ? _cmdkAllItems : _cmdkAllItems.filter(function(it){
    return (it.title||'').toLowerCase().includes(f) || (it.sub||'').toLowerCase().includes(f) || (it.group||'').toLowerCase().includes(f);
  });
  cmdk.items = filtered;
  cmdk.active = 0;
  const list = document.getElementById('cmdkList');
  if(!filtered.length){ list.innerHTML = '<div class="cmdk-empty">No matches.</div>'; return; }
  let lastGroup = null;
  let html = '';
  filtered.forEach(function(it, idx){
    if(it.group !== lastGroup){ html += '<div class="cmdk-group-label">'+it.group+'</div>'; lastGroup = it.group; }
    html += '<div class="cmdk-item'+(idx===0?' active':'')+'" data-idx="'+idx+'">'+
      '<span class="cmdk-icon"><svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M9 18l6-6-6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>'+
      '<span class="cmdk-main"><div class="cmdk-title">'+escHtml(it.title)+'</div>'+(it.sub?'<div class="cmdk-sub">'+escHtml(it.sub)+'</div>':'')+'</span>'+
    '</div>';
  });
  list.innerHTML = html;
  list.querySelectorAll('.cmdk-item').forEach(function(row){
    row.addEventListener('mouseenter', function(){ setCmdkActive(parseInt(row.dataset.idx,10)); });
    row.addEventListener('click', function(){ cmdk.active = parseInt(row.dataset.idx,10); runCmdkActive(); });
  });
}
function setCmdkActive(idx){
  cmdk.active = idx;
  document.querySelectorAll('#cmdkList .cmdk-item').forEach(function(row){
    row.classList.toggle('active', parseInt(row.dataset.idx,10) === idx);
  });
  const activeEl = document.querySelector('#cmdkList .cmdk-item.active');
  if(activeEl) activeEl.scrollIntoView({ block: 'nearest' });
}
function moveCmdkActive(delta){
  if(!cmdk.items.length) return;
  let next = cmdk.active + delta;
  if(next < 0) next = cmdk.items.length - 1;
  if(next >= cmdk.items.length) next = 0;
  setCmdkActive(next);
}
function runCmdkActive(){
  const item = cmdk.items[cmdk.active];
  if(!item) return;
  closeCommandPalette();
  try{ item.run(); }catch(e){ console.error(e); }
}

// ---------- Pivot cell drill-down chart ----------
async function openPivotCellDrilldown(opts){
  // opts: { itemid, host, colLabel, unit, dateFrom, dateTo, resolution, multiplier, thresholds, day_time_from, day_time_to }
  // Clear previous resize handler if any
  if(window._ddChartResizeHandler){
    window.removeEventListener('resize', window._ddChartResizeHandler);
    window._ddChartResizeHandler = null;
  }
  openDrawer(opts.colLabel + ' — ' + opts.host,
    '<div class="drawer-chart-stats" id="ddStats"><span class="stat">Loading…</span></div>'+
    '<div class="chart-wrap chart-wrap-dd"><canvas class="chart" id="ddChart" height="220"></canvas><div class="tooltip" id="ddTooltip"></div></div>'+
    '<div class="dd-zoom-bar">'+
      '<p class="dd-zoom-hint" id="ddZoomHint">Drag to zoom · <kbd>+</kbd>/<kbd>-</kbd> zoom · <kbd>0</kbd> reset · <kbd>Esc</kbd> close</p>'+
      '<p class="dd-zoom-range" id="ddZoomRange" hidden></p>'+
    '</div>'+
    '<div class="drawer-actions">'+
      '<button type="button" class="btn btn-ghost" id="ddResetZoomBtn" title="Show full time range (0)" style="display:none;">Reset zoom</button>'+
      '<button type="button" class="btn btn-ghost" id="ddMaxBtn" title="Expand chart to full page width">Maximize</button>'+
      '<button type="button" class="btn btn-ghost" id="ddCopyLinkBtn" title="Copy a link that reopens this series">Copy link</button>'+
      '<button type="button" class="btn btn-ghost" id="ddPngBtn" disabled>Export chart PNG</button>'+
    '</div>');
  try{
    const res = await apiFetch('/api/items/series', {
      method: 'POST',
      timeoutMs: 30000,
      body: JSON.stringify({
        itemids: [opts.itemid],
        date_from: opts.dateFrom,
        date_to: opts.dateTo,
        resolution: opts.resolution || 'auto',
        day_time_from: opts.day_time_from || null,
        day_time_to: opts.day_time_to || null,
        tz_offset_min: apiTzOffsetMin(),
      }),
    });
    if(!res.ok){
      const err = await res.json().catch(function(){ return {}; });
      throw new Error(err.detail || ('HTTP '+res.status));
    }
    const data = await res.json();
    const s = (data.series||[])[0];
    const statsEl = document.getElementById('ddStats');
    if(!statsEl) return; // drawer closed before fetch resolved
    if(!s || !s.points || !s.points.length){
      statsEl.innerHTML = '<span class="stat">No data points in this range'+
        ((data.series||[]).length === 0 && (data.warnings||[]).length ? ' (or you no longer have access to this host).' : '.')+'</span>';
      return;
    }
    const mult = (typeof opts.multiplier === 'number' && !isNaN(opts.multiplier)) ? opts.multiplier : 1;
    const rawNums = s.points.map(function(p){
      const v = typeof p.value === 'number' ? p.value : p.avg;
      return typeof v === 'number' ? v * mult : null;
    }).filter(function(v){ return typeof v === 'number'; });
    const min = rawNums.length ? Math.min.apply(null, rawNums) : null;
    const max = rawNums.length ? Math.max.apply(null, rawNums) : null;
    const avg = rawNums.length ? rawNums.reduce(function(a,b){ return a+b; },0)/rawNums.length : null;
    const unit = opts.unit || s.units || '';
    statsEl.innerHTML =
      '<div class="stat">Min<b>'+(min!=null?formatValue(min,unit):'—')+'</b></div>'+
      '<div class="stat">Avg<b>'+(avg!=null?formatValue(avg,unit):'—')+'</b></div>'+
      '<div class="stat">Max<b>'+(max!=null?formatValue(max,unit):'—')+'</b></div>'+
      '<div class="stat">Source<b style="text-transform:capitalize;">'+s.source+'</b></div>'+
      '<div class="stat">Points<b>'+s.points.length+'</b></div>';
    const canvas = document.getElementById('ddChart');
    const tooltip = document.getElementById('ddTooltip');
    if(canvas && tooltip){
      const labels = s.points.map(function(p){ return fmtTimeShort(p.clock); });
      const values = s.points.map(function(p){
        const v = typeof p.value === 'number' ? p.value : p.avg;
        return typeof v === 'number' ? v * mult : null;
      });
      const chartOptsBase = {
        labels: labels,
        datasets: [{ label: opts.colLabel, data: values, color: '#3FC9C9', fill: true }],
        showLegend: false,
        valueFmt: function(v){ return formatValue(v, unit); },
        thresholds: opts.thresholds || null,
      };
      // Zoom window into the full series (absolute indices)
      let zoomFrom = 0;
      let zoomTo = labels.length - 1;
      function isZoomed(){
        return zoomFrom > 0 || zoomTo < labels.length - 1;
      }
      function updateZoomUi(){
        const resetBtn = document.getElementById('ddResetZoomBtn');
        const hint = document.getElementById('ddZoomHint');
        const rangeEl = document.getElementById('ddZoomRange');
        if(resetBtn) resetBtn.style.display = isZoomed() ? '' : 'none';
        if(hint){
          hint.innerHTML = isZoomed()
            ? 'Zoomed · drag again · <kbd>+</kbd>/<kbd>-</kbd> · <kbd>0</kbd> reset · <kbd>Esc</kbd>'
            : 'Drag to zoom · <kbd>+</kbd>/<kbd>-</kbd> zoom · <kbd>0</kbd> reset · <kbd>Esc</kbd> close';
        }
        if(rangeEl){
          if(isZoomed() && labels[zoomFrom] != null && labels[zoomTo] != null){
            rangeEl.hidden = false;
            rangeEl.textContent = 'Showing ' + labels[zoomFrom] + ' → ' + labels[zoomTo] +
              '  (' + (zoomTo - zoomFrom + 1) + ' of ' + labels.length + ' points)';
          } else {
            rangeEl.hidden = true;
            rangeEl.textContent = '';
          }
        }
        // Stats reflect the visible window
        const vis = values.slice(zoomFrom, zoomTo + 1).filter(function(v){ return typeof v === 'number'; });
        const vmin = vis.length ? Math.min.apply(null, vis) : null;
        const vmax = vis.length ? Math.max.apply(null, vis) : null;
        const vavg = vis.length ? vis.reduce(function(a,b){ return a+b; },0)/vis.length : null;
        const se = document.getElementById('ddStats');
        if(se){
          se.innerHTML =
            '<div class="stat">Min<b>'+(vmin!=null?formatValue(vmin,unit):'—')+'</b></div>'+
            '<div class="stat">Avg<b>'+(vavg!=null?formatValue(vavg,unit):'—')+'</b></div>'+
            '<div class="stat">Max<b>'+(vmax!=null?formatValue(vmax,unit):'—')+'</b></div>'+
            '<div class="stat">Source<b style="text-transform:capitalize;">'+s.source+'</b></div>'+
            '<div class="stat">Points<b>'+vis.length+(isZoomed()?' / '+values.length:'')+'</b></div>';
        }
      }
      function chartHeight(){
        const drawer = document.getElementById('detailDrawer');
        const maximized = drawer && drawer.classList.contains('drawer-maximized');
        if(!maximized) return 230;
        const avail = Math.max(320, (window.innerHeight || 700) - 220);
        return Math.min(avail, 720);
      }
      function redrawChart(){
        const c = document.getElementById('ddChart');
        const t = document.getElementById('ddTooltip');
        if(!c || !t) return;
        drawLineChart(c, t, Object.assign({}, chartOptsBase, {
          height: chartHeight(),
          viewFrom: zoomFrom,
          viewTo: zoomTo,
          onZoom: function(absFrom, absTo){
            if(absTo <= absFrom) return;
            zoomFrom = absFrom;
            zoomTo = absTo;
            updateZoomUi();
            redrawChart();
          },
        }));
      }
      function resetZoom(){
        zoomFrom = 0;
        zoomTo = labels.length - 1;
        updateZoomUi();
        redrawChart();
      }
      /** Zoom toward center of current window. factor < 1 = in, > 1 = out. */
      function zoomByFactor(factor){
        const n = labels.length;
        if(n < 4) return;
        const span = zoomTo - zoomFrom;
        if(factor < 1 && span < 3) return;
        const mid = (zoomFrom + zoomTo) / 2;
        let newSpan = Math.max(3, Math.round(span * factor));
        newSpan = Math.min(newSpan, n - 1);
        let from = Math.round(mid - newSpan / 2);
        let to = from + newSpan;
        if(from < 0){ from = 0; to = newSpan; }
        if(to > n - 1){ to = n - 1; from = Math.max(0, to - newSpan); }
        zoomFrom = from;
        zoomTo = to;
        updateZoomUi();
        redrawChart();
      }
      function setMaximized(on){
        const drawer = document.getElementById('detailDrawer');
        const maxBtn = document.getElementById('ddMaxBtn');
        if(!drawer) return;
        drawer.classList.toggle('drawer-maximized', !!on);
        if(maxBtn){
          maxBtn.textContent = on ? 'Restore' : 'Maximize';
          maxBtn.title = on ? 'Restore drawer size (Esc)' : 'Expand chart to full page width';
          maxBtn.classList.toggle('is-active', !!on);
        }
        setTimeout(redrawChart, 240);
      }
      requestAnimationFrame(function(){ updateZoomUi(); redrawChart(); });

      const resetZoomBtn = document.getElementById('ddResetZoomBtn');
      if(resetZoomBtn) resetZoomBtn.addEventListener('click', resetZoom);

      const maxBtn = document.getElementById('ddMaxBtn');
      if(maxBtn){
        maxBtn.addEventListener('click', function(){
          const drawer = document.getElementById('detailDrawer');
          if(!drawer) return;
          setMaximized(!drawer.classList.contains('drawer-maximized'));
        });
      }

      // Copy shareable deep-link for this series
      const copyLinkBtn = document.getElementById('ddCopyLinkBtn');
      if(copyLinkBtn){
        copyLinkBtn.addEventListener('click', function(){
          try{
            const u = new URL(location.href);
            u.searchParams.set('drill_item', String(opts.itemid));
            u.searchParams.set('drill_from', String(opts.dateFrom));
            u.searchParams.set('drill_to', String(opts.dateTo));
            u.searchParams.set('drill_host', opts.host || '');
            u.searchParams.set('drill_col', opts.colLabel || '');
            if(opts.day_time_from) u.searchParams.set('drill_hf', opts.day_time_from);
            else u.searchParams.delete('drill_hf');
            if(opts.day_time_to) u.searchParams.set('drill_ht', opts.day_time_to);
            else u.searchParams.delete('drill_ht');
            if(opts.unit) u.searchParams.set('drill_unit', opts.unit);
            else u.searchParams.delete('drill_unit');
            const link = u.toString();
            navigator.clipboard.writeText(link).then(function(){
              showToast('Link copied — opens this series when pasted.', { type: 'success' });
            }).catch(function(){
              promptModal('Copy this link:', link, { title: 'Series link' });
            });
          }catch(err){
            showToast('Could not build link: '+(err.message||err), { type: 'warn' });
          }
        });
      }

      // Keyboard: Esc cascade, +/- zoom, 0 reset
      function onDdKey(e){
        const tag = (e.target && e.target.tagName) || '';
        const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
        if(typing) return;

        if(e.key === 'Escape'){
          if(isZoomed()){
            e.preventDefault();
            e.stopPropagation();
            resetZoom();
            return;
          }
          const drawer = document.getElementById('detailDrawer');
          if(drawer && drawer.classList.contains('drawer-maximized')){
            e.preventDefault();
            e.stopPropagation();
            setMaximized(false);
            return;
          }
          // Let global Esc handler close the drawer
          return;
        }
        if(e.key === '0' || e.key === 'Digit0'){
          if(isZoomed()){ e.preventDefault(); resetZoom(); }
          return;
        }
        if(e.key === '+' || e.key === '=' || e.key === 'Add'){
          e.preventDefault();
          zoomByFactor(0.5);
          return;
        }
        if(e.key === '-' || e.key === '_' || e.key === 'Subtract'){
          e.preventDefault();
          zoomByFactor(2);
          return;
        }
      }
      // Ctrl/Cmd + wheel over chart → zoom
      function onDdWheel(e){
        const c = document.getElementById('ddChart');
        if(!c || !c.contains(e.target) && e.target !== c) return;
        if(!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        zoomByFactor(e.deltaY > 0 ? 1.25 : 0.8);
      }
      document.addEventListener('keydown', onDdKey);
      document.addEventListener('wheel', onDdWheel, { passive: false });
      window._ddChartResizeHandler = function(){
        const drawer = document.getElementById('detailDrawer');
        if(!drawer || !drawer.classList.contains('show')) return;
        redrawChart();
      };
      window.addEventListener('resize', window._ddChartResizeHandler);
      const _prevClose = window._ddChartEscCleanup;
      window._ddChartEscCleanup = function(){
        document.removeEventListener('keydown', onDdKey);
        document.removeEventListener('wheel', onDdWheel);
        if(typeof _prevClose === 'function') try{ _prevClose(); }catch(_){}
      };

      const pngBtn = document.getElementById('ddPngBtn');
      if(pngBtn){
        pngBtn.disabled = false;
        pngBtn.addEventListener('click', function(){
          const a = document.createElement('a');
          a.href = canvas.toDataURL('image/png');
          a.download = (opts.colLabel+'-'+opts.host).replace(/[^a-z0-9]+/gi,'_')+'.png';
          a.click();
        });
      }
    }
  }catch(err){
    const statsEl = document.getElementById('ddStats');
    if(statsEl) statsEl.innerHTML = '<span class="stat" style="color:var(--danger);">'+(err.message||err)+'</span>';
  }
}

// ---------- Period-over-period delta ----------
function deltaBadgeHtml(current, previous, goodWhenDown){
  if(typeof current !== 'number' || typeof previous !== 'number') return '';
  if(previous === 0){
    // Avoid divide-by-zero; still show direction if current moved
    if(current === 0) return '';
    const dir0 = current > 0 ? 'up' : 'down';
    const base0 = goodWhenDown ? 'delta' : 'delta-good';
    return '<span class="'+base0+' '+dir0+'">'+(dir0==='up'?'▲':'▼')+'</span>';
  }
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  if(!isFinite(pct)) return '';
  const dir = pct > 0.5 ? 'up' : (pct < -0.5 ? 'down' : 'flat');
  // goodWhenDown=true  (CPU, latency): increase is bad → .delta (up red / down green)
  // goodWhenDown=false (availability):  increase is good → .delta-good (up green / down red)
  const base = goodWhenDown ? 'delta' : 'delta-good';
  const cls = base + ' ' + dir;
  const arrow = dir === 'up' ? '▲' : (dir === 'down' ? '▼' : '·');
  return '<span class="'+cls+'">'+arrow+' '+Math.abs(pct).toFixed(0)+'%</span>';
}

// ---------- Problems: severity summary, diagnostics, new-problem tracking ----------
const SEV_LABELS = {0:'Not classified',1:'Information',2:'Warning',3:'Average',4:'High',5:'Disaster'};
function computeSeverityChips(problems){
  if(!problems.length) return '';
  const counts = {};
  problems.forEach(function(p){
    const sev = parseInt(p.severity, 10) || 0;
    counts[sev] = (counts[sev]||0) + 1;
  });
  const order = [5,4,3,2,1,0];
  const chips = order.filter(function(s){ return counts[s]; }).map(function(s){
    const tone = s >= 4 ? 'bad' : (s >= 2 ? 'warn' : 'ok');
    return '<span class="insight-chip '+tone+'" data-sev="'+s+'" title="Click to filter"><b>'+counts[s]+'</b> '+(SEV_LABELS[s]||'Sev '+s)+'</span>';
  });
  return '<div class="insight-strip">'+chips.join('')+
    '<span class="insight-chip" style="opacity:.7">'+problems.length+' total</span></div>';
}

const DIAG_LABELS = {
  problem_table_total_rows: 'Total rows in `problem` table',
  open: 'Open problems (all hosts)',
  closed: 'Closed problems (all hosts)',
  acked: 'Acknowledged problems (all hosts)',
  open_for_hosts: 'Open problems for the selected host(s)',
  open_for_group: 'Open problems for the selected group',
};
function renderDiagPanel(dbg){
  const rows = Object.keys(dbg).map(function(k){
    return '<tr><td>'+(DIAG_LABELS[k]||k)+'</td><td style="text-align:right;font-family:var(--mono);">'+dbg[k]+'</td></tr>';
  }).join('');
  return '<div class="diag-panel">'+
    '<h5>Why is this empty?</h5>'+
    '<p style="margin:0 0 10px;">Counts straight from the Zabbix DB (not limited by your current status/severity filters). Use these to tell &ldquo;no problems match my filter&rdquo; apart from &ldquo;the feed itself is empty&rdquo;.</p>'+
    '<table>'+rows+'</table>'+
    '<p style="margin:10px 0 0;font-size:11.5px;color:var(--text-faint);">Tip: try lowering min severity, switching status to <em>All</em>, or clearing the host filter.</p>'+
    '</div>';
}

const _probEventTracker = {};
function trackNewProblems(key, problems){
  const currentIds = new Set(problems.map(function(p){ return String(p.eventid); }));
  const prevIds = _probEventTracker[key];
  _probEventTracker[key] = currentIds;
  if(!prevIds) return; // first load for this view — nothing to compare against yet
  let newCount = 0;
  currentIds.forEach(function(id){ if(!prevIds.has(id)) newCount++; });
  if(newCount > 0){
    showToast(newCount + ' new problem'+(newCount===1?'':'s')+' since last refresh.', { type: 'warn' });
  }
}



