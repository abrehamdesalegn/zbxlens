/**
 * utils.js — UI prefs, theme/density, table tools, export, date presets, share links, boot()
 * Loaded as classic script (global scope). Order matters — see index.html.
 */

const uiPrefs = {
  theme: localStorage.getItem('zr_theme') || 'dark',       // dark | light | auto
  font: localStorage.getItem('zr_font') || 'md',           // sm | md | lg
  density: localStorage.getItem('zr_density') || 'compact', // compact | comfortable
};

function resolveTheme(){
  if(uiPrefs.theme === 'light') return 'light';
  if(uiPrefs.theme === 'dark') return 'dark';
  try{
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }catch(e){ return 'dark'; }
}

function applyUiPrefs(){
  const density = uiPrefs.density === 'comfortable' ? 'comfortable' : 'compact';
  document.body.classList.toggle('density-compact', density === 'compact');
  document.body.classList.toggle('density-comfortable', density === 'comfortable');
  document.body.setAttribute('data-density', density);

  const resolved = resolveTheme();
  document.body.setAttribute('data-theme', resolved);
  document.documentElement.setAttribute('data-theme', resolved);
  // Color-scheme helps native form controls match
  document.documentElement.style.colorScheme = resolved === 'light' ? 'light' : 'dark';

  const font = (uiPrefs.font === 'sm' || uiPrefs.font === 'lg') ? uiPrefs.font : 'md';
  document.body.setAttribute('data-font', font);
  document.documentElement.setAttribute('data-font', font);

  const btn = document.getElementById('themeBtn');
  if(btn){
    btn.innerHTML = resolved === 'light' ? ICON_MOON : ICON_SUN;
    btn.title = 'Theme: ' + uiPrefs.theme + (uiPrefs.theme === 'auto' ? ' ('+resolved+')' : '') + ' — click to cycle';
    btn.setAttribute('aria-label', 'Theme '+uiPrefs.theme);
  }
  const th = document.getElementById('prefTheme');
  const ft = document.getElementById('prefFont');
  const dn = document.getElementById('prefDensity');
  if(th) th.value = uiPrefs.theme;
  if(ft) ft.value = uiPrefs.font;
  if(dn) dn.value = density;
  // Sync segmented theme buttons if present
  document.querySelectorAll('[data-pref-theme]').forEach(function(b){
    b.classList.toggle('is-active', b.getAttribute('data-pref-theme') === uiPrefs.theme);
  });
  document.querySelectorAll('[data-pref-density]').forEach(function(b){
    b.classList.toggle('is-active', b.getAttribute('data-pref-density') === density);
  });
}

function toggleTheme(){
  // Cycle: auto → dark → light → auto
  const order = ['auto', 'dark', 'light'];
  const i = order.indexOf(uiPrefs.theme);
  uiPrefs.theme = order[(i < 0 ? 0 : i + 1) % order.length];
  localStorage.setItem('zr_theme', uiPrefs.theme);
  applyUiPrefs();
  showToast('Theme: ' + uiPrefs.theme + (uiPrefs.theme === 'auto' ? ' (follows system)' : ''), { type: 'success' });
}

function setUiPref(key, value){
  uiPrefs[key] = value;
  if(key === 'theme') localStorage.setItem('zr_theme', value);
  if(key === 'font') localStorage.setItem('zr_font', value);
  if(key === 'density') localStorage.setItem('zr_density', value);
  applyUiPrefs();
  if(key === 'theme'){
    showToast('Theme: ' + value + (value === 'auto' ? ' (follows system)' : ''), { type: 'success' });
  }
  if(key === 'density'){
    showToast('Density: ' + (value === 'comfortable' ? 'Comfortable' : 'Compact'), { type: 'success' });
  }
}

// Follow OS theme changes when in auto mode
try{
  if(window.matchMedia){
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function(){
      if(uiPrefs.theme === 'auto') applyUiPrefs();
    });
  }
}catch(e){ /* older browsers */ }

function emptyStateHtml(opts){
  opts = opts || {};
  return '<div class="empty-state" role="status">'+
    '<div class="es-icon">'+(opts.icon || '◇')+'</div>'+
    '<h3>'+escHtml(opts.title || 'Nothing here yet')+'</h3>'+
    '<p>'+escHtml(opts.body || '')+'</p>'+
    (opts.actionsHtml || '')+
  '</div>';
}

/** Skeleton loading block for results panels (table-shaped). */
function loadingStateHtml(message){
  const msg = message || 'Loading…';
  const rows = [0,1,2,3,4,5,6,7].map(function(_, i){
    const hostW = (40 + (i * 7) % 35) + '%';
    return '<div class="sk-tr">'+
      '<span class="sk-line sk-host" style="width:'+hostW+'"></span>'+
      '<span class="sk-line"></span><span class="sk-line"></span>'+
      '<span class="sk-line"></span><span class="sk-line"></span>'+
    '</div>';
  }).join('');
  return '<div class="state-panel state-loading" role="status" aria-live="polite" aria-busy="true">'+
    '<div class="state-loading-head">'+
      '<span class="state-spinner" aria-hidden="true"></span>'+
      '<span class="state-loading-msg">'+escHtml(msg)+'</span>'+
    '</div>'+
    '<div class="state-skeleton" aria-hidden="true">'+
      '<div class="sk-line sk-title"></div>'+
      '<div class="sk-line sk-meta"></div>'+
      '<div class="sk-table">'+
        '<div class="sk-tr sk-head">'+
          '<span class="sk-line"></span><span class="sk-line"></span><span class="sk-line"></span>'+
          '<span class="sk-line"></span><span class="sk-line"></span>'+
        '</div>'+
        rows+
      '</div>'+
    '</div>'+
  '</div>';
}

/** Error panel with optional retry button (wire by id after insert). */
function errorStateHtml(opts){
  opts = opts || {};
  const title = opts.title || 'Something went wrong';
  const body = opts.body || opts.message || '';
  const retryId = opts.retryId || '';
  const retryLabel = opts.retryLabel || 'Try again';
  return '<div class="state-panel state-error" role="alert">'+
    '<div class="state-error-icon" aria-hidden="true">!</div>'+
    '<div class="state-error-body">'+
      '<h3>'+escHtml(title)+'</h3>'+
      (body ? '<p>'+escHtml(body)+'</p>' : '')+
      (retryId
        ? '<div class="es-actions"><button type="button" class="btn btn-primary" id="'+escHtml(retryId)+'">'+escHtml(retryLabel)+'</button></div>'
        : '')+
    '</div>'+
  '</div>';
}

/** Empty results after a successful query (no rows matched). */
function emptyResultHtml(opts){
  opts = opts || {};
  const retryId = opts.retryId || '';
  const actions = opts.actionsHtml || (retryId
    ? '<div class="es-actions"><button type="button" class="btn btn-ghost" id="'+escHtml(retryId)+'">'+escHtml(opts.retryLabel || 'Run again')+'</button></div>'
    : '');
  return emptyStateHtml({
    icon: opts.icon || '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.8"/><path d="M20 20l-3-3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    title: opts.title || 'No results',
    body: opts.body || 'Nothing matched the current filters. Try a wider date range or different hosts.',
    actionsHtml: actions,
  });
}

let _shortcutsEl = null;
function showShortcutsHelp(){
  if(!_shortcutsEl){
    const el = document.createElement('div');
    el.className = 'modal-backdrop';
    el.id = 'shortcutsModal';
    el.innerHTML =
      '<div class="modal" style="width:min(440px,94vw);">'+
        '<h3>Keyboard shortcuts</h3>'+
        '<div class="shortcuts-grid">'+
          '<kbd>Ctrl/⌘ K</kbd><span>Command palette</span>'+
          '<kbd>/</kbd><span>Focus page search / filter</span>'+
          '<kbd>?</kbd><span>Show this help</span>'+
          '<kbd>Esc</kbd><span>Close drawer, modal, or palette</span>'+
          '<kbd>g</kbd> then <kbd>m</kbd><span>Go to Metrics</span>'+
          '<kbd>g</kbd> then <kbd>p</kbd><span>Go to Problems</span>'+
          '<kbd>r</kbd><span>Refresh current run (when available)</span>'+
        '</div>'+
        '<div class="row" style="margin-top:16px;">'+
          '<button class="btn btn-primary" type="button" id="shortcutsOk">Got it</button>'+
        '</div>'+
      '</div>';
    document.body.appendChild(el);
    el.querySelector('#shortcutsOk').addEventListener('click', function(){ el.classList.remove('show'); });
    el.addEventListener('click', function(e){ if(e.target === el) el.classList.remove('show'); });
    _shortcutsEl = el;
  }
  _shortcutsEl.classList.add('show');
  const ok = _shortcutsEl.querySelector('#shortcutsOk');
  if(ok) ok.focus();
}

function setDateRangePreset(fromId, toId, hours){
  const to = Math.floor(Date.now()/1000);
  const from = to - Math.floor(hours * 3600);
  const elFrom = document.getElementById(fromId);
  const elTo = document.getElementById(toId);
  if(elFrom) elFrom.value = fromEpochToLocalInput(from);
  if(elTo) elTo.value = fromEpochToLocalInput(to);
}

function datePresetBar(fromId, toId){
  return '<div class="toolbar-row" data-date-presets="1">'+
    '<span style="font-size:11px;color:var(--text-faint);font-family:var(--mono);">RANGE</span>'+
    [[1,'1h'],[6,'6h'],[24,'24h'],[24*7,'7d'],[24*30,'30d']].map(function(p){
      return '<button type="button" class="chip-btn" data-hours="'+p[0]+'">'+p[1]+'</button>';
    }).join('')+
  '</div>';
}

function wireDatePresets(container, fromId, toId){
  if(!container) return;
  container.querySelectorAll('[data-date-presets] .chip-btn').forEach(function(btn){
    btn.addEventListener('click', function(){
      setDateRangePreset(fromId, toId, parseFloat(btn.dataset.hours));
      container.querySelectorAll('[data-date-presets] .chip-btn').forEach(function(b){ b.classList.remove('active'); });
      btn.classList.add('active');
    });
  });
}

/** Daily time-of-day presets: full day, business hours, or custom. */
function dayHoursPresetBar(fromId, toId, prefix){
  const p = prefix || 'day';
  return '<div class="toolbar-row day-hours-bar" data-day-presets="'+p+'">'+
    '<span style="font-size:11px;color:var(--text-faint);font-family:var(--mono);">HOURS</span>'+
    '<button type="button" class="chip-btn active" data-day-preset="full">24h</button>'+
    '<button type="button" class="chip-btn" data-day-preset="biz">8am–6pm</button>'+
    '<button type="button" class="chip-btn" data-day-preset="custom">Custom</button>'+
    '<span class="day-custom-fields" id="'+p+'CustomFields" style="display:none;gap:6px;align-items:center;">'+
      '<input type="time" id="'+fromId+'" value="08:00" style="width:110px;height:30px;font-size:12px;">'+
      '<span style="color:var(--text-faint);font-size:11px;">–</span>'+
      '<input type="time" id="'+toId+'" value="18:00" style="width:110px;height:30px;font-size:12px;">'+
    '</span>'+
  '</div>';
}

function wireDayHoursPresets(container, prefix){
  if(!container) return;
  const p = prefix || 'day';
  const bar = container.querySelector('[data-day-presets="'+p+'"]');
  if(!bar) return;
  const customWrap = document.getElementById(p+'CustomFields');
  bar.querySelectorAll('[data-day-preset]').forEach(function(btn){
    btn.addEventListener('click', function(){
      bar.querySelectorAll('[data-day-preset]').forEach(function(b){ b.classList.remove('active'); });
      btn.classList.add('active');
      const mode = btn.dataset.dayPreset;
      if(customWrap) customWrap.style.display = mode === 'custom' ? 'inline-flex' : 'none';
      if(mode === 'biz' && customWrap){
        const inputs = customWrap.querySelectorAll('input[type=time]');
        if(inputs[0]) inputs[0].value = '08:00';
        if(inputs[1]) inputs[1].value = '18:00';
      }
    });
  });
}

/** Read day-hour filter from preset bar. Returns {day_time_from, day_time_to} or nulls for full day. */
function readDayHoursPreset(prefix, fromId, toId){
  const p = prefix || 'day';
  const bar = document.querySelector('[data-day-presets="'+p+'"]');
  const active = bar && bar.querySelector('[data-day-preset].active');
  const mode = active ? active.dataset.dayPreset : 'full';
  if(mode === 'full') return { day_time_from: null, day_time_to: null };
  if(mode === 'biz') return { day_time_from: '08:00', day_time_to: '18:00' };
  const fromEl = document.getElementById(fromId);
  const toEl = document.getElementById(toId);
  return {
    day_time_from: (fromEl && fromEl.value) || null,
    day_time_to: (toEl && toEl.value) || null,
  };
}

const refreshTimers = {};
function wireAutoRefresh(key, selectEl, runFn){
  if(refreshTimers[key]){ clearInterval(refreshTimers[key]); delete refreshTimers[key]; }
  if(!selectEl) return;
  const sec = parseInt(selectEl.value, 10) || 0;
  if(sec > 0){
    refreshTimers[key] = setInterval(function(){ runFn(); }, sec * 1000);
  }
  selectEl.onchange = function(){ wireAutoRefresh(key, selectEl, runFn); };
}

/**
 * Make table headers sortable with CSS ↑/↓ indicators (does not mutate label text).
 * Prefer data-sort-col on <th> for multi-row headers; otherwise use visual column index.
 */
function makeTableSortable(table){
  if(!table || table.dataset.sortable === '1') return;
  table.dataset.sortable = '1';
  const ths = Array.prototype.slice.call(table.querySelectorAll('thead th'));

  function visualColIndex(th){
    if(th.dataset.sortCol != null && th.dataset.sortCol !== ''){
      return parseInt(th.dataset.sortCol, 10);
    }
    // Sum colspans of preceding cells in the same row
    let idx = 0;
    const tr = th.parentNode;
    if(!tr) return 0;
    for(let i = 0; i < tr.cells.length; i++){
      if(tr.cells[i] === th) return idx;
      idx += parseInt(tr.cells[i].colSpan, 10) || 1;
    }
    return idx;
  }

  function clearSortState(){
    ths.forEach(function(t){
      delete t.dataset.sortDir;
      t.removeAttribute('aria-sort');
      t.classList.remove('sort-asc', 'sort-desc', 'sort-active');
    });
  }

  ths.forEach(function(th){
    // Group headers (colspan > 1 without data-sort-col) are not sortable
    const colspan = parseInt(th.colSpan, 10) || 1;
    if(colspan > 1 && (th.dataset.sortCol == null || th.dataset.sortCol === '')){
      th.classList.add('sort-group');
      return;
    }
    // Skip checkbox / empty control columns
    if(th.querySelector('input[type=checkbox]') || th.classList.contains('no-sort')){
      return;
    }
    th.classList.add('sortable');
    th.setAttribute('title', 'Click to sort');
    // Clean single caret label (no dual-dot grip icons)
    th.setAttribute('data-sort-indicator', '1');
    th.addEventListener('click', function(ev){
      const tbody = table.tBodies[0];
      if(!tbody) return;
      const colIdx = visualColIndex(th);
      if(isNaN(colIdx) || colIdx < 0) return;
      const rows = Array.prototype.slice.call(tbody.rows);
      const nextDir = th.dataset.sortDir === 'asc' ? 'desc' : 'asc';
      const sortByDelta = !!(ev && (ev.altKey || ev.metaKey));
      clearSortState();
      th.dataset.sortDir = nextDir;
      th.setAttribute('aria-sort', nextDir === 'asc' ? 'ascending' : 'descending');
      th.classList.add('sort-active', nextDir === 'asc' ? 'sort-asc' : 'sort-desc');
      if(sortByDelta) th.title = 'Sorted by delta (Alt+click)'; else th.title = 'Click to sort · Alt+click for delta';

      rows.sort(function(a, b){
        const ca = a.cells[colIdx];
        const cb = b.cells[colIdx];
        // Alt/Meta+click → sort by absolute point delta vs previous period
        if(sortByDelta){
          const dA = ca && ca.dataset && ca.dataset.delta;
          const dB = cb && cb.dataset && cb.dataset.delta;
          const an = dA != null && dA !== '' ? parseFloat(dA) : NaN;
          const bn = dB != null && dB !== '' ? parseFloat(dB) : NaN;
          if(!isNaN(an) || !isNaN(bn)){
            const av = isNaN(an) ? (nextDir==='asc' ? Infinity : -Infinity) : an;
            const bv = isNaN(bn) ? (nextDir==='asc' ? Infinity : -Infinity) : bn;
            return nextDir === 'asc' ? (av - bv) : (bv - av);
          }
        }
        // Prefer data-export-num for metric cells (numeric sort)
        const numA = ca && ca.dataset && ca.dataset.exportNum;
        const numB = cb && cb.dataset && cb.dataset.exportNum;
        if(numA != null && numA !== '' && numB != null && numB !== ''){
          const an = parseFloat(numA), bn = parseFloat(numB);
          if(!isNaN(an) && !isNaN(bn)){
            return nextDir === 'asc' ? (an - bn) : (bn - an);
          }
        }
        const av = (ca && ca.innerText || '').replace(/\s+/g, ' ').trim();
        const bv = (cb && cb.innerText || '').replace(/\s+/g, ' ').trim();
        // Empty / dash last
        const aEmpty = !av || av === '—' || av === '-';
        const bEmpty = !bv || bv === '—' || bv === '-';
        if(aEmpty && bEmpty) return 0;
        if(aEmpty) return 1;
        if(bEmpty) return -1;
        const an = parseFloat(av.replace(/[^0-9.\-]/g, ''));
        const bn = parseFloat(bv.replace(/[^0-9.\-]/g, ''));
        let cmp;
        if(!isNaN(an) && !isNaN(bn)) cmp = an - bn;
        else cmp = av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' });
        return nextDir === 'asc' ? cmp : -cmp;
      });
      rows.forEach(function(r){ tbody.appendChild(r); });
    });
  });
}

function wireTableSearch(input, table){
  if(!input || !table) return;
  // Ensure a filter-empty notice exists next to the table
  let emptyEl = null;
  const wrap = table.closest('.pivot-wrap') || table.parentElement;
  function ensureEmptyEl(){
    if(emptyEl && emptyEl.isConnected) return emptyEl;
    emptyEl = document.createElement('div');
    emptyEl.className = 'table-filter-empty';
    emptyEl.hidden = true;
    emptyEl.setAttribute('role', 'status');
    emptyEl.textContent = 'No rows match this filter.';
    if(wrap && wrap.parentNode){
      wrap.parentNode.insertBefore(emptyEl, wrap.nextSibling);
    } else if(table.parentNode){
      table.parentNode.appendChild(emptyEl);
    }
    return emptyEl;
  }
  function applyFilter(){
    const q = input.value.trim().toLowerCase();
    const rows = table.tBodies[0] ? table.tBodies[0].rows : [];
    let visible = 0;
    Array.prototype.forEach.call(rows, function(tr){
      const text = tr.innerText.toLowerCase();
      const show = !q || text.indexOf(q) >= 0;
      tr.style.display = show ? '' : 'none';
      if(show) visible++;
    });
    const el = ensureEmptyEl();
    el.hidden = !(q && visible === 0);
    if(wrap) wrap.style.display = (q && visible === 0) ? 'none' : '';
  }
  input.addEventListener('input', applyFilter);
}

function openDrawer(title, bodyHtml){
  const drawer = document.getElementById('detailDrawer');
  if(drawer) drawer.classList.remove('drawer-maximized');
  document.getElementById('drawerTitle').textContent = title || 'Details';
  document.getElementById('drawerBody').innerHTML = bodyHtml || '';
  document.getElementById('drawerBackdrop').classList.add('show');
  if(drawer) drawer.classList.add('show');
}
function closeDrawer(){
  const drawer = document.getElementById('detailDrawer');
  document.getElementById('drawerBackdrop').classList.remove('show');
  if(drawer){
    drawer.classList.remove('show');
    drawer.classList.remove('drawer-maximized');
  }
  // Clear any resize / Esc handlers left by drill-down maximize
  if(window._ddChartResizeHandler){
    window.removeEventListener('resize', window._ddChartResizeHandler);
    window._ddChartResizeHandler = null;
  }
  if(typeof window._ddChartEscCleanup === 'function'){
    try{ window._ddChartEscCleanup(); }catch(_){}
    window._ddChartEscCleanup = null;
  }
  if(window._hostDetailKeyHandler){
    document.removeEventListener('keydown', window._hostDetailKeyHandler);
    window._hostDetailKeyHandler = null;
  }
  if(window._hostDetailResizeHandler){
    window.removeEventListener('resize', window._hostDetailResizeHandler);
    window._hostDetailResizeHandler = null;
  }
}

function highlightExtremes(table){
  if(!table) return;
  const body = table.tBodies[0];
  if(!body || !body.rows.length) return;
  const colCount = body.rows[0].cells.length;
  for(let c=1; c<colCount; c++){
    let minV=null, maxV=null, minCell=null, maxCell=null;
    Array.prototype.forEach.call(body.rows, function(tr){
      const cell = tr.cells[c];
      if(!cell) return;
      const n = parseFloat((cell.innerText||'').replace(/[^0-9.\-]/g,''));
      if(isNaN(n)) return;
      if(minV===null || n < minV){ minV=n; minCell=cell; }
      if(maxV===null || n > maxV){ maxV=n; maxCell=cell; }
    });
    if(minCell) minCell.classList.add('metric-extreme');
    if(maxCell && maxCell !== minCell) maxCell.classList.add('metric-extreme');
  }
}

function sparklineSvg(values, w, h, thresholds, scaleOpts){
  w = w || 80; h = h || 22;
  scaleOpts = scaleOpts || {};
  const nums = (values||[]).filter(function(v){ return typeof v === 'number' && !isNaN(v); });
  if(nums.length < 2) return '<svg width="'+w+'" height="'+h+'" viewBox="0 0 '+w+' '+h+'"></svg>';
  // Fixed scale (e.g. 0–100 for %) locks the Y axis so small swings are not exaggerated
  let min, max;
  if(typeof scaleOpts.fixedMin === 'number' && typeof scaleOpts.fixedMax === 'number'
      && scaleOpts.fixedMax > scaleOpts.fixedMin){
    min = scaleOpts.fixedMin;
    max = scaleOpts.fixedMax;
  } else {
    min = Math.min.apply(null, nums);
    max = Math.max.apply(null, nums);
  }
  const span = max - min || 1;
  const coords = nums.map(function(v,i){
    const clamped = Math.max(min, Math.min(max, v));
    return {
      v: v,
      x: (i/(nums.length-1)) * (w-4) + 2,
      y: h - 4 - ((clamped-min)/span)*(h-8),
    };
  });

  // Color a value by threshold bands (same rules as metricClass / drawLineChart)
  function bandColor(v){
    if(!thresholds || !thresholds.mode || thresholds.mode === 'off') return null;
    const yellow = thresholds.yellow != null ? thresholds.yellow : 75;
    const red = thresholds.red != null ? thresholds.red : 90;
    const mode = thresholds.mode;
    if(mode === 'high_bad' || mode === 'bad_high'){
      if(v >= red) return 'var(--danger)';
      if(v >= yellow) return 'var(--accent)';
      return 'var(--success)';
    }
    if(mode === 'high_good' || mode === 'good_high'){
      if(v <= red) return 'var(--danger)';
      if(v <= yellow) return 'var(--accent)';
      return 'var(--success)';
    }
    return null;
  }
  function thLevels(){
    if(!thresholds || !thresholds.mode || thresholds.mode === 'off') return [];
    const levels = [];
    const y = thresholds.yellow, r = thresholds.red;
    if(y != null && !isNaN(y)) levels.push(+y);
    if(r != null && !isNaN(r) && +r !== +y) levels.push(+r);
    return levels;
  }
  function crossingTs(v0, v1, levels){
    const ts = [];
    if(v0 === v1) return ts;
    levels.forEach(function(L){
      if((v0 < L && v1 > L) || (v0 > L && v1 < L)){
        const t = (L - v0) / (v1 - v0);
        if(t > 0.0005 && t < 0.9995) ts.push(t);
      }
    });
    ts.sort(function(a,b){ return a - b; });
    return ts;
  }

  const defaultStroke = 'currentColor';
  const levels = thLevels();
  // Split each segment at threshold crossings so the part above a threshold
  // is solid threshold colour (no mixed whole-segment colour).
  let segs = '';
  for(let i = 1; i < coords.length; i++){
    const a = coords[i-1], b = coords[i];
    const ts = [0].concat(crossingTs(a.v, b.v, levels), [1]);
    for(let k = 0; k < ts.length - 1; k++){
      const tA = ts[k], tB = ts[k + 1];
      if(tB - tA < 1e-6) continue;
      const x1 = a.x + (b.x - a.x) * tA, y1 = a.y + (b.y - a.y) * tA;
      const x2 = a.x + (b.x - a.x) * tB, y2 = a.y + (b.y - a.y) * tB;
      const vMid = a.v + (b.v - a.v) * ((tA + tB) / 2);
      const col = bandColor(vMid) || defaultStroke;
      segs += '<line x1="'+x1+'" y1="'+y1+'" x2="'+x2+'" y2="'+y2+'" '+
        'stroke="'+col+'" stroke-width="1.8" stroke-linecap="round"/>';
    }
  }
  return '<svg width="'+w+'" height="'+h+'" viewBox="0 0 '+w+' '+h+'">'+segs+'</svg>';
}

const DASH_TEMPLATES = [
  {
    id: 'cpu_mem_avail',
    name: 'CPU + Memory + Availability',
    columns: [
      { label: 'CPU %', query: 'system.cpu.util', aggregations: ['avg','max'], unit: '%', thresholds: { mode: 'high_bad', yellow: 75, red: 90 } },
      { label: 'Memory %', query: 'vm.memory.util', aggregations: ['avg','max'], unit: '%', thresholds: { mode: 'high_bad', yellow: 80, red: 95 } },
      { label: 'Availability', query: 'icmpping', aggregations: ['avg','min'], multiplier: 100, unit: '%', thresholds: { mode: 'high_good', yellow: 99, red: 95 } },
    ],
  },
  {
    id: 'icmp',
    name: 'ICMP ping + response time',
    columns: [
      { label: 'Availability', query: 'icmpping', aggregations: ['avg','min'], multiplier: 100, unit: '%', thresholds: { mode: 'high_good', yellow: 99, red: 95 } },
      { label: 'Response time', query: 'icmppingsec', aggregations: ['avg','max'], multiplier: 1000, unit: 'ms', thresholds: { mode: 'high_bad', yellow: 50, red: 100 } },
    ],
  },
];

const THRESH_PRESETS = [
  { id: 'cpu', label: 'CPU 75/90', mode: 'high_bad', yellow: 75, red: 90 },
  { id: 'mem', label: 'Memory 80/95', mode: 'high_bad', yellow: 80, red: 95 },
  { id: 'avail', label: 'Availability 99/95', mode: 'high_good', yellow: 99, red: 95 },
  { id: 'off', label: 'No colour', mode: 'off', yellow: 75, red: 90 },
];

function parseShareLink(){
  const q = new URLSearchParams(location.search);
  return {
    tab: q.get('tab'),
    dash: q.get('dash'),
    pdash: q.get('pdash'),
  };
}

function setShareLink(params){
  const url = new URL(location.href);
  Object.keys(params).forEach(function(k){
    if(params[k] == null || params[k] === '') url.searchParams.delete(k);
    else url.searchParams.set(k, params[k]);
  });
  history.replaceState(null, '', url.toString());
}

async function showApiDocs(){ return showApiDocsModal(); } // kept as an alias in case anything external calls the old name



async function problemAction(eventids, opts){
  opts = opts || {};
  const payload = {
    eventids: (eventids || []).map(function(id){ return parseInt(id, 10); }).filter(Boolean),
    acknowledge: !!opts.acknowledge,
    close: !!opts.close,
    unacknowledge: !!opts.unacknowledge,
    message: opts.message || '',
  };
  if(!payload.eventids.length) throw new Error('No events selected');
  const res = await apiFetch('/api/problems/acknowledge', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(function(){ return {}; });
  if(!res.ok) throw new Error(data.detail || ('Action failed (HTTP '+res.status+')'));
  return data;
}

function selectedProblemEventids(resultsEl){
  const boxes = resultsEl ? resultsEl.querySelectorAll('input.prob-check:checked') : [];
  const ids = [];
  boxes.forEach(function(cb){ if(cb.value) ids.push(parseInt(cb.value, 10)); });
  return ids;
}

function enhanceProblemsResults(resultsEl, problems, refreshKey, refreshFn, exportScope){
  if(!resultsEl) return;
  problems = problems || [];

  // Unified toolbar: severity chips (left) + filter / refresh / export (right)
  const tools = document.createElement('div');
  tools.className = 'table-tools table-tools-top prob-tools';
  tools.innerHTML =
    '<input type="search" placeholder="Filter rows…">'+
    '<label class="table-tools-refresh"><span>Auto</span> '+
      '<select data-act="refresh">'+
        '<option value="0">Off</option>'+
        '<option value="30">30s</option>'+
        '<option value="60">1m</option>'+
        '<option value="300">5m</option>'+
      '</select></label>'+
    '<span class="table-tools-group">'+
      '<button type="button" class="chip-btn" data-act="export-csv">CSV</button>'+
      '<button type="button" class="chip-btn" data-act="export-pdf">PDF</button>'+
    '</span>';

  // Selection action bar (only visible when rows are checked)
  const selBar = document.createElement('div');
  selBar.className = 'prob-selection-bar';
  selBar.hidden = true;
  selBar.innerHTML =
    '<span class="prob-sel-count" data-act="sel-count">0 selected</span>'+
    '<span class="prob-sel-actions">'+
      '<button type="button" class="btn btn-ghost" data-act="ack" title="Acknowledge selected">Acknowledge</button>'+
      '<button type="button" class="btn btn-ghost" data-act="close" title="Close selected (if allowed)">Close selected</button>'+
      '<button type="button" class="btn btn-ghost" data-act="unack" title="Unacknowledge selected">Unack</button>'+
    '</span>'+
    '<span class="status-msg" data-act="bulk-status"></span>';

  // Wrap severity strip + tools into one toolbar row
  const tableWrap = resultsEl.querySelector('.pivot-wrap');
  const sevStrip = resultsEl.querySelector('.sev-counter-strip, .insight-strip');
  const toolbar = document.createElement('div');
  toolbar.className = 'prob-results-toolbar';
  if(sevStrip){
    sevStrip.classList.add('prob-sev-inline');
    toolbar.appendChild(sevStrip);
  }
  toolbar.appendChild(tools);

  if(tableWrap){
    resultsEl.insertBefore(toolbar, tableWrap);
    resultsEl.insertBefore(selBar, tableWrap);
  } else {
    resultsEl.insertBefore(toolbar, resultsEl.firstChild);
    resultsEl.appendChild(selBar);
  }

  const tbl = resultsEl.querySelector('table');
  if(typeof makeTableSortable === 'function') makeTableSortable(tbl);
  if(typeof wireTableSearch === 'function') wireTableSearch(tools.querySelector('input'), tbl);

  // Severity chip click-to-filter (skip zero chips)
  resultsEl.querySelectorAll('.insight-chip[data-sev]').forEach(function(chip){
    if(chip.classList.contains('is-zero')) return;
    chip.style.cursor = 'pointer';
    chip.addEventListener('click', function(){
      const search = tools.querySelector('input[type=search]');
      if(!search || !tbl) return;
      // Label format is "Average: 1" — filter by severity name only
      const raw = (chip.textContent || '').trim();
      const label = raw.replace(/:\s*\d+\s*$/, '').trim();
      if(search.value === label){ search.value = ''; }
      else { search.value = label; }
      search.dispatchEvent(new Event('input'));
    });
  });

  function applyAgeFilter(minSec, maxSec, label){
    if(!tbl) return;
    const rows = tbl.querySelectorAll('tbody tr');
    let shown = 0;
    rows.forEach(function(tr){
      const age = parseInt(tr.getAttribute('data-age-seconds'), 10);
      const ok = (isNaN(age) ? 0 : age) >= minSec && (maxSec === null || age < maxSec);
      tr.style.display = ok ? '' : 'none';
      if(ok) shown++;
    });
    const search = tools.querySelector('input[type=search]');
    if(search) search.value = '';
    const statusEl = selBar.querySelector('[data-act="bulk-status"]');
    if(statusEl){
      statusEl.textContent = label ? ('Age: '+label+' ('+shown+') — click again to clear') : '';
      statusEl.className = 'status-msg';
    }
  }
  function clearAgeFilter(){
    if(!tbl) return;
    tbl.querySelectorAll('tbody tr').forEach(function(tr){ tr.style.display = ''; });
    resultsEl.querySelectorAll('.age-h-row.active, .age-bar.active').forEach(function(b){ b.classList.remove('active'); });
    const statusEl = selBar.querySelector('[data-act="bulk-status"]');
    if(statusEl) statusEl.textContent = '';
  }
  resultsEl.querySelectorAll('.age-h-row, .age-bar').forEach(function(bar){
    function activate(){
      if(bar.classList.contains('active')){
        clearAgeFilter();
        return;
      }
      resultsEl.querySelectorAll('.age-h-row.active, .age-bar.active').forEach(function(b){ b.classList.remove('active'); });
      bar.classList.add('active');
      const minSec = parseInt(bar.getAttribute('data-age-min'), 10) || 0;
      const maxRaw = bar.getAttribute('data-age-max');
      const maxSec = (maxRaw === '' || maxRaw == null) ? null : parseInt(maxRaw, 10);
      applyAgeFilter(minSec, maxSec, bar.getAttribute('data-age-label') || '');
    }
    bar.addEventListener('click', activate);
    bar.addEventListener('keydown', function(e){
      if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); activate(); }
    });
  });

  async function runBulk(kind){
    const ids = selectedProblemEventids(resultsEl);
    const statusEl = selBar.querySelector('[data-act="bulk-status"]');
    if(!ids.length){
      showToast('Select one or more problems first.', { type: 'warn' });
      return;
    }
    let message = '';
    if(kind === 'ack' || kind === 'close'){
      message = await promptModal(
        (kind === 'close' ? 'Close' : 'Acknowledge') + ' ' + ids.length + ' problem(s). Optional message:',
        '',
        { okLabel: kind === 'close' ? 'Close' : 'Acknowledge', placeholder: 'Message (optional)' }
      );
      if(message === null) return;
    } else if(kind === 'unack'){
      const ok = await confirmModal('Unacknowledge ' + ids.length + ' problem(s)?');
      if(!ok) return;
    }
    if(statusEl){ statusEl.textContent = 'Working…'; statusEl.className = 'status-msg'; }
    try{
      await problemAction(ids, {
        acknowledge: kind === 'ack',
        close: kind === 'close',
        unacknowledge: kind === 'unack',
        message: message || '',
      });
      showToast(
        (kind === 'close' ? 'Closed' : kind === 'unack' ? 'Unacknowledged' : 'Acknowledged') +
        ' ' + ids.length + ' problem(s).',
        { type: 'success' }
      );
      if(typeof refreshFn === 'function') refreshFn();
    }catch(err){
      const msg = (err && err.message) ? err.message : String(err);
      const hint = (kind === 'close' && /permission|not allowed|cannot|manual/i.test(msg))
        ? ' (trigger may not allow manual close, or your Zabbix user lacks rights)'
        : '';
      if(statusEl){ statusEl.textContent = msg + hint; statusEl.className = 'status-msg warn'; }
      showToast(msg + hint, { type: 'warn' });
    }
  }

  selBar.querySelector('[data-act="ack"]').addEventListener('click', function(){ runBulk('ack'); });
  selBar.querySelector('[data-act="close"]').addEventListener('click', function(){ runBulk('close'); });
  selBar.querySelector('[data-act="unack"]').addEventListener('click', function(){ runBulk('unack'); });

  const viewTitle = (exportScope && (exportScope.name || exportScope.title)) || 'Problems';
  const fileBase = (typeof sanitizeExportFilename === 'function'
    ? sanitizeExportFilename(viewTitle, 'problems')
    : String(viewTitle).replace(/[^a-z0-9]+/gi, '_')) || 'problems';

  tools.querySelector('[data-act="export-csv"]').addEventListener('click', async function(){
    if(exportScope && typeof downloadProblemsExport === 'function'){
      downloadProblemsExport(Object.assign({}, exportScope, { name: viewTitle }), 'csv');
    } else if(typeof exportVisibleTable === 'function'){
      exportVisibleTable(resultsEl, fileBase + '.csv', { title: viewTitle });
    }
  });
  const pdfBtn = tools.querySelector('[data-act="export-pdf"]');
  if(pdfBtn){
    pdfBtn.addEventListener('click', function(){
      exportVisibleTablePdf(resultsEl, fileBase + '.pdf', { title: viewTitle });
    });
  }

  const refreshSel = tools.querySelector('[data-act="refresh"]');
  if(refreshSel && typeof wireAutoRefresh === 'function' && refreshFn){
    const saved = localStorage.getItem('zr_refresh_' + (refreshKey || 'problems'));
    if(saved && refreshSel.querySelector('option[value="'+saved+'"]')){
      refreshSel.value = saved;
    }
    refreshSel.addEventListener('change', function(){
      localStorage.setItem('zr_refresh_' + (refreshKey || 'problems'), refreshSel.value);
    });
    wireAutoRefresh(refreshKey || 'problems', refreshSel, refreshFn);
  }

  function updateSelectionBar(){
    const ids = selectedProblemEventids(resultsEl);
    const n = ids.length;
    const countEl = selBar.querySelector('[data-act="sel-count"]');
    if(countEl) countEl.textContent = n === 1 ? '1 selected' : (n + ' selected');
    selBar.hidden = n === 0;
    selBar.classList.toggle('is-active', n > 0);
    // Highlight selected rows (mockup amber tint)
    resultsEl.querySelectorAll('input.prob-check').forEach(function(cb){
      const tr = cb.closest('tr');
      if(tr) tr.classList.toggle('is-selected', !!cb.checked);
    });
  }

  const selectAll = resultsEl.querySelector('input.prob-check-all');
  if(selectAll){
    selectAll.addEventListener('change', function(){
      resultsEl.querySelectorAll('input.prob-check').forEach(function(cb){
        const tr = cb.closest('tr');
        if(tr && tr.style.display === 'none') return;
        cb.checked = selectAll.checked;
      });
      updateSelectionBar();
    });
  }
  resultsEl.querySelectorAll('input.prob-check').forEach(function(cb){
    cb.addEventListener('change', updateSelectionBar);
  });

  if(tbl && tbl.tBodies[0]){
    Array.prototype.forEach.call(tbl.tBodies[0].rows, function(tr, idx){
      tr.style.cursor = 'pointer';
      tr.title = 'Click for details';
      tr.addEventListener('click', function(e){
        if(e.target && (e.target.closest('input') || e.target.closest('button'))) return;
        const p = problems[idx];
        if(!p || typeof openDrawer !== 'function') return;
        openProblemDrawer(p, refreshFn);
      });
    });
  }
}

function isProblemOpen(p){
  if(!p) return false;
  const st = String(p.problem_status || '').toLowerCase();
  if(st === 'closed') return false;
  if(st === 'open') return true;
  const rid = p.r_eventid;
  if(rid == null || rid === '' || rid === 0 || rid === '0') return true;
  try{ return parseInt(rid, 10) === 0; }catch(e){ return false; }
}

async function openProblemDrawer(p, refreshFn){
  const isOpen = isProblemOpen(p);
  const isAcked = (p.ack_status === 'Acknowledged') || (parseInt(p.acknowledged,10) === 1);
  const body =
    '<div class="kv">'+
      '<span>Host</span><span>'+escHtml(p.host_name||p.host||'')+'</span>'+
      '<span>Severity</span><span>'+escHtml(p.severity_label||p.severity||'')+'</span>'+
      '<span>Status</span><span>'+escHtml(p.problem_status||'')+'</span>'+
      '<span>Ack</span><span>'+escHtml(p.ack_status||'')+'</span>'+
      '<span>Event ID</span><span>'+escHtml(String(p.eventid||''))+'</span>'+
      '<span>Trigger</span><span>'+escHtml(p.trigger_name||'')+'</span>'+
      '<span>Since</span><span>'+(p.clock && typeof fmtTime==='function' ? fmtTime(p.clock) : '')+'</span>'+
      '<span>Age</span><span>'+(typeof formatAge==='function' ? formatAge(p.age_seconds) : '')+'</span>'+
    '</div>'+
    '<div class="drawer-actions" style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap;">'+
      (isOpen && !isAcked ? '<button type="button" class="btn btn-primary" data-act="ack" style="height:34px;">Acknowledge</button>' : '')+
      (isOpen && isAcked ? '<button type="button" class="btn btn-ghost" data-act="unack" style="height:34px;">Unacknowledge</button>' : '')+
      (isOpen ? '<button type="button" class="btn btn-ghost" data-act="close" style="height:34px;">Close problem</button>' : '')+
      '<span class="status-msg" data-act="drawer-status"></span>'+
    '</div>';
  openDrawer(p.problem_name || p.trigger_name || 'Problem', body);
  const drawer = document.getElementById('drawerBody');
  if(!drawer) return;

  async function doAction(kind){
    const statusEl = drawer.querySelector('[data-act="drawer-status"]');
    let message = '';
    if(kind === 'ack' || kind === 'close'){
      message = await promptModal(
        (kind === 'close' ? 'Close problem' : 'Acknowledge') + '. Optional message:',
        '',
        { okLabel: kind === 'close' ? 'Close' : 'Acknowledge', placeholder: 'Message (optional)' }
      );
      if(message === null) return;
    }
    if(statusEl){ statusEl.textContent = 'Working…'; statusEl.className = 'status-msg'; }
    try{
      await problemAction([p.eventid], {
        acknowledge: kind === 'ack',
        close: kind === 'close',
        unacknowledge: kind === 'unack',
        message: message || '',
      });
      showToast(kind === 'close' ? 'Problem closed.' : kind === 'unack' ? 'Unacknowledged.' : 'Acknowledged.', { type: 'success' });
      closeDrawer();
      if(typeof refreshFn === 'function') refreshFn();
    }catch(err){
      const msg = (err && err.message) ? err.message : String(err);
      // Zabbix often rejects close when the trigger has "Allow manual close" disabled
      const hint = (kind === 'close' && /permission|not allowed|cannot|manual/i.test(msg))
        ? ' (trigger may not allow manual close, or your Zabbix user lacks rights)'
        : '';
      if(statusEl){ statusEl.textContent = msg + hint; statusEl.className = 'status-msg warn'; }
      showToast(msg + hint, { type: 'warn' });
    }
  }
  const ackBtn = drawer.querySelector('[data-act="ack"]');
  const unackBtn = drawer.querySelector('[data-act="unack"]');
  const closeBtn = drawer.querySelector('[data-act="close"]');
  if(ackBtn) ackBtn.addEventListener('click', function(){ doAction('ack'); });
  if(unackBtn) unackBtn.addEventListener('click', function(){ doAction('unack'); });
  if(closeBtn) closeBtn.addEventListener('click', function(){ doAction('close'); });
}

async function downloadProblemsExport(scope, format){
  format = format === 'xlsx' ? 'xlsx' : 'csv';
  const url = '/api/problems/export.' + format;
  try{
    const res = await apiFetch(url, { method: 'POST', body: JSON.stringify(scope || {}) });
    if(!res.ok){
      const err = await res.json().catch(function(){ return {}; });
      throw new Error(err.detail || ('Export failed (HTTP '+res.status+')'));
    }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const base = (typeof sanitizeExportFilename === 'function'
      ? sanitizeExportFilename((scope && (scope.name || scope.title)) || 'problems', 'problems')
      : 'problems');
    a.download = base + '.' + format;
    document.body.appendChild(a);
    a.click();
    setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }catch(err){
    showToast(err.message || String(err), { type: 'warn' });
  }
}


let zbxUsersCache = null;
let zbxUsrgrpsCache = null;

let shareDirError = ''; // last load failure detail, if any — surfaced in the picker so a broken load doesn't just look like "no users exist"

async function loadShareDirectories(force){
  if(!force && zbxUsersCache && zbxUsrgrpsCache) return;
  shareDirError = '';
  try{
    const [u, g] = await Promise.all([
      apiFetch('/api/zbx/users'),
      apiFetch('/api/zbx/usrgrps'),
    ]);
    if(u.ok){
      const data = await u.json();
      zbxUsersCache = Array.isArray(data) ? data : [];
    } else {
      const err = await u.json().catch(function(){ return {}; });
      shareDirError = (typeof err.detail === 'string' ? err.detail : null) || ('Could not load Zabbix users (HTTP '+u.status+').');
      zbxUsersCache = null;
    }
    if(g.ok){
      const data = await g.json();
      zbxUsrgrpsCache = Array.isArray(data) ? data : [];
    } else {
      const err = await g.json().catch(function(){ return {}; });
      if(!shareDirError) shareDirError = (typeof err.detail === 'string' ? err.detail : null) || ('Could not load Zabbix user groups (HTTP '+g.status+').');
      zbxUsrgrpsCache = null;
    }
  }catch(e){
    console.warn('share dirs', e);
    shareDirError = e.message || String(e);
    zbxUsersCache = null;
    zbxUsrgrpsCache = null;
  }
}

function wireShareRetry(idPrefix, rerenderFn){
  const btn = document.getElementById(idPrefix+'Retry');
  if(!btn) return;
  btn.addEventListener('click', async function(){
    btn.textContent = 'Retrying…';
    btn.disabled = true;
    await loadShareDirectories(true);
    if(shareDirError) showToast('Still failed: '+shareDirError, { type: 'warn' });
    rerenderFn();
  });
}

function sharePickerHtml(idPrefix, selectedUserids, selectedGrpids){
  selectedUserids = selectedUserids || [];
  selectedGrpids = selectedGrpids || [];
  const failed = !zbxUsersCache || !zbxUsrgrpsCache;
  const errorBox = failed
    ? '<div class="share-hint" style="color:var(--danger);display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;">'+
        (shareDirError ? escHtml(shareDirError) : 'Could not load users/groups from Zabbix.')+
        ' <button type="button" class="chip-btn" id="'+idPrefix+'Retry" style="height:22px;padding:0 8px;font-size:10.5px;">Retry</button>'+
      '</div>'
    : '';
  // Store selection on a lightweight state object keyed by prefix
  if(!window._sharePickState) window._sharePickState = {};
  window._sharePickState[idPrefix] = {
    userids: selectedUserids.map(function(id){ return parseInt(id, 10); }),
    grpids: selectedGrpids.map(function(id){ return parseInt(id, 10); }),
  };
  return errorBox+
    '<div class="field builder-field-users" data-share="'+idPrefix+'">'+
      '<label>Share with users</label>'+
      '<div class="picker" id="'+idPrefix+'UsersPicker">'+
        '<div class="picker-trigger" id="'+idPrefix+'UsersTrigger" tabindex="0">'+
          '<span class="picker-placeholder" id="'+idPrefix+'UsersPlaceholder">Select users to share…</span>'+
          '<svg class="picker-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 9L12 15L18 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'+
        '</div>'+
        '<div class="picker-panel" id="'+idPrefix+'UsersPanel">'+
          '<input class="picker-search" id="'+idPrefix+'UsersSearch" placeholder="Filter users…" autocomplete="off">'+
          '<div class="picker-list" id="'+idPrefix+'UsersList"></div>'+
        '</div>'+
      '</div>'+
    '</div>'+
    '<div class="field builder-field-usrgrps">'+
      '<label>Share with user groups</label>'+
      '<div class="picker" id="'+idPrefix+'GrpsPicker">'+
        '<div class="picker-trigger" id="'+idPrefix+'GrpsTrigger" tabindex="0">'+
          '<span class="picker-placeholder" id="'+idPrefix+'GrpsPlaceholder">Select groups to share…</span>'+
          '<svg class="picker-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 9L12 15L18 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'+
        '</div>'+
        '<div class="picker-panel" id="'+idPrefix+'GrpsPanel">'+
          '<input class="picker-search" id="'+idPrefix+'GrpsSearch" placeholder="Filter groups…" autocomplete="off">'+
          '<div class="picker-list" id="'+idPrefix+'GrpsList"></div>'+
        '</div>'+
      '</div>'+
    '</div>';
}

function wireSharePicker(idPrefix){
  const st = (window._sharePickState && window._sharePickState[idPrefix]) || { userids: [], grpids: [] };
  if(!window._sharePickState) window._sharePickState = {};
  window._sharePickState[idPrefix] = st;

  function userLabel(id){
    const u = (zbxUsersCache || []).find(function(x){ return parseInt(x.userid,10) === parseInt(id,10); });
    return u ? (u.label || u.username) : ('#'+id);
  }
  function grpLabel(id){
    const g = (zbxUsrgrpsCache || []).find(function(x){ return parseInt(x.usrgrpid,10) === parseInt(id,10); });
    return g ? (g.name || String(id)) : ('#'+id);
  }

  function renderUsersList(filter){
    const list = document.getElementById(idPrefix+'UsersList');
    if(!list) return;
    const f = (filter || '').trim().toLowerCase();
    const selected = new Set(st.userids.map(function(id){ return parseInt(id,10); }));
    const users = zbxUsersCache || [];
    const filtered = users.filter(function(u){
      const lab = (u.label || u.username || '').toLowerCase();
      return !f || lab.indexOf(f) !== -1;
    });
    list.innerHTML = filtered.length ? filtered.map(function(u){
      const id = parseInt(u.userid, 10);
      return '<label class="picker-option">'+
        '<input type="checkbox" value="'+id+'" '+(selected.has(id)?'checked':'')+'>'+
        '<div class="opt-main"><div class="opt-name">'+escHtml(u.label || u.username)+'</div></div></label>';
    }).join('') : '<div class="picker-empty">'+(zbxUsersCache ? 'No users match.' : 'Not loaded.')+'</div>';
    list.querySelectorAll('input[type=checkbox]').forEach(function(cb){
      cb.addEventListener('change', function(){
        const id = parseInt(cb.value, 10);
        if(cb.checked){
          if(st.userids.indexOf(id) < 0) st.userids.push(id);
        } else {
          st.userids = st.userids.filter(function(x){ return parseInt(x,10) !== id; });
        }
        renderUsersTrigger();
      });
    });
  }

  function renderGrpsList(filter){
    const list = document.getElementById(idPrefix+'GrpsList');
    if(!list) return;
    const f = (filter || '').trim().toLowerCase();
    const selected = new Set(st.grpids.map(function(id){ return parseInt(id,10); }));
    const grps = zbxUsrgrpsCache || [];
    const filtered = grps.filter(function(g){
      const lab = String(g.name || g.usrgrpid).toLowerCase();
      return !f || lab.indexOf(f) !== -1;
    });
    list.innerHTML = filtered.length ? filtered.map(function(g){
      const id = parseInt(g.usrgrpid, 10);
      return '<label class="picker-option">'+
        '<input type="checkbox" value="'+id+'" '+(selected.has(id)?'checked':'')+'>'+
        '<div class="opt-main"><div class="opt-name">'+escHtml(g.name || String(id))+'</div></div></label>';
    }).join('') : '<div class="picker-empty">'+(zbxUsrgrpsCache ? 'No groups match.' : 'Not loaded.')+'</div>';
    list.querySelectorAll('input[type=checkbox]').forEach(function(cb){
      cb.addEventListener('change', function(){
        const id = parseInt(cb.value, 10);
        if(cb.checked){
          if(st.grpids.indexOf(id) < 0) st.grpids.push(id);
        } else {
          st.grpids = st.grpids.filter(function(x){ return parseInt(x,10) !== id; });
        }
        renderGrpsTrigger();
      });
    });
  }

  function renderUsersTrigger(){
    const trigger = document.getElementById(idPrefix+'UsersTrigger');
    const placeholder = document.getElementById(idPrefix+'UsersPlaceholder');
    if(!trigger) return;
    trigger.querySelectorAll('.pill').forEach(function(p){ p.remove(); });
    if(!st.userids.length){
      if(placeholder) placeholder.style.display = '';
      return;
    }
    if(placeholder) placeholder.style.display = 'none';
    st.userids.forEach(function(id){
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.innerHTML = escHtml(userLabel(id))+' <button type="button" aria-label="Remove">×</button>';
      pill.querySelector('button').addEventListener('click', function(e){
        e.stopPropagation();
        st.userids = st.userids.filter(function(x){ return parseInt(x,10) !== parseInt(id,10); });
        renderUsersTrigger();
        renderUsersList((document.getElementById(idPrefix+'UsersSearch')||{}).value || '');
      });
      trigger.insertBefore(pill, trigger.querySelector('.picker-chevron'));
    });
  }

  function renderGrpsTrigger(){
    const trigger = document.getElementById(idPrefix+'GrpsTrigger');
    const placeholder = document.getElementById(idPrefix+'GrpsPlaceholder');
    if(!trigger) return;
    trigger.querySelectorAll('.pill').forEach(function(p){ p.remove(); });
    if(!st.grpids.length){
      if(placeholder) placeholder.style.display = '';
      return;
    }
    if(placeholder) placeholder.style.display = 'none';
    st.grpids.forEach(function(id){
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.innerHTML = escHtml(grpLabel(id))+' <button type="button" aria-label="Remove">×</button>';
      pill.querySelector('button').addEventListener('click', function(e){
        e.stopPropagation();
        st.grpids = st.grpids.filter(function(x){ return parseInt(x,10) !== parseInt(id,10); });
        renderGrpsTrigger();
        renderGrpsList((document.getElementById(idPrefix+'GrpsSearch')||{}).value || '');
      });
      trigger.insertBefore(pill, trigger.querySelector('.picker-chevron'));
    });
  }

  function closeSharePanels(exceptPanel){
    document.querySelectorAll('[id$="UsersPanel"], [id$="GrpsPanel"]').forEach(function(p){
      if(exceptPanel && p === exceptPanel) return;
      p.classList.remove('open');
      p.style.display = '';
    });
    document.querySelectorAll('[id$="UsersTrigger"], [id$="GrpsTrigger"]').forEach(function(t){
      t.classList.remove('open');
    });
  }

  function wirePicker(triggerId, panelId, searchId, renderList){
    const trigger = document.getElementById(triggerId);
    const panel = document.getElementById(panelId);
    const search = document.getElementById(searchId);
    if(!trigger || !panel) return;
    // Avoid double-binding if wireSharePicker is called again
    if(trigger._shareWired) return;
    trigger._shareWired = true;
    trigger.addEventListener('click', function(e){
      e.stopPropagation();
      const open = !panel.classList.contains('open');
      closeSharePanels(open ? panel : null);
      // Clear any inline display:none left by host/group toggle helpers
      panel.style.display = open ? 'block' : '';
      panel.classList.toggle('open', open);
      trigger.classList.toggle('open', open);
      if(open){
        renderList(search ? search.value : '');
        if(search) search.focus();
      }
    });
    if(search && !search._shareWired){
      search._shareWired = true;
      search.addEventListener('input', function(){ renderList(search.value); });
      search.addEventListener('click', function(e){ e.stopPropagation(); });
    }
  }

  wirePicker(idPrefix+'UsersTrigger', idPrefix+'UsersPanel', idPrefix+'UsersSearch', renderUsersList);
  wirePicker(idPrefix+'GrpsTrigger', idPrefix+'GrpsPanel', idPrefix+'GrpsSearch', renderGrpsList);
  renderUsersList('');
  renderGrpsList('');
  renderUsersTrigger();
  renderGrpsTrigger();

  // Global outside-click dismiss is installed once via ensurePickerOutsideClose()
  ensurePickerOutsideClose();
}

/** Close every open custom picker panel across the app. */
function closeAllOpenPickers(exceptPanel){
  document.querySelectorAll('.picker-panel.open, .picker-panel[style*="display: block"], .picker-panel[style*="display:block"]').forEach(function(p){
    if(exceptPanel && p === exceptPanel) return;
    p.classList.remove('open');
    p.style.display = '';
  });
  document.querySelectorAll('.picker-trigger.open').forEach(function(t){
    t.classList.remove('open');
  });
  // Also native-looking custom panels that may only use inline display
  document.querySelectorAll('.picker-panel').forEach(function(p){
    if(exceptPanel && p === exceptPanel) return;
    if(p.style.display === 'block'){
      p.style.display = '';
      p.classList.remove('open');
    }
  });
}

function ensurePickerOutsideClose(){
  if(window._pickerOutsideClose) return;
  window._pickerOutsideClose = true;
  document.addEventListener('click', function(e){
    // e.target is the deepest node; closest works in capture too
    if(e.target.closest && e.target.closest('.picker')) return;
    if(e.target.closest && e.target.closest('.prefs-menu, .topbar-menu, .drawer, .modal, .drawer-backdrop')) return;
    closeAllOpenPickers(null);
  }, true);
}
ensurePickerOutsideClose();


function readSharePicker(idPrefix){
  const st = (window._sharePickState && window._sharePickState[idPrefix]) || null;
  if(st){
    return {
      shared_userids: (st.userids || []).map(function(id){ return parseInt(id, 10); }),
      shared_usrgrpids: (st.grpids || []).map(function(id){ return parseInt(id, 10); }),
    };
  }
  // Fallback: read checked boxes if present
  const users = [];
  const grps = [];
  document.querySelectorAll('#'+idPrefix+'UsersList input:checked').forEach(function(cb){
    users.push(parseInt(cb.value, 10));
  });
  document.querySelectorAll('#'+idPrefix+'GrpsList input:checked').forEach(function(cb){
    grps.push(parseInt(cb.value, 10));
  });
  return { shared_userids: users, shared_usrgrpids: grps };
}

function shareBadgeHtml(d){
  const nU = (d.shared_userids||[]).length;
  const nG = (d.shared_usrgrpids||[]).length;
  let label = 'Private', cls = 'private';
  if(d.is_shared){ label = 'Shared (all)'; cls = 'shared'; }
  else if(nU || nG){ label = 'Shared ('+nU+'u/'+nG+'g)'; cls = 'shared'; }
  return '<span class="share-badge '+cls+'">'+label+'</span>';
}

async function boot(){
  applyUiPrefs();
  const db = document.getElementById('drawerBackdrop');
  const dc = document.getElementById('drawerClose');
  if(db) db.addEventListener('click', closeDrawer);
  if(dc) dc.addEventListener('click', closeDrawer);
  // Skip link for keyboard users
  if(!document.querySelector('.skip-link')){
    const skip = document.createElement('a');
    skip.href = '#dashboardsView';
    skip.className = 'skip-link';
    skip.textContent = 'Skip to content';
    document.body.insertBefore(skip, document.body.firstChild);
  }

  // header extras: theme + Display — always present (HTML or inject once)
  (function wireHeaderActions(){
    const pulse = document.querySelector('.pulse-wrap');
    const userBadge = document.getElementById('userBadge');
    let extras = document.getElementById('uiExtras');
    if(!extras && pulse){
      extras = document.createElement('div');
      extras.id = 'uiExtras';
      extras.className = 'header-actions';
      extras.innerHTML =
        '<button type="button" class="icon-btn" id="themeBtn" title="Cycle theme (auto / dark / light)">'+ICON_SUN+'</button>'+
        '<div class="prefs-wrap">'+
          '<button type="button" class="chip-btn" id="prefsBtn" title="Display preferences">Display</button>'+
          '<div class="prefs-popover" id="prefsPopover" role="dialog" aria-label="Display preferences">'+
            '<div class="prefs-section">'+
              '<div class="prefs-section-label">Theme</div>'+
              '<div class="prefs-seg" role="group" aria-label="Theme">'+
                '<button type="button" class="prefs-seg-btn" data-pref-theme="auto">Auto</button>'+
                '<button type="button" class="prefs-seg-btn" data-pref-theme="dark">Dark</button>'+
                '<button type="button" class="prefs-seg-btn" data-pref-theme="light">Light</button>'+
              '</div>'+
              '<select id="prefTheme" class="sr-only" aria-hidden="true" tabindex="-1">'+
                '<option value="auto">Auto</option><option value="dark">Dark</option><option value="light">Light</option>'+
              '</select>'+
            '</div>'+
            '<div class="prefs-section">'+
              '<div class="prefs-section-label">Density</div>'+
              '<div class="prefs-seg" role="group" aria-label="Density">'+
                '<button type="button" class="prefs-seg-btn" data-pref-density="compact">Compact</button>'+
                '<button type="button" class="prefs-seg-btn" data-pref-density="comfortable">Comfortable</button>'+
              '</div>'+
              '<select id="prefDensity" class="sr-only" aria-hidden="true" tabindex="-1">'+
                '<option value="compact">Compact</option><option value="comfortable">Comfortable</option>'+
              '</select>'+
            '</div>'+
            '<label class="prefs-row">Text size <select id="prefFont">'+
              '<option value="sm">Small</option>'+
              '<option value="md">Medium</option>'+
              '<option value="lg">Large</option>'+
            '</select></label>'+
          '</div>'+
        '</div>';
      if(userBadge) userBadge.parentNode.insertBefore(extras, userBadge);
      else if(pulse.parentNode) pulse.parentNode.appendChild(extras);
    }
    if(extras){
      extras.classList.add('header-actions');
      extras.style.display = 'flex';
    }
    const themeBtn = document.getElementById('themeBtn');
    if(themeBtn && !themeBtn._wired){
      themeBtn._wired = true;
      themeBtn.addEventListener('click', toggleTheme);
    }
    const prefsBtn = document.getElementById('prefsBtn');
    const pop = document.getElementById('prefsPopover');
    if(prefsBtn && pop && !prefsBtn._wired){
      prefsBtn._wired = true;
      prefsBtn.addEventListener('click', function(e){
        e.stopPropagation();
        pop.classList.toggle('open');
        applyUiPrefs();
      });
      document.addEventListener('click', function(e){
        if(pop.classList.contains('open') && !pop.contains(e.target) && e.target !== prefsBtn){
          pop.classList.remove('open');
        }
      });
      const prefTheme = document.getElementById('prefTheme');
      const prefFont = document.getElementById('prefFont');
      const prefDensity = document.getElementById('prefDensity');
      if(prefTheme) prefTheme.addEventListener('change', function(e){ setUiPref('theme', e.target.value); });
      if(prefFont) prefFont.addEventListener('change', function(e){ setUiPref('font', e.target.value); });
      if(prefDensity) prefDensity.addEventListener('change', function(e){ setUiPref('density', e.target.value); });
      pop.querySelectorAll('[data-pref-theme]').forEach(function(b){
        b.addEventListener('click', function(){ setUiPref('theme', b.getAttribute('data-pref-theme')); });
      });
      pop.querySelectorAll('[data-pref-density]').forEach(function(b){
        b.addEventListener('click', function(){ setUiPref('density', b.getAttribute('data-pref-density')); });
      });
    }
  })();
  applyUiPrefs(); // re-apply now that themeBtn exists

  // Keyboard shortcuts
  let _gotoChord = null;
  document.addEventListener('keydown', function(e){
    const mod = e.metaKey || e.ctrlKey;
    const tag = (e.target && e.target.tagName) || '';
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable);

    if(mod && (e.key === 'k' || e.key === 'K')){
      e.preventDefault();
      if(cmdk.open) closeCommandPalette(); else openCommandPalette();
      return;
    }

    if(e.key === 'Escape'){
      if(cmdk.open){ closeCommandPalette(); return; }
      const pop = document.getElementById('prefsPopover');
      if(pop && pop.classList.contains('open')){ pop.classList.remove('open'); return; }
      if(_docsEl && _docsEl.classList.contains('show')){ _docsEl.classList.remove('show'); return; }
      if(_confirmEl && _confirmEl.classList.contains('show')){ _confirmEl.classList.remove('show'); return; }
      if(_tplEl && _tplEl.classList.contains('show')){ _tplEl.classList.remove('show'); return; }
      if(_promptEl && _promptEl.classList.contains('show')){ _promptEl.classList.remove('show'); return; }
      if(_shortcutsEl && _shortcutsEl.classList.contains('show')){ _shortcutsEl.classList.remove('show'); return; }
      if(typeof _healthModal !== 'undefined' && _healthModal && _healthModal.classList.contains('show')){ _healthModal.classList.remove('show'); return; }
      const drawer = document.getElementById('detailDrawer');
      if(drawer && drawer.classList.contains('show')){ closeDrawer(); return; }
    }

    if(typing) return;

    // / → focus first visible search/filter
    if(e.key === '/' && !mod){
      e.preventDefault();
      const search = document.querySelector(
        '#dashSearch, #pdashSearch, #dashTableSearch, #dqTableSearch, .table-tools input[type=search], input[type=search]'
      );
      if(search){ search.focus(); search.select && search.select(); }
      return;
    }

    // ? → shortcuts help
    if(e.key === '?' || (e.key === '/' && e.shiftKey)){
      e.preventDefault();
      showShortcutsHelp();
      return;
    }

    // g then m/p → navigate tabs
    if(e.key === 'g' && !mod){
      _gotoChord = Date.now();
      return;
    }
    if(_gotoChord && Date.now() - _gotoChord < 1200){
      _gotoChord = null;
      if(e.key === 'm'){
        const b = document.querySelector('#navTabs button[data-nav="dashboards"]');
        if(b) b.click();
        return;
      }
      if(e.key === 'p'){
        const b = document.querySelector('#navTabs button[data-nav="problems"]');
        if(b) b.click();
        return;
      }
    } else {
      _gotoChord = null;
    }

    // r → click primary Run/Refresh if present
    if(e.key === 'r' && !mod){
      const runBtn = document.getElementById('runDashBtn') || document.getElementById('probRunBtn') || document.getElementById('qvRunBtn') || document.getElementById('dqRunBtn');
      if(runBtn && !runBtn.disabled){ e.preventDefault(); runBtn.click(); }
    }
  });

  try{
    const res = await fetch('/api/config', { cache: 'no-store' });
    if(res.ok){
      appConfig = await res.json();
    }
  }catch(e){ console.warn('config', e); }

  checkHealth();
  const liveDot = document.getElementById('liveDot');
  if(liveDot){
    liveDot.addEventListener('click', function(){ if(canViewDbStatus()) showHealthStatus(); });
    liveDot.addEventListener('keydown', function(e){
      if(!canViewDbStatus()) return;
      if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); showHealthStatus(); }
    });
    updateHealthButtonState();
  }
  // periodic health refresh (also feeds the DB-latency sparkline)
  setInterval(function(){ checkHealth(); }, 15000);

  // Tab switching
  document.querySelectorAll('#navTabs button').forEach(function(btn){
    btn.addEventListener('click', function(){
      document.querySelectorAll('#navTabs button').forEach(function(b){ b.classList.remove('active'); });
      btn.classList.add('active');
      const nav = btn.dataset.nav;
      const dashEl = document.getElementById('dashboardsView');
      const probEl = document.getElementById('problemsView');
      if(dashEl) dashEl.style.display = nav === 'dashboards' ? '' : 'none';
      if(probEl) probEl.style.display = nav === 'problems' ? '' : 'none';
      if(nav === 'dashboards'){
        showDashboardList().catch(function(e){ console.error(e); });
      }
      if(nav === 'problems'){
        showProblemsView().catch(function(e){ console.error(e); });
      }
    });
  });

  // Auth gate: only load Zabbix-scoped data once we know who's logged in.
  try{
    const res = await fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
    if(res.ok){
      const data = await res.json();
      currentUser = data.user;
      renderUserBadge();
      await startApp();
    } else {
      showLoginModal();
    }
  }catch(e){
    console.warn('auth check failed', e);
    showLoginModal();
  }
}

async function startApp(){
  const dashEl = document.getElementById('dashboardsView');
  const probEl = document.getElementById('problemsView');
  if(dashEl) dashEl.style.display = '';
  if(probEl) probEl.style.display = 'none';
  document.querySelectorAll('#navTabs button').forEach(function(b){
    b.classList.toggle('active', b.dataset.nav === 'dashboards');
  });

  loadPins().catch(function(e){ console.warn('pins preload', e); });

  // Load hosts/groups BEFORE first paint so pickers are populated
  try{
    await Promise.all([ensureAllHosts(), ensureAllGroups()]);
  }catch(e){
    console.warn('preload hosts/groups failed', e);
  }

  try{
    await showDashboardList();
  }catch(e){
    console.error(e);
    if(dashEl){
      dashEl.innerHTML = '<div class="placeholder" style="padding:40px;"><div class="ph-sub">Metrics failed: '+String(e.message||e)+'</div></div>';
    }
  }

  // Deep links: ?tab=problems|metrics&dash=id&pdash=id
  try{
    const share = parseShareLink();
    if(share.tab === 'problems'){
      document.querySelectorAll('#navTabs button').forEach(function(b){
        b.classList.toggle('active', b.dataset.nav === 'problems');
      });
      if(dashEl) dashEl.style.display = 'none';
      if(probEl) probEl.style.display = '';
      await showProblemsView();
      if(share.pdash) openProblemRun(share.pdash);
    } else if(share.dash){
      openRun(share.dash);
    }
  }catch(e){ console.warn('share link', e); }

  // Deep link: ?drill_item=&drill_from=&drill_to=… opens series drill-down
  try{
    const q = new URLSearchParams(location.search);
    const drillItem = parseInt(q.get('drill_item') || '', 10);
    const drillFrom = parseInt(q.get('drill_from') || '', 10);
    const drillTo = parseInt(q.get('drill_to') || '', 10);
    if(drillItem && drillFrom && drillTo && typeof openPivotCellDrilldown === 'function'){
      openPivotCellDrilldown({
        itemid: drillItem,
        host: q.get('drill_host') || 'Host',
        colLabel: q.get('drill_col') || 'Metric',
        unit: q.get('drill_unit') || '',
        dateFrom: drillFrom,
        dateTo: drillTo,
        day_time_from: q.get('drill_hf') || null,
        day_time_to: q.get('drill_ht') || null,
        resolution: 'auto',
        multiplier: 1,
      });
    }
  }catch(e){ console.warn('drill deep link', e); }
}
