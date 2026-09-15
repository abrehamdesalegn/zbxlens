/**
 * dashboards.js — Metrics tab: list, builder, run, pivot tables, quick view, templates
 * Loaded as classic script (global scope). Order matters — see index.html.
 */

const dashState = {
  initialized: false,
  view: 'list',
  allHosts: [],
  allGroups: [],
  builder: null,
  builderHosts: [],
  /** hostid → { hostid, host, name, items[] } for hosts loaded only as item sources */
  sourceHostCache: {},
  /** itemid → { itemid, hostid, host_name, name, key_ } for label resolution */
  itemMetaCache: {},
  current: null,
  lastRunReq: null,
  quick: null,
};

const probState = {
  view: 'list',
  groups: [],
  hosts: [],
  builder: null,
  current: null,
  lastResult: null,
  dataReady: false,
  quick: null,
};

function dashRoot(){ return document.getElementById('dashboardsView'); }
function probRoot(){ return document.getElementById('problemsView'); }

async function ensureAllHosts(){
  if(dashState.allHosts && dashState.allHosts.length) return dashState.allHosts;
  const res = await apiFetch('/api/hosts');
  if(!res.ok){
    console.error('Failed to load hosts', res.status);
    dashState.allHosts = [];
    return [];
  }
  dashState.allHosts = await res.json();
  return dashState.allHosts;
}

async function ensureAllGroups(){
  if(dashState.allGroups && dashState.allGroups.length) return dashState.allGroups;
  const res = await apiFetch('/api/hostgroups');
  if(!res.ok){
    dashState.allGroups = [];
    return [];
  }
  dashState.allGroups = await res.json();
  return dashState.allGroups;
}

async function fetchHostsItems(hostids){
  if(!hostids || !hostids.length) return [];
  const res = await apiFetch('/api/hosts-items', {
    method: 'POST',
    body: JSON.stringify({ hostids: hostids.map(function(id){ return parseInt(id, 10); }) }),
  });
  if(!res.ok) throw new Error('Failed to load host items ('+res.status+')');
  return await res.json();
}

function newColumn(){
  return {
    id: 'col_' + Math.random().toString(36).slice(2, 9),
    label: 'New metric',
    aggregations: ['avg', 'max'],
    multiplier: 1,
    unit: '',
    decimals: 1,
    color_mode: 'none',
    display: 'number', // number | bar | number_bar | graph | number_graph
    thresholds: { mode: 'high_bad', yellow: 75, red: 90 },
    host_items: {},
  };
}

/** True when the column label is still the placeholder and should be replaced by a real metric name. */
function isGenericMetricLabel(label){
  const t = String(label || '').trim().toLowerCase();
  return !t || t === 'new metric' || /^metric\s*\d*$/i.test(t) || t === 'column';
}

/**
 * Derive a short human label from a Zabbix item name/key (e.g. bandwidth, traffic rate).
 * Used when a column is still titled "New metric".
 */
function deriveMetricLabelFromItem(item){
  if(!item) return '';
  const name = String(item.name || '').trim();
  const key = String(item.key_ || '').trim();
  // Prefer a clean item name when it isn't just the raw key
  if(name && name.toLowerCase() !== key.toLowerCase()){
    // Strip common Zabbix template noise: "Interface eth0: Bits received" → keep meaningful part
    let cleaned = name
      .replace(/^Interface\s+[^:]+:\s*/i, '')
      .replace(/\s*\([^)]*\)\s*$/g, '')
      .trim();
    if(cleaned.length > 40) cleaned = cleaned.slice(0, 40).trim();
    if(cleaned) return cleaned;
  }
  // Fall back to a readable form of the key
  if(key){
    let k = key.replace(/\[[^\]]*\]/g, '').replace(/[._]+/g, ' ').trim();
    if(k.length > 36) k = k.slice(0, 36).trim();
    return k || key;
  }
  return name || '';
}

/** If col still has a generic label, set it from the first mapped item and refresh the label input. */
function maybeApplyMetricLabelFromItem(col, item){
  if(!col || !item || !isGenericMetricLabel(col.label)) return false;
  const derived = deriveMetricLabelFromItem(item);
  if(!derived) return false;
  col.label = derived;
  // Keep builder UI in sync if the label input is on screen
  try{
    const input = document.querySelector('.col-row[data-col="'+col.id+'"] .col-label');
    if(input) input.value = derived;
  }catch(_){}
  return true;
}

function matchItemOnHost(host, query){
  const q = (query || '').trim().toLowerCase();
  if(!q) return null;
  const items = host.items || [];
  // Score candidates: exact key > exact name > key prefix > name prefix > includes
  let best = null, bestScore = 0;
  items.forEach(function(i){
    const k = (i.key_ || '').toLowerCase();
    const n = (i.name || '').toLowerCase();
    let score = 0;
    if(k === q) score = 100;
    else if(n === q) score = 90;
    else if(k.startsWith(q)) score = 70;
    else if(n.startsWith(q)) score = 60;
    else if(k.includes(q)) score = 40;
    else if(n.includes(q)) score = 30;
    // Prefer shorter keys on ties (more specific)
    if(score > 0) score += Math.max(0, 10 - Math.min(10, k.length / 5));
    if(score > bestScore){ bestScore = score; best = i; }
  });
  return best;
}

function autoMapAllColumns(){
  const b = dashState.builder;
  if(!b || !b.columns.length){ showToast('Add metric columns first.', { type: 'warn' }); return; }
  const hosts = dashState.builderHosts || [];
  if(!hosts.length){ showToast('Load hosts first (pick hosts above).', { type: 'warn' }); return; }
  if(!hosts.some(function(h){ return (h.items||[]).length; })){
    showToast('Host items not loaded yet — wait a moment and try again.', { type: 'warn' });
    return;
  }
  let total = 0;
  b.columns.forEach(function(col){
    // Prefer an already-mapped item's key as the seed; else column label
    const seeds = [];
    if(col.host_items){
      for(let i=0;i<hosts.length;i++){
        const hid = String(hosts[i].hostid);
        const iid = col.host_items[hid];
        if(iid){
          const it = (hosts[i].items||[]).find(function(x){ return String(x.itemid)===String(iid); });
          if(it && it.key_){ seeds.push(it.key_); break; }
          if(it && it.name){ seeds.push(it.name); break; }
        }
      }
    }
    if(col.label) seeds.push(col.label);
    // Common Zabbix key aliases by label keywords
    const lab = (col.label||'').toLowerCase();
    if(/cpu/.test(lab)) seeds.push('system.cpu.util', 'cpu');
    if(/mem|memory|ram/.test(lab)) seeds.push('vm.memory.util', 'memory');
    if(/disk|space|fs/.test(lab)) seeds.push('vfs.fs.size', 'fs.size');
    if(/ping|avail|icmp/.test(lab)) seeds.push('icmpping', 'icmppingsec');
    if(/net|traffic|if/.test(lab)) seeds.push('net.if', 'if.in');
    if(!col.host_items) col.host_items = {};
    hosts.forEach(function(h){
      if(col.host_items[String(h.hostid)]) return; // don't overwrite
      let match = null;
      for(let s=0;s<seeds.length;s++){
        match = matchItemOnHost(h, seeds[s]);
        if(match) break;
      }
      if(match){
        col.host_items[String(h.hostid)] = parseInt(match.itemid, 10);
        maybeApplyMetricLabelFromItem(col, match);
        total++;
      }
    });
  });
  renderColRows();
  renderMapGrid();
  showToast(total ? ('Auto-mapped '+total+' cell'+(total===1?'':'s')+'.') : 'No additional matches — type a key in a column header and press Enter.', { type: total ? 'success' : 'warn' });
}

function mapCoverageHtml(){
  const b = dashState.builder;
  if(!b) return '';
  const hosts = dashState.builderHosts || [];
  if(!hosts.length || !b.columns.length) return '';
  let mapped = 0, total = hosts.length * b.columns.length;
  b.columns.forEach(function(col){
    hosts.forEach(function(h){
      if(col.host_items && col.host_items[String(h.hostid)]) mapped++;
    });
  });
  const pct = total ? Math.round(mapped / total * 100) : 0;
  const tone = pct === 100 ? 'ok' : (pct >= 50 ? 'warn' : 'bad');
  return '<span class="insight-chip '+tone+'" id="mapCoverageChip"><b>'+mapped+'/'+total+'</b> mapped ('+pct+'%)</span>';
}

function metricClass(value, col){
  if(value === null || value === undefined || typeof value !== 'number') return 'metric-empty';
  const th = col && col.thresholds;
  let mode, yellow, red;
  if(th && th.mode && th.mode !== 'off'){
    mode = th.mode;
    yellow = Number(th.yellow);
    red = Number(th.red);
  } else if(col && col.color_mode && col.color_mode !== 'none'){
    mode = col.color_mode === 'good_high' ? 'high_good' : 'high_bad';
    yellow = 75;
    red = mode === 'high_bad' ? 90 : 50;
  } else {
    return '';
  }
  if(isNaN(yellow) || isNaN(red)) return '';
  if(mode === 'high_bad'){
    if(value >= red) return 'metric-bad';
    if(value >= yellow) return 'metric-warn';
    return 'metric-good';
  }
  if(value <= red) return 'metric-bad';
  if(value <= yellow) return 'metric-warn';
  return 'metric-good';
}

async function showDashboardList(){
  dashState.view = 'list';
  const root = dashRoot();
  if(!root) return;
  if(!(dashState.allHosts&&dashState.allHosts.length) || !(dashState.allGroups&&dashState.allGroups.length)){
    try{ await Promise.all([ensureAllHosts(), ensureAllGroups()]); }catch(e){ console.warn(e); }
  }
    root.innerHTML = loadingStateHtml('Loading dashboards…');

  let dashboards = [];
  try{
    const res = await apiFetch('/api/dashboards', { timeoutMs: 12000 });
    if(!res.ok) throw new Error('HTTP '+res.status);
    dashboards = await res.json();
    if(dashboards && !Array.isArray(dashboards) && dashboards.id) dashboards = [dashboards];
    if(!Array.isArray(dashboards)) dashboards = [];
  }catch(err){
    root.innerHTML = errorStateHtml({
      title: 'Failed to load dashboards',
      body: String(err.message||err),
      retryId: 'dashListRetryBtn',
    });
    const retry = document.getElementById('dashListRetryBtn');
    if(retry) retry.addEventListener('click', function(){ loadDashboardsView(); });
    return;
  }

  await loadPins();

  function renderCards(list){
    return list.map(function(d){
      const nHosts = (d.hostids && d.hostids.length) || 0;
      const nCols = (d.columns && d.columns.length) || 0;
      const updated = d.updated_at ? new Date(d.updated_at*1000).toLocaleDateString() : '';
      const owner = d.mine ? 'You' : ('By '+escHtml(d.owner_username||'unknown'));
      const shareBadge = shareBadgeHtml(d);
      const pinned = isPinned('dashboard', d.id);
      const moreItems = [];
      moreItems.push('<button type="button" role="menuitem" data-act="export" data-id="'+d.id+'">Export JSON</button>');
      if(canManage()) moreItems.push('<button type="button" role="menuitem" data-act="dup" data-id="'+d.id+'">Duplicate</button>');
      if(d.can_edit){
        moreItems.push('<button type="button" role="menuitem" data-act="edit" data-id="'+d.id+'">Edit</button>');
        moreItems.push('<button type="button" role="menuitem" data-act="delete" data-id="'+d.id+'" class="danger">Delete</button>');
      }
      return '<div class="dash-card dash-card-clickable" data-dash-id="'+d.id+'" data-act="run" data-id="'+d.id+'" title="Open dashboard" role="button" tabindex="0">'+
        '<div class="dash-card-top">'+
          '<h4>'+escHtml(d.name||'Untitled')+shareBadge+'</h4>'+
          '<div class="dash-card-tools">'+
            '<button type="button" class="pin-btn'+(pinned?' pinned':'')+'" data-act="pin" data-id="'+d.id+'" title="'+(pinned?'Unpin':'Pin to top')+'">★</button>'+
            (moreItems.length
              ? '<div class="card-more">'+
                  '<button type="button" class="card-more-btn" data-act="more" aria-haspopup="true" aria-expanded="false" title="More actions">···</button>'+
                  '<div class="card-more-menu" role="menu" hidden>'+moreItems.join('')+'</div>'+
                '</div>'
              : '')+
          '</div>'+
        '</div>'+
        '<div class="dash-meta">'+owner+' · '+nHosts+' host'+(nHosts===1?'':'s')+' · '+nCols+' metric'+(nCols===1?'':'s')+(updated?' · updated '+updated:'')+'</div>'+
        '<div class="dash-card-hint">Click to run</div>'+
      '</div>';
    }).join('');
  }

  function sortDashboards(list){
    const sorted = list.slice();
    const sortSel = document.getElementById('dashSort');
    if(sortSel && sortSel.value === 'name'){
      sorted.sort(function(a,b){ return (a.name||'').localeCompare(b.name||''); });
    } else {
      sorted.sort(function(a,b){
        const pa = isPinned('dashboard', a.id) ? 1 : 0, pb = isPinned('dashboard', b.id) ? 1 : 0;
        return (pb - pa) || ((b.updated_at||0) - (a.updated_at||0));
      });
    }
    return sorted;
  }

  const cards = renderCards(sortDashboards(dashboards));

  let groupOpts = '<option value="">— optional host group —</option>';
  try{
    (dashState.allGroups||[]).forEach(function(g){
      groupOpts += '<option value="'+g.groupid+'">'+(g.name||g.groupid)+' ('+(g.host_count||0)+')</option>';
    });
  }catch(e){ console.warn(e); }
  const nowSec = Math.floor(Date.now()/1000);
  let fromVal = '', toVal = '';
  try{
    fromVal = fromEpochToLocalInput(nowSec - 24*3600);
    toVal = fromEpochToLocalInput(nowSec);
  }catch(e){
    console.warn('date helpers', e);
    const d = new Date();
    const p = function(n){ return String(n).padStart(2,'0'); };
    toVal = d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'T'+p(d.getHours())+':'+p(d.getMinutes());
    const d2 = new Date(d.getTime()-86400000);
    fromVal = d2.getFullYear()+'-'+p(d2.getMonth()+1)+'-'+p(d2.getDate())+'T'+p(d2.getHours())+':'+p(d2.getMinutes());
  }

  try{
  root.innerHTML =
    '<div class="filterbar qv-bar qv-bar-ref qv-bar-compact" style="margin-bottom:12px;">'+
      /* Row 1: Host groups | Hosts | Metric | Value | Clear */
      '<div class="qv-row qv-row-scope">'+
        '<div class="field qv-field-groups"><label>Host groups</label>'+
          '<div class="picker" id="dqGroupsPicker">'+
            '<div class="picker-trigger" id="dqGroupsTrigger" tabindex="0">'+
              '<span class="picker-placeholder" id="dqGroupsPlaceholder">Select host groups…</span>'+
              '<svg class="picker-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 9L12 15L18 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'+
            '</div>'+
            '<div class="picker-panel" id="dqGroupsPanel">'+
              '<input class="picker-search" id="dqGroupsSearch" placeholder="Filter groups…" autocomplete="off">'+
              '<div class="picker-list" id="dqGroupsList"></div>'+
            '</div>'+
          '</div></div>'+
        '<div class="field qv-field-hosts"><label>Hosts</label>'+
          '<div class="picker" id="dqHostsPicker">'+
            '<div class="picker-trigger" id="dqHostsTrigger" tabindex="0">'+
              '<span class="picker-placeholder" id="dqHostsPlaceholder">Select groups or hosts…</span>'+
              '<svg class="picker-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 9L12 15L18 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'+
            '</div>'+
            '<div class="picker-panel" id="dqHostsPanel">'+
              '<input class="picker-search" id="dqHostsSearch" placeholder="Filter hosts…" autocomplete="off">'+
              '<div class="picker-list" id="dqHostsList"></div>'+
            '</div>'+
          '</div></div>'+
        '<div class="field qv-field-items"><label>Metric</label>'+
          '<div class="picker" id="dqItemPicker">'+
            '<div class="picker-trigger" id="dqItemTrigger" tabindex="0">'+
              '<span class="picker-placeholder" id="dqItemPlaceholder">Select hosts first…</span>'+
              '<svg class="picker-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 9L12 15L18 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'+
            '</div>'+
            '<div class="picker-panel" id="dqItemPanel">'+
              '<input class="picker-search" id="dqItemSearch" placeholder="Filter metrics…" autocomplete="off">'+
              '<div class="picker-list" id="dqItemList"></div>'+
            '</div>'+
          '</div></div>'+
        '<div class="field qv-field-value"><label>Value</label>'+
          '<div class="toolbar-row dq-agg-bar" id="dqAggBar" role="group" aria-label="Value">'+
            '<button type="button" class="chip-btn" data-agg="min">min</button>'+
            '<button type="button" class="chip-btn active" data-agg="avg">avg</button>'+
            '<button type="button" class="chip-btn" data-agg="max">max</button>'+
            '<button type="button" class="chip-btn" data-agg="last">last</button>'+
          '</div></div>'+
        '<div class="field qv-field-clear"><label>&nbsp;</label>'+
          '<button type="button" class="btn btn-ghost" id="dqClearBtn" title="Clear selection">Clear</button></div>'+
      '</div>'+
      /* Row 2: From | To | RANGE | HOURS | Compare | Show metrics */
      '<div class="qv-row qv-row-time">'+
        '<div class="field" style="flex:0 0 168px;"><label for="dqFrom">From</label><input type="datetime-local" id="dqFrom" value="'+fromVal+'"></div>'+
        '<div class="field" style="flex:0 0 168px;"><label for="dqTo">To</label><input type="datetime-local" id="dqTo" value="'+toVal+'"></div>'+
        datePresetBar('dqFrom','dqTo')+
        dayHoursPresetBar('dqDayFrom','dqDayTo','dqDay')+
        '<label class="dash-run-compare" title="Compare with previous period of equal length">'+
          '<input type="checkbox" id="dqComparePrev"> Compare previous</label>'+
        '<div class="qv-field-actions qv-field-actions-end">'+
          '<button class="btn btn-primary" id="dqRunBtn"><span class="spinner"></span><span class="btn-label">Show metrics</span></button>'+
        '</div>'+
      '</div>'+
      '<div class="qv-status-line"><span class="status-msg" id="dqStatus"></span></div>'+
      '<div id="dqResults" style="margin-top:8px;"></div>'+
    '</div>'+
    '<div class="eyebrow dash-list-head" style="margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">'+
      '<span>Saved dashboards</span>'+
      '<span class="dash-list-head-actions">'+
        (canManage() ? '<button type="button" class="btn btn-primary" id="dashNewBtn" style="height:30px;padding:0 12px;font-size:12px;">+ New dashboard</button>' : '')+
        (canManage() ? '<button type="button" class="btn btn-ghost" id="dashImportBtn" style="height:30px;padding:0 10px;font-size:12px;">Import JSON</button>' : '')+
      '</span>'+
    '</div>'+
    (dashboards.length > 1 ? '<div class="list-toolbar">'+
      '<input type="search" id="dashSearch" placeholder="Filter dashboards by name…">'+
      '<select id="dashSort">'+
        '<option value="updated">Sort: Recently updated</option>'+
        '<option value="name">Sort: Name (A–Z)</option>'+
      '</select>'+
    '</div>' : '')+
    (dashboards.length === 0
      ? emptyStateHtml({
          icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.8"/><rect x="13" y="3" width="8" height="5" rx="1.5" stroke="currentColor" stroke-width="1.8"/><rect x="13" y="10" width="8" height="11" rx="1.5" stroke="currentColor" stroke-width="1.8"/><rect x="3" y="13" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.8"/></svg>',
          title: 'No metric dashboards yet',
          body: canManage()
            ? 'Create a saved pivot of hosts × metrics, or use Quick view above for a one-off check.'
            : 'No dashboards have been shared with you yet. Ask an Admin to share one, or use Quick view above.',
          actionsHtml: canManage()
            ? '<div class="es-actions"><button type="button" class="btn btn-primary" id="emptyNewDashBtn">New dashboard</button></div>'
            : '',
        })
      : '')+
    '<div class="dash-list" id="dashListGrid">'+cards+
      (canManage() && dashboards.length > 0 ?
      '<div class="new-dash-card" id="newDashCard" role="button" tabindex="0">'+
        '<div class="new-dash-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 5V19M5 12H19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></div>'+
        '<div class="new-dash-title">New dashboard</div>'+
        '<div class="new-dash-sub">Create a multi-column metrics layout</div>'+
      '</div>' : '')+
    '</div>';

  }catch(renderErr){
    console.error(renderErr);
    root.innerHTML = '<div class="placeholder" style="padding:40px;"><div class="ph-sub">UI render failed: '+String(renderErr.message||renderErr)+'</div></div>';
    return;
  }

  if(!dashState.quick) dashState.quick = { hostids: [], groupids: [], hostsWithItems: [], selectedItemQuery: '', selectedItemLabel: '' };
  if(!dashState.quick.groupids) dashState.quick.groupids = [];

  const newDashCard = document.getElementById('newDashCard');
  if(newDashCard) newDashCard.addEventListener('click', async function(){
    const pick = await pickTemplateModal(DASH_TEMPLATES);
    if(pick === undefined) return; // cancelled
    if(pick) openBuilderFromTemplate(pick);
    else openBuilder(null);
  });

  const emptyNewDashBtn = document.getElementById('emptyNewDashBtn');
  if(emptyNewDashBtn){
    emptyNewDashBtn.addEventListener('click', async function(){
      if(newDashCard){ newDashCard.click(); return; }
      const pick = await pickTemplateModal(DASH_TEMPLATES);
      if(pick === undefined) return;
      if(pick) openBuilderFromTemplate(pick);
      else openBuilder(null);
    });
  }

  const importBtn = document.getElementById('dashImportBtn');
  if(importBtn) importBtn.addEventListener('click', function(){
    const input = document.getElementById('importFileInput');
    input.onchange = async function(){
      const file = input.files[0];
      input.value = '';
      if(!file) return;
      try{
        const text = await file.text();
        const obj = JSON.parse(text);
        if(!obj || !Array.isArray(obj.hostids) || !Array.isArray(obj.columns)){
          throw new Error('Not a recognized dashboard export');
        }
        openBuilder({ name: (obj.name||'Imported dashboard')+' (imported)', hostids: obj.hostids, columns: obj.columns, is_shared: false, shared_userids: [], shared_usrgrpids: [] });
        showToast('Imported — review and save to keep it.', { type: 'success' });
      }catch(err){
        showToast('Import failed: '+(err.message||err), { type: 'warn' });
      }
    };
    input.click();
  });

  function cardNameFor(id){
    const d = dashboards.find(function(x){ return x.id === id; });
    return d ? d.name : '';
  }
  function wireCardActions(){
    function runDash(id){
      if(!id) return;
      pushRecent('dash', id, cardNameFor(id));
      openRun(id);
    }
    root.querySelectorAll('.dash-card-clickable').forEach(function(card){
      card.addEventListener('click', function(e){
        // Ignore clicks on tools / menu
        if(e.target.closest && e.target.closest('.dash-card-tools, .card-more-menu, .pin-btn, .card-more-btn')) return;
        runDash(card.dataset.id);
      });
      card.addEventListener('keydown', function(e){
        if(e.key === 'Enter' || e.key === ' '){
          e.preventDefault();
          runDash(card.dataset.id);
        }
      });
    });
    root.querySelectorAll('[data-act="run"]').forEach(function(b){
      if(b.classList.contains('dash-card-clickable')) return;
      b.addEventListener('click', function(){
        runDash(b.dataset.id);
      });
    });
    root.querySelectorAll('[data-act="edit"]').forEach(function(b){
      b.addEventListener('click', async function(e){
        e.stopPropagation();
        try{
          const res = await apiFetch('/api/dashboards/'+b.dataset.id);
          if(!res.ok) throw new Error('HTTP '+res.status);
          const d = await res.json();
          pushRecent('dash', d.id, d.name);
          openBuilder(d);
        }catch(err){ showToast('Failed to load dashboard: '+(err.message||err), { type: 'warn' }); }
      });
    });
    root.querySelectorAll('[data-act="dup"]').forEach(function(b){
      b.addEventListener('click', async function(e){
        e.stopPropagation();
        try{
          const res = await apiFetch('/api/dashboards/'+b.dataset.id);
          if(!res.ok) throw new Error('HTTP '+res.status);
          const d = await res.json();
          const created = await apiFetch('/api/dashboards', {
            method: 'POST',
            body: JSON.stringify({
              name: (d.name||'Untitled')+' (copy)', hostids: d.hostids, columns: d.columns,
              is_shared: false, shared_userids: [], shared_usrgrpids: [],
            }),
          });
          if(!created.ok){
            const err = await created.json().catch(function(){ return {}; });
            throw new Error(formatApiDetail(err.detail, 'HTTP '+created.status));
          }
          showToast('Dashboard duplicated (as a private copy).', { type: 'success' });
          showDashboardList();
        }catch(err){ showToast('Duplicate failed: '+(err.message||err), { type: 'warn' }); }
      });
    });
    root.querySelectorAll('[data-act="export"]').forEach(function(b){
      b.addEventListener('click', async function(e){
        e.stopPropagation();
        try{
          const res = await apiFetch('/api/dashboards/'+b.dataset.id);
          if(!res.ok) throw new Error('HTTP '+res.status);
          const d = await res.json();
          downloadText(
            (d.name||'dashboard').replace(/[^a-z0-9]+/gi,'_')+'.json',
            JSON.stringify({ name: d.name, hostids: d.hostids, columns: d.columns }, null, 2),
            'application/json'
          );
        }catch(err){ showToast('Export failed: '+(err.message||err), { type: 'warn' }); }
      });
    });
    root.querySelectorAll('[data-act="pin"]').forEach(function(b){
      b.addEventListener('click', function(e){
        e.stopPropagation();
        togglePin('dashboard', b.dataset.id, b.classList.contains('pinned'), function(){ showDashboardList(); });
      });
    });
    root.querySelectorAll('[data-act="delete"]').forEach(function(b){
      b.addEventListener('click', async function(e){
        e.stopPropagation();
        const ok = await confirmModal('Delete this dashboard? This cannot be undone.', { title: 'Delete dashboard' });
        if(!ok) return;
        try{
          const res = await apiFetch('/api/dashboards/'+b.dataset.id, { method: 'DELETE' });
          if(!res.ok){
            const err = await res.json().catch(function(){ return {}; });
            throw new Error((typeof formatApiDetail === 'function' ? formatApiDetail(err.detail, 'HTTP '+res.status) : (err.detail && (err.detail.message || JSON.stringify(err.detail))) || ('HTTP '+res.status)));
          }
          showToast('Dashboard deleted.');
          showDashboardList();
        }catch(err){ showToast('Delete failed: '+(err.message||err), { type: 'warn' }); }
      });
    });
  }
  wireCardActions();

  // ··· more menu on dashboard cards
  root.querySelectorAll('.card-more-btn').forEach(function(btn){
    btn.addEventListener('click', function(e){
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const menu = btn.parentElement && btn.parentElement.querySelector('.card-more-menu');
      if(!menu) return;
      const willOpen = menu.hidden;
      root.querySelectorAll('.card-more-menu').forEach(function(m){ m.hidden = true; });
      root.querySelectorAll('.card-more-btn').forEach(function(b){ b.setAttribute('aria-expanded','false'); });
      if(willOpen){
        menu.hidden = false;
        btn.setAttribute('aria-expanded','true');
      }
    });
  });
  // Close menus on outside click (defer so the opening click doesn't close immediately)
  if(root._dashMoreCloser) document.removeEventListener('click', root._dashMoreCloser);
  root._dashMoreCloser = function(e){
    if(e.target.closest && e.target.closest('.card-more')) return;
    root.querySelectorAll('.card-more-menu').forEach(function(m){ m.hidden = true; });
    root.querySelectorAll('.card-more-btn').forEach(function(b){ b.setAttribute('aria-expanded','false'); });
  };
  document.addEventListener('click', root._dashMoreCloser);

  async function startNewDashboard(){
    const pick = await pickTemplateModal(DASH_TEMPLATES);
    if(pick === undefined) return;
    if(pick) openBuilderFromTemplate(pick);
    else openBuilder(null);
  }
  const dashNewBtn = document.getElementById('dashNewBtn');
  if(dashNewBtn) dashNewBtn.addEventListener('click', function(){ startNewDashboard(); });

  const searchInput = document.getElementById('dashSearch');
  const sortSelect = document.getElementById('dashSort');
  function applyDashFilter(){
    if(!searchInput) return;
    const f = searchInput.value.trim().toLowerCase();
    const filtered = !f ? dashboards.slice() : dashboards.filter(function(d){ return (d.name||'').toLowerCase().includes(f); });
    const grid = document.getElementById('dashListGrid');
    const newCard = document.getElementById('newDashCard');
    grid.innerHTML = renderCards(sortDashboards(filtered));
    if(newCard) grid.appendChild(newCard);
    wireCardActions();
  }
  if(searchInput) searchInput.addEventListener('input', applyDashFilter);
  if(sortSelect) sortSelect.addEventListener('change', applyDashFilter);

  try{ wireDashQuickView(); wireDatePresets(root, 'dqFrom', 'dqTo'); wireDayHoursPresets(root, 'dqDay'); }catch(e){ console.error(e); }
}


function wireDashQuickView(){
  const q = dashState.quick;
  if(!q.selectedItemQuery) q.selectedItemQuery = '';
  if(!q.selectedItemLabel) q.selectedItemLabel = '';

  function allItemsFromHosts(){
    const byKey = {};
    (q.hostsWithItems||[]).forEach(function(h){
      (h.items||[]).forEach(function(it){
        const k = it.key_ || '';
        if(!byKey[k]) byKey[k] = { key_: k, name: it.name, units: it.units, host_count: 0 };
        byKey[k].host_count++;
      });
    });
    return Object.keys(byKey).map(function(k){ return byKey[k]; })
      .sort(function(a,b){ return (a.name||'').localeCompare(b.name||''); });
  }

  function renderDqItemOptions(filter){
    const list = document.getElementById('dqItemList');
    if(!list) return;
    if(!q.hostids.length){
      list.innerHTML = '<div class="picker-empty">Select hosts first.</div>';
      return;
    }
    if(!q.hostsWithItems || !q.hostsWithItems.length){
      list.innerHTML = '<div class="picker-empty">Loading items…</div>';
      return;
    }
    if(!q.selectedItems) q.selectedItems = [];
    const f = (filter||'').trim().toLowerCase();
    const items = allItemsFromHosts().filter(function(it){
      return !f || (it.name||'').toLowerCase().includes(f) || (it.key_||'').toLowerCase().includes(f);
    });
    if(!items.length){
      list.innerHTML = '<div class="picker-empty">No items match.</div>';
      return;
    }
    const selectedKeys = {};
    q.selectedItems.forEach(function(x){ selectedKeys[x.query] = true; });
    const shown = items.slice(0, 200);
    let htmlOut = '';
    if(items.length > 200){
      htmlOut += '<div class="picker-empty" style="text-align:left;">Showing 200 of '+items.length+' — type to filter…</div>';
    }
    htmlOut += shown.map(function(it){
      const key = it.key_ || '';
      const selected = !!selectedKeys[key];
      return '<label class="picker-option" style="'+(selected?'background:rgba(63,201,201,.12);':'')+'">'+
        '<input type="checkbox" value="'+key.replace(/"/g,'&quot;')+'" data-name="'+(it.name||'').replace(/"/g,'&quot;')+'" '+(selected?'checked':'')+'>'+
        '<div class="opt-main">'+
          '<div class="opt-name">'+(it.name||key)+'</div>'+
          '<div class="opt-meta">'+key+' · on '+it.host_count+' host'+(it.host_count===1?'':'s')+'</div>'+
        '</div></label>';
    }).join('');
    list.innerHTML = htmlOut;
    list.querySelectorAll('input[type=checkbox]').forEach(function(cb){
      cb.addEventListener('change', function(e){
        e.stopPropagation();
        const key = cb.value;
        const label = cb.dataset.name || key;
        if(cb.checked){
          if(!q.selectedItems.some(function(x){ return x.query === key; })){
            q.selectedItems.push({ query: key, label: label });
          }
        } else {
          q.selectedItems = q.selectedItems.filter(function(x){ return x.query !== key; });
        }
        q.selectedItemQuery = q.selectedItems.length ? q.selectedItems[0].query : '';
        q.selectedItemLabel = q.selectedItems.length ? q.selectedItems[0].label : '';
        renderDqItemTrigger();
      });
      // prevent label click from closing panel awkwardly
      cb.addEventListener('click', function(e){ e.stopPropagation(); });
    });
  }


  function renderDqItemTrigger(){
    const trigger = document.getElementById('dqItemTrigger');
    const placeholder = document.getElementById('dqItemPlaceholder');
    if(!trigger) return;
    if(!q.selectedItems) q.selectedItems = [];
    if(!q.selectedItems.length && q.selectedItemQuery){
      q.selectedItems = [{ query: q.selectedItemQuery, label: q.selectedItemLabel || q.selectedItemQuery }];
    }
    trigger.querySelectorAll('.pill').forEach(function(p){ p.remove(); });
    const n = q.selectedItems.length;
    placeholder.style.display = '';
    if(!n){
      placeholder.textContent = q.hostids.length ? 'Search & select one or more items…' : 'Select hosts first…';
      placeholder.classList.remove('picker-summary');
      return;
    }
    placeholder.classList.add('picker-summary');
    if(n === 1){
      placeholder.textContent = q.selectedItems[0].label || q.selectedItems[0].query;
    } else {
      placeholder.textContent = n + ' items selected';
    }
  }

  function renderDqHostOptions(filter){
    const list = document.getElementById('dqHostsList');
    if(!list) return;
    const f = (filter||'').trim().toLowerCase();
    const scopeIds = new Set((q.hostids||[]).map(function(id){ return parseInt(id,10); }));
    const fromGroups = !!q._hostsFromGroups && scopeIds.size > 0;
    // Prefer hosts returned by the group API; fall back to global catalog
    let source = [];
    if(fromGroups && q.scopedHosts && q.scopedHosts.length){
      source = q.scopedHosts.slice();
    } else if(fromGroups && scopeIds.size){
      // Build from allHosts + any missing ids as stubs
      const byId = {};
      (dashState.allHosts||[]).forEach(function(h){ byId[parseInt(h.hostid,10)] = h; });
      source = Array.from(scopeIds).map(function(id){
        return byId[id] || { hostid: id, host: String(id), name: String(id) };
      });
    } else {
      source = dashState.allHosts || [];
    }
    const filtered = source.filter(function(h){
      const label = (h.name||h.host||'');
      return !f || label.toLowerCase().includes(f) || String(h.groups||'').toLowerCase().includes(f);
    });
    const selected = new Set((q.hostids||[]).map(function(id){ return parseInt(id,10); }));
    if(!filtered.length){
      list.innerHTML = '<div class="picker-empty">'+(source.length ? 'No hosts match.' : 'No hosts loaded. Pick a host group first.')+'</div>';
    } else {
      list.innerHTML = filtered.map(function(h){
        const hid = parseInt(h.hostid,10);
        return '<label class="picker-option">'+
          '<input type="checkbox" value="'+hid+'" '+(selected.has(hid)?'checked':'')+'>'+
          '<div class="opt-main"><div class="opt-name">'+escHtml(h.name||h.host||String(hid))+'</div>'+
          '<div class="opt-meta">'+escHtml(String(h.groups||''))+'</div></div></label>';
      }).join('');
    }
    list.querySelectorAll('input[type=checkbox]').forEach(function(cb){
      cb.addEventListener('change', async function(){
        const hid = parseInt(cb.value,10);
        if(cb.checked){ if(!q.hostids.includes(hid)) q.hostids.push(hid); }
        else { q.hostids = q.hostids.filter(function(id){ return parseInt(id,10)!==hid; }); }
        renderDqHostTrigger();
        q.hostsWithItems = q.hostids.length ? await fetchHostsItems(q.hostids) : [];
        q.selectedItemQuery = ''; q.selectedItemLabel = '';
        renderDqItemTrigger();
        renderDqItemOptions('');
      });
    });
  }

  function renderDqHostTrigger(){
    const trigger = document.getElementById('dqHostsTrigger');
    const placeholder = document.getElementById('dqHostsPlaceholder');
    if(!trigger || !placeholder) return;
    // Compact summary — never expand into a multi-line chip cloud
    trigger.querySelectorAll('.pill').forEach(function(p){ p.remove(); });
    const n = (q.hostids || []).length;
    if(!n){
      placeholder.style.display = '';
      placeholder.textContent = 'Select groups or hosts…';
      placeholder.classList.remove('picker-summary');
      return;
    }
    placeholder.style.display = '';
    placeholder.classList.add('picker-summary');
    if(n === 1){
      const hid = parseInt(q.hostids[0], 10);
      const h = (dashState.allHosts||[]).find(function(x){ return parseInt(x.hostid,10)===hid; });
      placeholder.textContent = h ? (h.name||h.host||hid) : String(hid);
    } else {
      placeholder.textContent = n + ' hosts selected';
    }
  }


  renderDqHostOptions();
  renderDqHostTrigger();
  renderDqItemTrigger();
  renderDqItemOptions('');

  document.getElementById('dqHostsTrigger').addEventListener('click', function(){
    const panel = document.getElementById('dqHostsPanel');
    if(!panel) return;
    const open = !panel.classList.contains('open');
    // close other picker panels
    if(typeof closeAllOpenPickers === 'function') closeAllOpenPickers(null);
    else {
      document.querySelectorAll('.picker-panel').forEach(function(p){ p.classList.remove('open'); p.style.display = ''; });
      document.querySelectorAll('.picker-trigger').forEach(function(t){ t.classList.remove('open'); });
    }
    if(open){
      panel.classList.add('open');
      panel.style.display = 'block';
      document.getElementById('dqHostsTrigger').classList.add('open');
      renderDqHostOptions((document.getElementById('dqHostsSearch')||{}).value||'');
      const s = document.getElementById('dqHostsSearch');
      if(s) s.focus();
    }
  });
  document.getElementById('dqHostsSearch').addEventListener('input', function(e){ renderDqHostOptions(e.target.value); });
  document.getElementById('dqItemTrigger').addEventListener('click', async function(){
    const panel = document.getElementById('dqItemPanel');
    if(!panel) return;
    const open = !panel.classList.contains('open');
    if(typeof closeAllOpenPickers === 'function') closeAllOpenPickers(null);
    else {
      document.querySelectorAll('.picker-panel').forEach(function(p){ p.classList.remove('open'); p.style.display = ''; });
      document.querySelectorAll('.picker-trigger').forEach(function(t){ t.classList.remove('open'); });
    }
    if(open){
      panel.classList.add('open');
      panel.style.display = 'block';
      document.getElementById('dqItemTrigger').classList.add('open');
      const list = document.getElementById('dqItemList');
      if(!q.hostids.length){
        if(list) list.innerHTML = '<div class="picker-empty">Select hosts first.</div>';
      } else if(!q.hostsWithItems || !q.hostsWithItems.length){
        if(list) list.innerHTML = '<div class="picker-empty">Loading items…</div>';
        try{
          q.hostsWithItems = await fetchHostsItems(q.hostids);
          renderDqItemOptions((document.getElementById('dqItemSearch')||{}).value||'');
        }catch(err){
          if(list) list.innerHTML = '<div class="picker-empty">Failed to load items</div>';
          return;
        }
      } else {
        renderDqItemOptions((document.getElementById('dqItemSearch')||{}).value||'');
      }
      const search = document.getElementById('dqItemSearch');
      if(search) search.focus();
    }
  });
  document.getElementById('dqItemSearch').addEventListener('input', function(e){ renderDqItemOptions(e.target.value); });

  // Multi host-group selection — auto-loads hosts when groups change
  if(!q.groupids) q.groupids = [];
  function renderDqGroupOptions(filter){
    const list = document.getElementById('dqGroupsList');
    if(!list) return;
    const f = (filter||'').trim().toLowerCase();
    const groups = dashState.allGroups || [];
    const selected = new Set((q.groupids||[]).map(function(id){ return parseInt(id,10); }));
    const rows = groups.filter(function(g){
      if(!f) return true;
      return String(g.name||'').toLowerCase().indexOf(f) >= 0;
    });
    list.innerHTML = rows.length ? rows.map(function(g){
      const gid = parseInt(g.groupid,10);
      const on = selected.has(gid);
      const cnt = (g.host_count != null) ? g.host_count : null;
      const label = escHtml(g.name||('Group '+gid))+(cnt!=null ? ' ('+cnt+')' : '');
      return '<label class="picker-option'+(on?' on':'')+'">'+
        '<input type="checkbox" data-groupid="'+gid+'"'+(on?' checked':'')+'>'+
        '<div class="opt-main"><div class="opt-name">'+label+'</div></div></label>';
    }).join('') : '<div class="picker-empty">No groups match.</div>';
    list.querySelectorAll('input[type=checkbox]').forEach(function(cb){
      cb.addEventListener('change', async function(){
        const gid = parseInt(cb.getAttribute('data-groupid'),10);
        if(cb.checked){
          if(q.groupids.indexOf(gid) < 0) q.groupids.push(gid);
        } else {
          q.groupids = q.groupids.filter(function(id){ return parseInt(id,10) !== gid; });
        }
        renderDqGroupOptions(document.getElementById('dqGroupsSearch')?.value||'');
        renderDqGroupTrigger();
        await loadHostsFromSelectedGroups();
      });
    });
  }
  function renderDqGroupTrigger(){
    const ph = document.getElementById('dqGroupsPlaceholder');
    if(!ph) return;
    const n = (q.groupids||[]).length;
    if(!n){ ph.textContent = 'Select host groups…'; ph.classList.remove('picker-summary'); return; }
    ph.classList.add('picker-summary');
    const selected = (dashState.allGroups||[]).filter(function(g){
      return q.groupids.indexOf(parseInt(g.groupid,10)) >= 0;
    }).map(function(g){
      const cnt = g.host_count != null ? g.host_count : null;
      return (g.name||g.groupid)+(cnt!=null ? ' ('+cnt+')' : '');
    });
    if(n === 1) ph.textContent = selected[0];
    else if(n === 2) ph.textContent = selected.join(', ');
    else ph.textContent = selected.slice(0,2).join(', ')+' +'+(n-2)+' more';
  }
  async function loadHostsFromSelectedGroups(){
    const status = document.getElementById('dqStatus');
    const gids = q.groupids || [];
    if(!gids.length){
      // Don't wipe manually picked hosts if user clears groups — only clear when groups drove selection
      if(q._hostsFromGroups){
        q.hostids = [];
        q.hostsWithItems = [];
        q.selectedItems = [];
        q.selectedItemQuery = '';
        q.selectedItemLabel = '';
        q._hostsFromGroups = false;
        renderDqHostOptions('');
        renderDqHostTrigger();
        renderDqItemOptions('');
        renderDqItemTrigger();
      }
      return;
    }
    if(status){ status.textContent = 'Loading hosts…'; status.className = 'status-msg'; }
    try{
      const results = await Promise.all(gids.map(function(gid){
        return apiFetch('/api/hostgroups/'+gid+'/hosts').then(function(res){
          if(!res.ok) throw new Error('HTTP '+res.status);
          return res.json();
        });
      }));
      const seen = {};
      const hostids = [];
      const hostObjs = [];
      results.forEach(function(hosts){
        (hosts||[]).forEach(function(h){
          const id = parseInt(h.hostid,10);
          if(!seen[id]){
            seen[id] = true;
            hostids.push(id);
            hostObjs.push(h);
          }
        });
      });
      // Merge into allHosts so the hosts dropdown can list them
      if(!dashState.allHosts) dashState.allHosts = [];
      const known = {};
      dashState.allHosts.forEach(function(h){ known[parseInt(h.hostid,10)] = true; });
      hostObjs.forEach(function(h){
        const id = parseInt(h.hostid,10);
        if(!known[id]){
          dashState.allHosts.push(h);
          known[id] = true;
        }
      });
      q.scopedHosts = hostObjs; // preferred list for dropdown when groups drive selection
      q.hostids = hostids;
      q._hostsFromGroups = true;
      q.hostsWithItems = [];
      q.selectedItems = [];
      q.selectedItemQuery = '';
      q.selectedItemLabel = '';
      renderDqHostOptions(document.getElementById('dqHostsSearch')?.value||'');
      renderDqHostTrigger();
      renderDqItemTrigger();
      // Load items after hosts are set (keep UI responsive)
      if(status) status.textContent = 'Loaded '+hostids.length+' host'+(hostids.length===1?'':'s')+' — loading items…';
      try{
        q.hostsWithItems = hostids.length ? await fetchHostsItems(hostids) : [];
      }catch(itemErr){
        console.warn('fetchHostsItems', itemErr);
        q.hostsWithItems = [];
      }
      renderDqItemOptions('');
      renderDqItemTrigger();
      if(status){
        const nItems = (function(){
          let n = 0;
          (q.hostsWithItems||[]).forEach(function(h){ n += (h.items||[]).length; });
          return n;
        })();
        status.textContent = 'Loaded '+hostids.length+' host'+(hostids.length===1?'':'s')+
          ' from '+gids.length+' group'+(gids.length===1?'':'s')+
          (nItems ? (' · '+nItems+' items available') : '')+'.';
      }
    }catch(err){
      if(status){ status.textContent = 'Failed: '+(err.message||err); status.className='status-msg warn'; }
    }
  }
  const groupsTrigger = document.getElementById('dqGroupsTrigger');
  if(groupsTrigger){
    groupsTrigger.addEventListener('click', function(){
      const panel = document.getElementById('dqGroupsPanel');
      if(!panel) return;
      const open = panel.style.display !== 'block';
      // close other pickers
      document.querySelectorAll('.picker-panel').forEach(function(p){ p.classList.remove('open'); p.style.display = ''; });
      document.querySelectorAll('.picker-trigger').forEach(function(t){ t.classList.remove('open'); });
      if(open){
        panel.style.display = 'block';
        groupsTrigger.classList.add('open');
        renderDqGroupOptions(document.getElementById('dqGroupsSearch')?.value||'');
        const s = document.getElementById('dqGroupsSearch');
        if(s) s.focus();
      }
    });
  }
  const groupsSearch = document.getElementById('dqGroupsSearch');
  if(groupsSearch) groupsSearch.addEventListener('input', function(e){ renderDqGroupOptions(e.target.value); });
  renderDqGroupOptions('');
  renderDqGroupTrigger();


  // Value (aggregation) multi-toggle: min / avg / max / last
  if(!q.aggregations || !q.aggregations.length) q.aggregations = ['avg'];
  function syncDqAggBar(){
    const bar = document.getElementById('dqAggBar');
    if(!bar) return;
    const set = new Set(q.aggregations || []);
    bar.querySelectorAll('[data-agg]').forEach(function(btn){
      btn.classList.toggle('active', set.has(btn.getAttribute('data-agg')));
    });
  }
  const aggBar = document.getElementById('dqAggBar');
  if(aggBar){
    aggBar.querySelectorAll('[data-agg]').forEach(function(btn){
      btn.addEventListener('click', function(){
        const a = btn.getAttribute('data-agg');
        const set = new Set(q.aggregations || []);
        if(set.has(a)){
          if(set.size <= 1) return; // keep at least one
          set.delete(a);
        } else {
          set.add(a);
        }
        // stable order
        q.aggregations = ['min','avg','max','last'].filter(function(x){ return set.has(x); });
        syncDqAggBar();
      });
    });
    syncDqAggBar();
  }

  const clearBtn = document.getElementById('dqClearBtn');
  if(clearBtn) clearBtn.addEventListener('click', function(){
    q.hostids = [];
    q.hostsWithItems = [];
    q.selectedItems = [];
    q.selectedItemQuery = '';
    q.selectedItemLabel = '';
    q.groupids = [];
    q._hostsFromGroups = false;
    q.scopedHosts = [];
    const groupSearch = document.getElementById('dqGroupsSearch');
    if(groupSearch) groupSearch.value = '';
    const hostSearch = document.getElementById('dqHostsSearch');
    if(hostSearch) hostSearch.value = '';
    const itemSearch = document.getElementById('dqItemSearch');
    if(itemSearch) itemSearch.value = '';
    renderDqGroupOptions('');
    renderDqGroupTrigger();
    renderDqHostOptions('');
    renderDqHostTrigger();
    renderDqItemOptions('');
    renderDqItemTrigger();
    const results = document.getElementById('dqResults');
    if(results) results.innerHTML = '';
    const status = document.getElementById('dqStatus');
    if(status){ status.textContent = ''; status.className = 'status-msg'; }
    showToast('Selection cleared.', { type: 'info' });
  });

  document.getElementById('dqRunBtn').addEventListener('click', async function(){
    const status = document.getElementById('dqStatus');
    const results = document.getElementById('dqResults');
    const btn = document.getElementById('dqRunBtn');
    const query = q.selectedItemQuery;
    const fromVal = document.getElementById('dqFrom').value;
    const toVal = document.getElementById('dqTo').value;
    if(!q.hostids.length){ status.textContent='Select hosts.'; status.className='status-msg warn'; return; }
    if(!query && !(q.selectedItems && q.selectedItems.length)){ status.textContent='Select an item.'; status.className='status-msg warn'; return; }
    if(!fromVal||!toVal){ status.textContent='Pick a date range.'; status.className='status-msg warn'; return; }
    btn.classList.add('loading'); btn.disabled = true;
    status.textContent=''; status.className='status-msg';
    results.innerHTML = loadingStateHtml('Loading metrics…');
    try{
      if(!q.hostsWithItems || !q.hostsWithItems.length) q.hostsWithItems = await fetchHostsItems(q.hostids);
      const itemsToRun = (q.selectedItems && q.selectedItems.length)
        ? q.selectedItems
        : (query ? [{ query: query, label: q.selectedItemLabel || query }] : []);
      if(!itemsToRun.length){
        status.textContent='Select at least one item.'; status.className='status-msg warn'; results.innerHTML=''; return;
      }
      const columns = [];
      let auditLines = [];
      itemsToRun.forEach(function(it, idx){
        const host_items = {};
        let mapped = 0, missingNames = [];
        (q.hostsWithItems||[]).forEach(function(h){
          const item = matchItemOnHost(h, it.query);
          if(item){ host_items[String(h.hostid)] = parseInt(item.itemid,10); mapped++; }
          else missingNames.push(h.name||h.host||h.hostid);
        });
        if(mapped){
          const aggs = (q.aggregations && q.aggregations.length) ? q.aggregations.slice() : ['avg'];
          columns.push({
            id: 'col_q'+idx, label: it.label || it.query,
            aggregations: aggs,
            // Quick view: base values from API (mult=1); unit/mult editable under header
            display: 'number',
            multiplier: 1, unit: '', decimals: 2, color_mode: 'none',
            thresholds: { mode: 'off', yellow: 75, red: 90 },
            raw: true, // do not auto-apply Zabbix item units
            host_items: host_items,
          });
        }
        if(missingNames.length){
          auditLines.push('<b>'+(it.label||it.query)+'</b>: missing on '+missingNames.length+' host(s) — '+missingNames.slice(0,8).join(', ')+(missingNames.length>8?'…':''));
        }
      });
      if(!columns.length){
        status.textContent='';
        results.innerHTML = emptyResultHtml({
          title: 'No hosts have the selected item(s)',
          body: 'None of the selected hosts expose those metrics. Check item keys or pick different hosts.',
        });
        return;
      }
      const hours = readDayHoursPreset('dqDay', 'dqDayFrom', 'dqDayTo');
      const dateFrom = toEpoch(fromVal), dateTo = toEpoch(toVal);
      const dayPayload = {
        day_time_from: hours.day_time_from,
        day_time_to: hours.day_time_to,
        tz_offset_min: apiTzOffsetMin(),
      };
      const res = await apiFetch('/api/dashboards/run-adhoc', {
        method: 'POST',
        timeoutMs: 60000,
        body: JSON.stringify(Object.assign({
          name: 'adhoc', hostids: q.hostids, columns: columns,
          date_from: dateFrom, date_to: dateTo,
        }, dayPayload)),
      });
      if(!res.ok){
        const err = await res.json().catch(function(){ return {}; });
        throw new Error((typeof formatApiDetail === 'function' ? formatApiDetail(err.detail, 'HTTP '+res.status) : (err.detail && (err.detail.message || JSON.stringify(err.detail))) || ('HTTP '+res.status)));
      }
      const data = await res.json();
      let prevResult = null;
      const comparePrev = !!(document.getElementById('dqComparePrev')||{}).checked;
      if(comparePrev){
        const span = dateTo - dateFrom;
        try{
          const prevRes = await apiFetch('/api/dashboards/run-adhoc', {
            method: 'POST',
            body: JSON.stringify(Object.assign({
              name: 'adhoc', hostids: q.hostids, columns: columns,
              date_from: dateFrom - span, date_to: dateFrom,
            }, dayPayload)),
          });
          if(prevRes.ok) prevResult = await prevRes.json();
        }catch(e){ console.warn('previous-period fetch failed', e); }
      }
      if(!(data.rows||[]).length){
        results.innerHTML = emptyResultHtml({
          title: 'No data for this range',
          body: 'Hosts were mapped but no values were returned. Try a wider date range or different hours.',
        });
        return;
      }
      dashState.quickLast = { columns: columns, data: data, prevResult: prevResult, dateFrom: dateFrom, dateTo: dateTo, hours: hours };
      results.innerHTML =
        '<div class="metrics-results-toolbar">'+
          computeInsightStrip({ columns: columns }, data) +
          '<div class="table-tools metrics-tools">'+
            '<input type="search" id="dqTableSearch" placeholder="Filter rows…">'+
            '<span class="table-tools-group">'+
              '<button type="button" class="btn-export" id="dqExportBtn">Export CSV</button>'+
              '<button type="button" class="btn-export" id="dqExportPdfBtn">Export PDF</button>'+
            '</span>'+
          '</div>'+
        '</div>'+
        renderPivot({ name: 'Quick view', columns: columns }, data, prevResult) +
        (auditLines.length ? '<div class="audit-box">'+auditLines.join('<br>')+'</div>' : '');
      const tbl = results.querySelector('table');
      makeTableSortable(tbl);
      wireTableSearch(document.getElementById('dqTableSearch'), tbl);
      wirePivotStickyHeaders(results);
      wirePivotDrilldown(results, dateFrom, dateTo, hours);
      // Enable host detail drawer (same as saved dashboards)
      dashState.current = { name: 'Quick view', columns: columns };
      wireHostDetailLinks(results, dateFrom, dateTo, hours);
      wireInsightHealthFilter(results);
      wireQuickColControls(results);
      const exportMeta = {
        title: 'Metrics quick view',
        dateFrom: dateFrom,
        dateTo: dateTo,
        day_time_from: hours.day_time_from,
        day_time_to: hours.day_time_to,
        comparePrev: comparePrev,
      };
      const qBase = (typeof sanitizeExportFilename === 'function'
        ? sanitizeExportFilename(exportMeta.title, 'metrics-quick')
        : 'metrics-quick');
      function doCsv(){ exportVisibleTable(results, qBase + '.csv', exportMeta); }
      function doPdf(){ exportVisibleTablePdf(results, qBase + '.pdf', exportMeta); }
      const ex = document.getElementById('dqExportBtn');
      if(ex) ex.addEventListener('click', doCsv);
      const exPdf = document.getElementById('dqExportPdfBtn');
      if(exPdf) exPdf.addEventListener('click', doPdf);
      // Top bar export buttons (mockup placement)
      const exTop = document.getElementById('dqExportBtnTop');
      if(exTop){ exTop.disabled = false; exTop.onclick = doCsv; }
      const exPdfTop = document.getElementById('dqExportPdfBtnTop');
      if(exPdfTop){ exPdfTop.disabled = false; exPdfTop.onclick = doPdf; }
    }catch(err){
      status.textContent = '';
      status.className='status-msg';
      var msg = '';
      try{
        if(typeof formatApiDetail === 'function'){
          msg = formatApiDetail(
            (err && err.detail != null) ? err.detail : (err && err.message != null ? err.message : err),
            'Request failed'
          );
        } else if(err && err.message){
          msg = String(err.message);
        } else if(typeof err === 'string'){
          msg = err;
        } else {
          try{ msg = JSON.stringify(err); }catch(_e){ msg = 'Request failed'; }
        }
      }catch(_e){ msg = 'Request failed'; }
      if(!msg || msg === '[object Object]'){
        msg = 'Request failed — open the browser console (F12) for details.';
      }
      console.error('Quick view metrics error', err);
      results.innerHTML = errorStateHtml({
        title: 'Could not load metrics',
        body: msg,
        retryId: 'dqRetryBtn',
      });
      const retry = document.getElementById('dqRetryBtn');
      if(retry) retry.addEventListener('click', function(){ btn.click(); });
    }finally{
      btn.classList.remove('loading'); btn.disabled = false;
    }
  });
}

function renderQuickPivot(dashboard, result){
  return renderPivot(dashboard, result);
}


async function openBuilderFromTemplate(tpl){
  await openBuilder(null);
  // After builder opens, apply template columns as stubs (user maps hosts/items)
  if(!dashState.builder) return;
  dashState.builder.name = tpl.name;
  const nameEl = document.getElementById('dashName');
  if(nameEl) nameEl.value = tpl.name;
  dashState.builder.columns = (tpl.columns||[]).map(function(c, idx){
    return {
      id: 'col_t'+idx,
      label: c.label,
      aggregations: c.aggregations || ['avg','max'],
      multiplier: c.multiplier != null ? c.multiplier : 1,
      unit: c.unit || '',
      decimals: 1,
      color_mode: 'none',
      thresholds: c.thresholds || { mode: 'off', yellow: 75, red: 90 },
      host_items: {},
      bulk_query: c.query || '',
    };
  });
  if(typeof renderColRows === 'function') renderColRows();
  if(typeof renderMapGrid === 'function') renderMapGrid();
  showToast('Template loaded — pick hosts, then map or bulk-apply each column.', { type: 'success' });
}

async function openBuilder(existing){
  dashState.view = 'builder';
  dashState.builder = existing
    ? {
        id: existing.id,
        name: existing.name,
        hostids: (existing.hostids||[]).map(function(id){ return parseInt(id,10); }),
        columns: JSON.parse(JSON.stringify(existing.columns||[])),
        selectedGroupIds: Array.isArray(existing.selectedGroupIds)
          ? existing.selectedGroupIds.map(function(id){ return parseInt(id,10); }).filter(Boolean)
          : (existing.selectedGroupId ? [parseInt(existing.selectedGroupId,10)] : []),
        is_shared: !!existing.is_shared,
        shared_userids: existing.shared_userids || [],
        shared_usrgrpids: existing.shared_usrgrpids || [],
      }
    : { id: null, name: '', hostids: [], columns: [], selectedGroupIds: [], is_shared: false, shared_userids: [], shared_usrgrpids: [] };
  await loadShareDirectories();
  (dashState.builder.columns||[]).forEach(function(c){
    if(!c.thresholds) c.thresholds = { mode: 'off', yellow: 75, red: 90 };
    if(!c.host_items) c.host_items = {};
    if(!c.aggregations || !c.aggregations.length) c.aggregations = ['avg','max'];
    if(!c.display) c.display = 'number';
  });
  dashState.builderHosts = [];
  dashState.sourceHostCache = dashState.sourceHostCache || {};
  renderBuilder();
  const statusEl = document.getElementById('builderStatus');
  if(statusEl){ statusEl.textContent = 'Loading hosts…'; statusEl.className='status-msg'; }
  try{
    await Promise.all([ensureAllHosts(), ensureAllGroups()]);
    if(dashState.builder.hostids.length){
      dashState.builderHosts = await fetchHostsItems(dashState.builder.hostids);
    }
    await hydrateMappedItemMeta(dashState.builder.columns);
    renderBuilder();
    if(statusEl) statusEl.textContent = '';
  }catch(err){
    if(statusEl){ statusEl.textContent = 'Load failed: '+(err.message||err); statusEl.className='status-msg warn'; }
  }
}

function renderBuilder(){
  const b = dashState.builder;
  const root = dashRoot();
  if(!Array.isArray(b.selectedGroupIds)) b.selectedGroupIds = [];

  root.innerHTML =
    '<div class="filterbar">'+
      '<div class="builder-head builder-meta-row">'+
        '<div class="field builder-field-name"><label for="dashName">Name</label>'+
          '<input id="dashName" placeholder="e.g. Campus CPU & memory" value="'+String(b.name||'').replace(/"/g,'&quot;')+'"></div>'+
        sharePickerHtml('dashShare', b.shared_userids || [], b.shared_usrgrpids || [])+
      '</div>'+
        '<div class="row builder-scope-row">'+
        '<div class="field builder-field-groups"><label>Host groups</label>'+
          '<div class="picker" id="dashGroupsPicker">'+
            '<div class="picker-trigger" id="dashGroupsTrigger" tabindex="0">'+
              '<span class="picker-placeholder" id="dashGroupsPlaceholder">Select host groups…</span>'+
              '<svg class="picker-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 9L12 15L18 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'+
            '</div>'+
            '<div class="picker-panel" id="dashGroupsPanel">'+
              '<input class="picker-search" id="dashGroupsSearch" placeholder="Filter groups…" autocomplete="off">'+
              '<div class="picker-list" id="dashGroupsList"></div>'+
            '</div>'+
          '</div></div>'+
        '<div class="field builder-field-hosts"><label>Hosts</label>'+
          '<div class="picker" id="dashHostsPicker">'+
            '<div class="picker-trigger picker-trigger-compact" id="dashHostsTrigger" tabindex="0">'+
              '<span class="picker-placeholder" id="dashHostsPlaceholder">Select hosts…</span>'+
              '<svg class="picker-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 9L12 15L18 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'+
            '</div>'+
            '<div class="picker-panel" id="dashHostsPanel">'+
              '<input class="picker-search" id="dashHostsSearch" placeholder="Filter hosts…" autocomplete="off">'+
              '<div class="picker-list" id="dashHostsList"></div>'+
            '</div>'+
          '</div></div>'+
      '</div>'+
      '<div class="eyebrow" style="margin:12px 0 6px;">Columns</div>'+
      '<div class="col-rows" id="colRows"></div>'+
      '<button type="button" class="add-col-btn" id="addColBtn">+ Add column</button>'+
      '<div class="eyebrow" style="margin:12px 0 6px;">Item mapping</div>'+
      '<div id="mapGrid"></div>'+
      '<div class="actions-row" style="margin-top:16px;">'+
        '<button class="btn btn-primary" id="saveDashBtn">Save dashboard</button>'+
        '<button type="button" class="btn btn-ghost" id="previewDashBtn">Preview</button>'+
        '<button class="btn btn-ghost" id="cancelDashBtn" type="button">Cancel</button>'+
        '<span class="status-msg" id="builderStatus"></span>'+
      '</div>'+
      '<div class="builder-preview" id="builderPreview" hidden></div>'+
    '</div>';

  renderBuilderGroupOptions();
  renderBuilderGroupTrigger();
  renderHostPickerOptions();
  renderHostPickerTrigger();
  renderColRows();
  renderMapGrid();

  function togglePicker(triggerId, panelId, searchId){
    const panel = document.getElementById(panelId);
    const trigger = document.getElementById(triggerId);
    if(!panel || !trigger) return;
    const open = !panel.classList.contains('open');
    if(typeof closeAllOpenPickers === 'function') closeAllOpenPickers(open ? panel : null);
    else {
      document.querySelectorAll('.picker-panel').forEach(function(p){ p.classList.remove('open'); p.style.display = ''; });
      document.querySelectorAll('.picker-trigger').forEach(function(t){ t.classList.remove('open'); });
    }
    if(open){
      panel.classList.add('open');
      panel.style.display = 'block';
      trigger.classList.add('open');
      const s = document.getElementById(searchId);
      if(s) s.focus();
    }
  }

  document.getElementById('dashGroupsTrigger').addEventListener('click', function(){
    togglePicker('dashGroupsTrigger', 'dashGroupsPanel', 'dashGroupsSearch');
  });
  document.getElementById('dashGroupsSearch').addEventListener('input', function(e){
    renderBuilderGroupOptions(e.target.value);
  });
  document.getElementById('dashHostsTrigger').addEventListener('click', function(){
    togglePicker('dashHostsTrigger', 'dashHostsPanel', 'dashHostsSearch');
  });
  document.getElementById('dashHostsSearch').addEventListener('input', function(e){ renderHostPickerOptions(e.target.value); });
  document.getElementById('addColBtn').addEventListener('click', function(){
    b.columns.push(newColumn());
    renderColRows();
    renderMapGrid();
  });
  document.getElementById('saveDashBtn').addEventListener('click', saveDashboard);
  document.getElementById('previewDashBtn').addEventListener('click', previewMetricsBuilder);
  document.getElementById('cancelDashBtn').addEventListener('click', showDashboardList);
  wireShareRetry('dashShare', renderBuilder);
  wireSharePicker('dashShare');
}


function renderBuilderGroupOptions(filter){
  const list = document.getElementById('dashGroupsList');
  const b = dashState.builder;
  if(!list || !b) return;
  if(!Array.isArray(b.selectedGroupIds)) b.selectedGroupIds = [];
  const f = (filter||'').trim().toLowerCase();
  const selected = new Set(b.selectedGroupIds.map(function(id){ return parseInt(id,10); }));
  const groups = dashState.allGroups || [];
  const rows = groups.filter(function(g){
    const label = String(g.name||g.groupid||'');
    return !f || label.toLowerCase().includes(f);
  });
  list.innerHTML = rows.length ? rows.map(function(g){
    const gid = parseInt(g.groupid,10);
    const on = selected.has(gid);
    const cnt = g.host_count;
    const label = escHtml(g.name||('Group '+gid))+(cnt!=null ? ' ('+cnt+')' : '');
    return '<label class="picker-option">'+
      '<input type="checkbox" data-groupid="'+gid+'"'+(on?' checked':'')+'>'+
      '<div class="opt-main"><div class="opt-name">'+label+'</div></div></label>';
  }).join('') : '<div class="picker-empty">No groups match.</div>';
  list.querySelectorAll('input[type=checkbox]').forEach(function(cb){
    cb.addEventListener('change', async function(){
      const gid = parseInt(cb.getAttribute('data-groupid'),10);
      if(cb.checked){
        if(b.selectedGroupIds.indexOf(gid) < 0) b.selectedGroupIds.push(gid);
      } else {
        b.selectedGroupIds = b.selectedGroupIds.filter(function(id){ return parseInt(id,10) !== gid; });
      }
      renderBuilderGroupOptions(document.getElementById('dashGroupsSearch')?.value||'');
      renderBuilderGroupTrigger();
      await loadBuilderHostsFromGroups();
    });
  });
}

function renderBuilderGroupTrigger(){
  const ph = document.getElementById('dashGroupsPlaceholder');
  const b = dashState.builder;
  if(!ph || !b) return;
  if(!Array.isArray(b.selectedGroupIds)) b.selectedGroupIds = [];
  const n = b.selectedGroupIds.length;
  if(!n){
    ph.textContent = 'Select host groups…';
    ph.classList.remove('picker-summary');
    return;
  }
  const selected = (dashState.allGroups||[]).filter(function(g){
    return b.selectedGroupIds.indexOf(parseInt(g.groupid,10)) >= 0;
  });
  const names = selected.map(function(g){
    const cnt = g.host_count;
    return (g.name||g.groupid)+(cnt!=null ? ' ('+cnt+')' : '');
  });
  ph.textContent = n === 1 ? names[0] : (n+' groups selected');
  ph.title = names.join(', ');
  ph.classList.add('picker-summary');
}

async function loadBuilderHostsFromGroups(){
  const b = dashState.builder;
  const status = document.getElementById('builderStatus');
  if(!b) return;
  if(!Array.isArray(b.selectedGroupIds)) b.selectedGroupIds = [];
  const gids = b.selectedGroupIds.slice();
  if(!gids.length){
    // Clearing all groups clears host selection driven by groups
    b.hostids = [];
    dashState.builderHosts = [];
    renderHostPickerOptions();
    renderHostPickerTrigger();
    renderMapGrid();
    if(status){ status.textContent = ''; status.className = 'status-msg'; }
    return;
  }
  if(status){ status.textContent = 'Loading hosts from '+gids.length+' group'+(gids.length===1?'':'s')+'…'; status.className = 'status-msg'; }
  try{
    const results = await Promise.all(gids.map(function(gid){
      return apiFetch('/api/hostgroups/'+gid+'/hosts').then(function(res){
        if(!res.ok) throw new Error('HTTP '+res.status);
        return res.json();
      });
    }));
    const seen = {};
    const hostids = [];
    const hostObjs = [];
    results.forEach(function(hosts){
      (hosts||[]).forEach(function(h){
        const id = parseInt(h.hostid,10);
        if(!seen[id]){
          seen[id] = true;
          hostids.push(id);
          hostObjs.push(h);
        }
      });
    });
    if(!dashState.allHosts) dashState.allHosts = [];
    const known = {};
    dashState.allHosts.forEach(function(h){ known[parseInt(h.hostid,10)] = true; });
    hostObjs.forEach(function(h){
      const id = parseInt(h.hostid,10);
      if(!known[id]) dashState.allHosts.push(h);
    });
    b.hostids = hostids;
    dashState.builderHosts = hostids.length ? await fetchHostsItems(hostids) : [];
    renderHostPickerOptions();
    renderHostPickerTrigger();
    renderMapGrid();
    if(status){
      status.textContent = 'Loaded '+hostids.length+' host'+(hostids.length===1?'':'s')+' from '+gids.length+' group'+(gids.length===1?'':'s')+'.';
      status.className = 'status-msg';
    }
  }catch(err){
    if(status){
      status.textContent = 'Failed: '+(err.message||err);
      status.className = 'status-msg warn';
    }
  }
}

function renderHostPickerOptions(filter){
  const list = document.getElementById('dashHostsList');
  if(!list || !dashState.builder) return;
  const f = (filter||'').trim().toLowerCase();
  const selected = new Set((dashState.builder.hostids||[]).map(function(id){ return parseInt(id,10); }));
  const filtered = (dashState.allHosts||[]).filter(function(h){
    const label = (h.name||h.host||'');
    return !f || label.toLowerCase().includes(f) || (h.groups||'').toLowerCase().includes(f);
  });
  list.innerHTML = filtered.length ? filtered.map(function(h){
    const hid = parseInt(h.hostid,10);
    return '<label class="picker-option">'+
      '<input type="checkbox" value="'+hid+'" '+(selected.has(hid)?'checked':'')+'>'+
      '<div class="opt-main"><div class="opt-name">'+(h.name||h.host)+'</div><div class="opt-meta">'+(h.groups||'')+'</div></div></label>';
  }).join('') : '<div class="picker-empty">No hosts.</div>';
  list.querySelectorAll('input[type=checkbox]').forEach(function(cb){
    cb.addEventListener('change', async function(){
      const hid = parseInt(cb.value,10);
      const b = dashState.builder;
      if(cb.checked){ if(!b.hostids.includes(hid)) b.hostids.push(hid); }
      else { b.hostids = b.hostids.filter(function(id){ return parseInt(id,10)!==hid; }); }
      renderHostPickerTrigger();
      dashState.builderHosts = b.hostids.length ? await fetchHostsItems(b.hostids) : [];
      renderMapGrid();
    });
  });
}

function renderHostPickerTrigger(){
  const trigger = document.getElementById('dashHostsTrigger');
  const placeholder = document.getElementById('dashHostsPlaceholder');
  if(!trigger || !dashState.builder) return;
  trigger.querySelectorAll('.pill').forEach(function(p){ p.remove(); });
  const ids = dashState.builder.hostids || [];
  if(!ids.length){
    placeholder.style.display = '';
    placeholder.textContent = 'Select hosts…';
    placeholder.classList.remove('picker-summary');
    placeholder.title = '';
    return;
  }
  // Compact summary — full list stays in the dropdown
  placeholder.style.display = '';
  const n = ids.length;
  if(n <= 3){
    const names = ids.map(function(hostid){
      const hid = parseInt(hostid,10);
      const h = (dashState.allHosts||[]).find(function(x){ return parseInt(x.hostid,10)===hid; });
      return h ? (h.name||h.host) : String(hid);
    });
    placeholder.textContent = names.join(', ');
  } else {
    placeholder.textContent = n + ' hosts selected';
  }
  placeholder.title = ids.map(function(hostid){
    const hid = parseInt(hostid,10);
    const h = (dashState.allHosts||[]).find(function(x){ return parseInt(x.hostid,10)===hid; });
    return h ? (h.name||h.host) : String(hid);
  }).join(', ');
  placeholder.classList.add('picker-summary');
}

function renderColRows(){
  const b = dashState.builder;
  const wrap = document.getElementById('colRows');
  if(!wrap) return;
  if(!b.columns.length){
    wrap.innerHTML =
      '<div class="col-empty-cta">'+
        '<button type="button" class="btn btn-primary" id="addColEmptyBtn">+ Add Metric Column</button>'+
        '<div class="col-empty-hint">Define metrics to map across your selected hosts.</div>'+
      '</div>';
    const emptyBtn = document.getElementById('addColEmptyBtn');
    if(emptyBtn){
      emptyBtn.addEventListener('click', function(){
        b.columns.push(newColumn());
        renderColRows();
        renderMapGrid();
      });
    }
    return;
  }
  const presets = (typeof THRESH_PRESETS !== 'undefined' && THRESH_PRESETS) ? THRESH_PRESETS : [];
  wrap.innerHTML = b.columns.map(function(col){
    if(!col.thresholds) col.thresholds = { mode: 'high_bad', yellow: 75, red: 90 };
    if(!col.display) col.display = 'number';
    const th = col.thresholds;
    const mode = th.mode || 'off';
    const disp = col.display || 'number';
    const aggHtml = ['avg','min','max','last'].map(function(a){
      return '<label><input type="checkbox" value="'+a+'" '+(col.aggregations.includes(a)?'checked':'')+'> '+a+'</label>';
    }).join('');
    const presetOpts = ['<option value="">Preset…</option>'].concat(presets.map(function(p, idx){
      return '<option value="'+idx+'">'+escHtml(p.label||('Preset '+idx))+'</option>';
    })).join('');
    return '<div class="col-row" data-col="'+col.id+'">'+
      '<div class="col-cell col-cell-label">'+
        '<span class="col-mini-label">Label</span>'+
        '<input class="col-label" value="'+String(col.label||'').replace(/"/g,'&quot;')+'" placeholder="Metric name">'+
      '</div>'+
      '<div class="col-cell col-cell-agg">'+
        '<span class="col-mini-label">Aggregations</span>'+
        '<div class="agg-group">'+aggHtml+'</div>'+
      '</div>'+
      '<div class="col-cell col-cell-mult">'+
        '<span class="col-mini-label">Multiplier</span>'+
        '<input class="col-mult" type="number" step="any" value="'+col.multiplier+'">'+
      '</div>'+
      '<div class="col-cell col-cell-unit">'+
        '<span class="col-mini-label">Unit</span>'+
        '<input class="col-unit" placeholder="%" value="'+String(col.unit||'').replace(/"/g,'&quot;')+'">'+
      '</div>'+
      '<div class="col-cell col-cell-disp">'+
        '<span class="col-mini-label">Display</span>'+
        '<select class="col-display" title="How values render in the pivot table">'+
          '<option value="number"'+(disp==='number'?' selected':'')+'>Number</option>'+
          '<option value="bar"'+(disp==='bar'?' selected':'')+'>Bar</option>'+
          '<option value="number_bar"'+(disp==='number_bar'?' selected':'')+'>Num + bar</option>'+
          '<option value="graph"'+(disp==='graph'?' selected':'')+'>Graph</option>'+
          '<option value="number_graph"'+(disp==='number_graph'?' selected':'')+'>Num + graph</option>'+
        '</select>'+
      '</div>'+
      '<div class="col-cell col-cell-thmode">'+
        '<span class="col-mini-label">Thresholds</span>'+
        '<select class="col-th-mode">'+
          '<option value="off"'+(mode==='off'?' selected':'')+'>Off</option>'+
          '<option value="high_bad"'+(mode==='high_bad'?' selected':'')+'>High = bad</option>'+
          '<option value="high_good"'+(mode==='high_good'?' selected':'')+'>High = good</option>'+
        '</select>'+
      '</div>'+
      '<div class="col-cell col-cell-thy">'+
        '<span class="col-mini-label">Yellow</span>'+
        '<input class="th-input col-th-yellow" type="number" step="any" value="'+(th.yellow!=null?th.yellow:75)+'"'+(mode==='off'?' disabled':'')+'>'+
      '</div>'+
      '<div class="col-cell col-cell-thr">'+
        '<span class="col-mini-label">Red</span>'+
        '<input class="th-input col-th-red" type="number" step="any" value="'+(th.red!=null?th.red:90)+'"'+(mode==='off'?' disabled':'')+'>'+
      '</div>'+
      '<div class="col-cell col-cell-thpreset">'+
        '<span class="col-mini-label">Preset</span>'+
        '<select class="col-th-preset">'+presetOpts+'</select>'+
      '</div>'+
      '<div class="col-cell col-cell-rm">'+
        '<span class="col-mini-label">&nbsp;</span>'+
        '<button class="col-remove-btn" type="button" title="Remove">×</button>'+
      '</div>'+
    '</div>';
  }).join('');

  wrap.querySelectorAll('.col-row').forEach(function(rowEl){
    const col = b.columns.find(function(c){ return c.id === rowEl.dataset.col; });
    rowEl.querySelector('.col-label').addEventListener('input', function(e){ col.label = e.target.value; renderMapGrid(); });
    rowEl.querySelector('.col-mult').addEventListener('input', function(e){ col.multiplier = parseFloat(e.target.value)||1; });
    rowEl.querySelector('.col-unit').addEventListener('input', function(e){ col.unit = e.target.value; });
    const dispEl = rowEl.querySelector('.col-display');
    if(dispEl){
      const syncDisp = function(){ col.display = dispEl.value || 'number'; };
      dispEl.addEventListener('change', syncDisp);
      dispEl.addEventListener('input', syncDisp);
    }
    rowEl.querySelector('.col-th-mode').addEventListener('change', function(e){
      col.thresholds.mode = e.target.value;
      if(e.target.value==='high_bad'){ col.thresholds.yellow=75; col.thresholds.red=90; }
      if(e.target.value==='high_good'){ col.thresholds.red=95; col.thresholds.yellow=99; }
      renderColRows();
    });
    rowEl.querySelector('.col-th-yellow').addEventListener('input', function(e){ col.thresholds.yellow = parseFloat(e.target.value); });
    rowEl.querySelector('.col-th-red').addEventListener('input', function(e){ col.thresholds.red = parseFloat(e.target.value); });
    const presetEl = rowEl.querySelector('.col-th-preset');
    if(presetEl){
      presetEl.addEventListener('change', function(e){
        const idx = parseInt(e.target.value, 10);
        if(isNaN(idx) || !presets[idx]) return;
        const pr = presets[idx];
        if(pr.mode) col.thresholds.mode = pr.mode;
        if(pr.yellow != null) col.thresholds.yellow = pr.yellow;
        if(pr.red != null) col.thresholds.red = pr.red;
        if(pr.unit != null) col.unit = pr.unit;
        renderColRows();
      });
    }
    rowEl.querySelectorAll('.agg-group input').forEach(function(cb){
      cb.addEventListener('change', function(){
        const checked = Array.from(rowEl.querySelectorAll('.agg-group input:checked')).map(function(c){ return c.value; });
        col.aggregations = checked.length ? checked : ['avg'];
      });
    });
    rowEl.querySelector('.col-remove-btn').addEventListener('click', function(){
      b.columns = b.columns.filter(function(c){ return c.id !== col.id; });
      renderColRows(); renderMapGrid();
    });
  });
}

/** Resolve itemid → { item, sourceHost } across all builder hosts. */
function getHostWithItems(hostid){
  const hid = String(hostid);
  const fromBuilder = (dashState.builderHosts||[]).find(function(h){ return String(h.hostid)===hid; });
  if(fromBuilder) return fromBuilder;
  return dashState.sourceHostCache[hid] || null;
}

function resolveMappedItem(itemid, rowHostid){
  if(!itemid) return null;
  // Search builder hosts + source cache
  const pools = (dashState.builderHosts||[]).concat(Object.keys(dashState.sourceHostCache||{}).map(function(k){ return dashState.sourceHostCache[k]; }));
  for(let i=0;i<pools.length;i++){
    const h = pools[i];
    if(!h) continue;
    const it = (h.items||[]).find(function(x){ return String(x.itemid)===String(itemid); });
    if(it){
      return {
        item: it,
        sourceHost: h,
        cross: rowHostid != null && String(h.hostid)!==String(rowHostid),
      };
    }
  }
  const meta = dashState.itemMetaCache[String(itemid)];
  if(meta){
    return {
      item: { itemid: meta.itemid, name: meta.name, key_: meta.key_, hostid: meta.hostid },
      sourceHost: { hostid: meta.hostid, name: meta.host_name || meta.host, host: meta.host },
      cross: rowHostid != null && String(meta.hostid)!==String(rowHostid),
    };
  }
  return null;
}

function formatMappedItemLabel(itemid, rowHostid){
  const found = resolveMappedItem(itemid, rowHostid);
  if(!found) return itemid ? ('item #'+itemid) : '';
  const it = found.item;
  const base = (it.name || it.key_ || '') + (it.key_ ? '  ['+it.key_+']' : '');
  if(found.cross){
    const src = found.sourceHost.name || found.sourceHost.host || found.sourceHost.hostid;
    return src + ' › ' + base;
  }
  return base;
}

async function ensureSourceHostItems(hostid){
  const hid = String(hostid);
  if(getHostWithItems(hid)) return getHostWithItems(hid);
  const list = await fetchHostsItems([parseInt(hid, 10)]);
  if(list && list[0]){
    dashState.sourceHostCache[hid] = list[0];
    return list[0];
  }
  return null;
}

async function hydrateMappedItemMeta(columns){
  const ids = [];
  (columns||[]).forEach(function(c){
    const hi = c.host_items || {};
    Object.keys(hi).forEach(function(k){
      const v = parseInt(hi[k], 10);
      if(!isNaN(v) && !dashState.itemMetaCache[String(v)] && !resolveMappedItem(v, null)) ids.push(v);
    });
  });
  if(!ids.length) return;
  try{
    const res = await apiFetch('/api/items/meta', {
      method: 'POST',
      body: JSON.stringify({ itemids: ids }),
    });
    if(!res.ok) return;
    const metas = await res.json();
    (metas||[]).forEach(function(m){
      dashState.itemMetaCache[String(m.itemid)] = m;
    });
  }catch(e){ console.warn('item meta', e); }
}

function renderMapGrid(){
  const wrap = document.getElementById('mapGrid');
  if(!wrap || !dashState.builder) return;
  const b = dashState.builder;
  const hosts = dashState.builderHosts || [];
  if(!b.columns.length || !hosts.length){
    wrap.innerHTML = '<div class="picker-empty">Select hosts and add columns to map items.</div>';
    return;
  }
  const allHosts = dashState.allHosts || [];
  let html = '<div class="map-toolbar" style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap;">'+
    '<button type="button" class="chip-btn" id="autoMapBtn" title="Fill unmapped cells by matching column label / existing key across hosts">Auto-map unmapped</button>'+
    mapCoverageHtml()+
    '<span class="status-msg" style="font-size:11.5px;">Choose a source host (any permitted host), then pick an item. Source need not be a dashboard row.</span>'+
  '</div>';
  html += '<div class="pivot-wrap"><table class="map-table"><thead><tr><th>Host</th>';
  b.columns.forEach(function(c){
    html += '<th>'+escHtml(c.label)+
      '<div style="margin-top:6px;"><input class="bulk-item-input" data-col="'+c.id+'" placeholder="Apply item key/name to all…" style="width:100%;font-size:11px;height:28px;"></div>'+
      '</th>';
  });
  html += '</tr></thead><tbody>';
  hosts.forEach(function(h){
    html += '<tr><td class="host-cell">'+(h.name||h.host)+'</td>';
    b.columns.forEach(function(col){
      const selectedId = col.host_items && col.host_items[String(h.hostid)];
      const found = selectedId ? resolveMappedItem(selectedId, h.hostid) : null;
      const selectedLabel = selectedId ? formatMappedItemLabel(selectedId, h.hostid) : '';
      const missing = !selectedId;
      const cross = !!(found && found.cross);
      // Default source host = item's host if known, else row host
      const defaultSrc = found ? String(found.sourceHost.hostid) : String(h.hostid);
      let srcOpts = '<option value="'+h.hostid+'">This host</option>';
      allHosts.forEach(function(ah){
        if(String(ah.hostid)===String(h.hostid)) return;
        const sel = String(ah.hostid)===defaultSrc ? ' selected' : '';
        srcOpts += '<option value="'+ah.hostid+'"'+sel+'>'+escHtml(ah.name||ah.host||ah.hostid)+'</option>';
      });
      // If mapped source is not in allHosts list, still show it
      if(found && found.cross && !allHosts.some(function(ah){ return String(ah.hostid)===String(found.sourceHost.hostid); })){
        srcOpts += '<option value="'+found.sourceHost.hostid+'" selected>'+escHtml(found.sourceHost.name||found.sourceHost.host||found.sourceHost.hostid)+'</option>';
      }
      html += '<td><div class="map-combo'+(missing?' map-missing':(cross?' map-cross map-ok':' map-ok'))+'" data-col="'+col.id+'" data-host="'+h.hostid+'">'+
        '<select class="map-src-host" title="Source host for this item" data-col="'+col.id+'" data-host="'+h.hostid+'">'+srcOpts+'</select>'+
        '<input type="text" class="map-item-input" autocomplete="off" placeholder="Search item on source host…" value="'+escHtml(selectedLabel)+'" data-itemid="'+(selectedId||'')+'">'+
        '<div class="combo-list"></div>'+
        (missing ? '<span class="map-missing-tag">unmapped</span>' : (cross ? '<span class="map-cross-tag" title="Item from another host">cross-host</span>' : ''))+
        '</div></td>';
    });
    html += '</tr>';
  });
  html += '</tbody></table></div>';
  wrap.innerHTML = html;

  function closeAllCombos(){
    wrap.querySelectorAll('.map-combo.open').forEach(function(c){ c.classList.remove('open'); });
  }

  async function fillComboList(combo, filter){
    const list = combo.querySelector('.combo-list');
    const rowHostid = combo.dataset.host;
    const srcSel = combo.querySelector('.map-src-host');
    const srcHostid = srcSel ? srcSel.value : rowHostid;
    const f = (filter || '').trim().toLowerCase();
    const selectedId = combo.querySelector('.map-item-input').dataset.itemid;

    list.innerHTML = '<div class="combo-opt" style="opacity:.6;pointer-events:none;">Loading items…</div>';
    let hostObj = null;
    try{
      hostObj = await ensureSourceHostItems(srcHostid);
    }catch(err){
      list.innerHTML = '<div class="combo-opt" style="opacity:.6;pointer-events:none;">Failed to load items</div>';
      return;
    }
    const items = (hostObj && hostObj.items) || [];
    let filtered = items;
    if(f){
      filtered = items.filter(function(it){
        const n = (it.name||'').toLowerCase();
        const k = (it.key_||'').toLowerCase();
        return n.includes(f) || k.includes(f);
      });
    }
    const CAP = 100;
    const slice = filtered.slice(0, CAP);
    const isCross = String(srcHostid)!==String(rowHostid);
    const srcLabel = hostObj ? (hostObj.name||hostObj.host||srcHostid) : srcHostid;
    let opts = '<div class="combo-host-hdr'+(isCross?'':' is-row')+'">'+
      (isCross ? 'From · ' : 'This host · ')+escHtml(String(srcLabel))+'</div>';
    opts += '<div class="combo-opt" data-itemid="">— none —</div>';
    opts += slice.map(function(it){
      const active = String(it.itemid)===String(selectedId) ? ' active' : '';
      return '<div class="combo-opt'+active+(isCross?' cross-host':'')+'" data-itemid="'+it.itemid+'" data-source-host="'+srcHostid+'">'+
        escHtml(it.name||it.key_||('#'+it.itemid))+
        (it.key_ ? '<div class="ck">'+escHtml(it.key_)+'</div>' : '')+
        '</div>';
    }).join('');
    if(filtered.length > CAP){
      opts += '<div class="combo-opt" style="opacity:.6;pointer-events:none;">… '+(filtered.length-CAP)+' more — refine search</div>';
    }
    if(!filtered.length){
      opts += '<div class="combo-opt" style="opacity:.6;pointer-events:none;">No items match</div>';
    }
    list.innerHTML = opts;
    list.querySelectorAll('.combo-opt[data-itemid]').forEach(function(opt){
      opt.addEventListener('mousedown', function(e){
        e.preventDefault();
        const col = b.columns.find(function(c){ return c.id === combo.dataset.col; });
        if(!col.host_items) col.host_items = {};
        const iid = opt.dataset.itemid;
        const input = combo.querySelector('.map-item-input');
        if(iid){
          col.host_items[String(combo.dataset.host)] = parseInt(iid, 10);
          input.dataset.itemid = iid;
          // Cache meta for label
          const it = items.find(function(x){ return String(x.itemid)===String(iid); });
          if(it && hostObj){
            dashState.itemMetaCache[String(iid)] = {
              itemid: parseInt(iid,10),
              hostid: parseInt(srcHostid,10),
              host_name: hostObj.name||hostObj.host||'',
              host: hostObj.host||'',
              name: it.name||'',
              key_: it.key_||'',
            };
          }
          // Replace placeholder "New metric" with a real telemetry name
          if(it) maybeApplyMetricLabelFromItem(col, it);
          input.value = formatMappedItemLabel(iid, combo.dataset.host);
          const crossNow = String(srcHostid)!==String(combo.dataset.host);
          combo.classList.remove('map-missing');
          combo.classList.add('map-ok');
          combo.classList.toggle('map-cross', crossNow);
          const tag = combo.querySelector('.map-missing-tag, .map-cross-tag');
          if(tag) tag.remove();
          if(crossNow){
            const t = document.createElement('span');
            t.className = 'map-cross-tag';
            t.title = 'Item from another host';
            t.textContent = 'cross-host';
            combo.appendChild(t);
          }
        } else {
          delete col.host_items[String(combo.dataset.host)];
          input.dataset.itemid = '';
          input.value = '';
          combo.classList.add('map-missing');
          combo.classList.remove('map-ok', 'map-cross');
          const oldTag = combo.querySelector('.map-missing-tag, .map-cross-tag');
          if(oldTag) oldTag.remove();
          const t = document.createElement('span');
          t.className = 'map-missing-tag';
          t.textContent = 'unmapped';
          combo.appendChild(t);
        }
        closeAllCombos();
        const chip = document.getElementById('mapCoverageChip');
        if(chip){
          const tmp = document.createElement('div');
          tmp.innerHTML = mapCoverageHtml();
          if(tmp.firstChild) chip.replaceWith(tmp.firstChild);
        }
      });
    });
  }

  wrap.querySelectorAll('.map-combo').forEach(function(combo){
    const input = combo.querySelector('.map-item-input');
    const srcSel = combo.querySelector('.map-src-host');
    input.addEventListener('focus', function(){
      closeAllCombos();
      combo.classList.add('open');
      fillComboList(combo, '');
    });
    input.addEventListener('input', function(){
      combo.classList.add('open');
      fillComboList(combo, input.value);
    });
    input.addEventListener('keydown', function(e){
      if(e.key === 'Escape'){ closeAllCombos(); input.blur(); }
      if(e.key === 'Enter'){
        e.preventDefault();
        const first = combo.querySelector('.combo-opt[data-itemid]:not([data-itemid=""])');
        if(first) first.dispatchEvent(new Event('mousedown'));
      }
    });
    if(srcSel){
      srcSel.addEventListener('change', function(){
        // Clear current selection when switching source so user picks a new item
        input.value = '';
        input.dataset.itemid = '';
        const col = b.columns.find(function(c){ return c.id === combo.dataset.col; });
        if(col && col.host_items) delete col.host_items[String(combo.dataset.host)];
        combo.classList.add('map-missing');
        combo.classList.remove('map-ok', 'map-cross');
        const tag = combo.querySelector('.map-missing-tag, .map-cross-tag');
        if(tag) tag.remove();
        if(!combo.querySelector('.map-missing-tag')){
          const t = document.createElement('span');
          t.className = 'map-missing-tag';
          t.textContent = 'unmapped';
          combo.appendChild(t);
        }
        combo.classList.add('open');
        fillComboList(combo, '');
        input.focus();
      });
      srcSel.addEventListener('mousedown', function(e){ e.stopPropagation(); });
      srcSel.addEventListener('click', function(e){ e.stopPropagation(); });
    }
  });
  document.addEventListener('click', function onDoc(e){
    if(!wrap.contains(e.target)) closeAllCombos();
  });

  wrap.querySelectorAll('.bulk-item-input').forEach(function(inp){
    inp.addEventListener('keydown', function(e){
      if(e.key==='Enter'){
        e.preventDefault();
        applyItemToColumn(inp.dataset.col, inp.value);
      }
    });
  });
  const autoBtn = document.getElementById('autoMapBtn');
  if(autoBtn) autoBtn.addEventListener('click', autoMapAllColumns);
}

function applyItemToColumn(colId, query){
  const col = dashState.builder.columns.find(function(c){ return c.id === colId; });
  if(!col) return;
  let mapped = 0;
  let firstMatch = null;
  (dashState.builderHosts||[]).forEach(function(h){
    const match = matchItemOnHost(h, query);
    if(match){
      if(!col.host_items) col.host_items = {};
      col.host_items[String(h.hostid)] = parseInt(match.itemid,10);
      if(!firstMatch) firstMatch = match;
      mapped++;
    } else if(col.host_items){
      delete col.host_items[String(h.hostid)];
    }
  });
  if(firstMatch) maybeApplyMetricLabelFromItem(col, firstMatch);
  renderColRows();
  renderMapGrid();
  const status = document.getElementById('builderStatus');
  if(status) status.textContent = 'Mapped "'+query+'" on '+mapped+' host(s).';
}


function syncBuilderColumnsFromDom(){
  const b = dashState.builder;
  if(!b) return;
  document.querySelectorAll('#colRows .col-row').forEach(function(rowEl){
    const col = b.columns.find(function(c){ return c.id === rowEl.dataset.col; });
    if(!col) return;
    const labelEl = rowEl.querySelector('.col-label');
    const multEl = rowEl.querySelector('.col-mult');
    const unitEl = rowEl.querySelector('.col-unit');
    const dispEl = rowEl.querySelector('.col-display');
    const modeEl = rowEl.querySelector('.col-th-mode');
    const yEl = rowEl.querySelector('.col-th-yellow');
    const rEl = rowEl.querySelector('.col-th-red');
    if(labelEl) col.label = labelEl.value;
    if(multEl) col.multiplier = parseFloat(multEl.value) || 1;
    if(unitEl) col.unit = unitEl.value;
    if(dispEl && dispEl.value) col.display = dispEl.value;
    if(!col.thresholds) col.thresholds = { mode: 'off', yellow: 75, red: 90 };
    if(modeEl) col.thresholds.mode = modeEl.value;
    if(yEl && yEl.value !== '') col.thresholds.yellow = parseFloat(yEl.value);
    if(rEl && rEl.value !== '') col.thresholds.red = parseFloat(rEl.value);
    const aggs = Array.from(rowEl.querySelectorAll('.agg-group input:checked')).map(function(cb){ return cb.value; });
    if(aggs.length) col.aggregations = aggs;
  });
}

function builderColumnsPayload(){
  const b = dashState.builder;
  syncBuilderColumnsFromDom();
  return (b.columns || []).map(function(c){
    const hi = {};
    const raw = c.host_items || {};
    Object.keys(raw).forEach(function(k){
      const v = parseInt(raw[k], 10);
      if(!isNaN(v)) hi[String(k)] = v;
    });
    const disp = (['bar','number_bar','graph','number_graph'].indexOf(c.display) >= 0) ? c.display : 'number';
    return {
      id: c.id,
      label: c.label,
      aggregations: c.aggregations && c.aggregations.length ? c.aggregations : ['avg'],
      multiplier: c.multiplier != null ? c.multiplier : 1,
      unit: c.unit || '',
      decimals: c.decimals != null ? c.decimals : 1,
      color_mode: c.color_mode || 'none',
      display: disp,
      thresholds: c.thresholds || { mode: 'off', yellow: 75, red: 90 },
      host_items: hi,
    };
  });
}

async function previewMetricsBuilder(){
  const b = dashState.builder;
  const statusEl = document.getElementById('builderStatus');
  const previewEl = document.getElementById('builderPreview');
  if(!b || !previewEl) return;
  if(!b.hostids || !b.hostids.length){
    if(statusEl){ statusEl.textContent = 'Select hosts before preview.'; statusEl.className = 'status-msg warn'; }
    return;
  }
  if(!b.columns || !b.columns.length){
    if(statusEl){ statusEl.textContent = 'Add a metric column before preview.'; statusEl.className = 'status-msg warn'; }
    return;
  }
  const columns = builderColumnsPayload();
  const mapped = columns.some(function(c){ return c.host_items && Object.keys(c.host_items).length; });
  if(!mapped){
    if(statusEl){ statusEl.textContent = 'Map items on hosts before preview.'; statusEl.className = 'status-msg warn'; }
    return;
  }
  if(statusEl){ statusEl.textContent = 'Running preview…'; statusEl.className = 'status-msg'; }
  previewEl.hidden = false;
  previewEl.innerHTML = loadingStateHtml('Preview — last 24 hours…');

  const dateTo = Math.floor(Date.now() / 1000);
  const dateFrom = dateTo - 24 * 3600;
  const dayPayload = { tz_offset_min: (typeof apiTzOffsetMin === 'function' ? apiTzOffsetMin() : 0) };
  const dashboard = { name: (b.name || 'Preview') + ' (preview)', hostids: b.hostids, columns: columns };

  try{
    const res = await apiFetch('/api/dashboards/run-adhoc', {
      method: 'POST',
      timeoutMs: 60000,
      body: JSON.stringify(Object.assign({
        name: 'preview',
        hostids: b.hostids,
        columns: columns,
        date_from: dateFrom,
        date_to: dateTo,
      }, dayPayload)),
    });
    if(!res.ok){
      const err = await res.json().catch(function(){ return {}; });
      throw new Error(typeof formatApiDetail === 'function' ? formatApiDetail(err.detail, 'Preview failed') : (err.detail || 'Preview failed'));
    }
    const result = await res.json();
    if(!(result.rows || []).length){
      previewEl.innerHTML = emptyResultHtml({
        title: 'No data in the last 24 hours',
        body: 'Try mapping different items or check that hosts have recent values.',
      });
      if(statusEl){ statusEl.textContent = ''; statusEl.className = 'status-msg'; }
      return;
    }
    previewEl.innerHTML =
      '<div class="builder-preview-head">'+
        '<span class="eyebrow" style="margin:0;">Preview · last 24h</span>'+
        '<button type="button" class="chip-btn" id="builderPreviewClose">Close</button>'+
      '</div>'+
      '<div class="metrics-results-toolbar">'+
        computeInsightStrip(dashboard, result) +
      '</div>'+
      renderPivot(dashboard, result, null);
    const closeBtn = document.getElementById('builderPreviewClose');
    if(closeBtn) closeBtn.addEventListener('click', function(){ previewEl.hidden = true; previewEl.innerHTML = ''; });
    const tbl = previewEl.querySelector('table');
    if(typeof makeTableSortable === 'function') makeTableSortable(tbl);
    if(typeof wirePivotStickyHeaders === 'function') wirePivotStickyHeaders(previewEl);
    if(typeof wireInsightHealthFilter === 'function') wireInsightHealthFilter(previewEl);
    if(statusEl){ statusEl.textContent = 'Preview ready.'; statusEl.className = 'status-msg'; }
    previewEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }catch(err){
    previewEl.innerHTML = errorStateHtml({
      title: 'Preview failed',
      body: err.message || String(err),
    });
    if(statusEl){ statusEl.textContent = err.message || String(err); statusEl.className = 'status-msg warn'; }
  }
}

async function saveDashboard(){
  const b = dashState.builder;
  b.name = document.getElementById('dashName').value.trim();
  // is_shared remains as stored on the builder object (UI checkbox removed)
  b.is_shared = !!b.is_shared;
  const statusEl = document.getElementById('builderStatus');
  if(!b.name){ statusEl.textContent='Name required.'; statusEl.className='status-msg warn'; return; }
  if(!b.hostids.length){ statusEl.textContent='Select hosts.'; statusEl.className='status-msg warn'; return; }
  if(!b.columns.length){ statusEl.textContent='Add a column.'; statusEl.className='status-msg warn'; return; }

  // Sync column fields from the live DOM so a changed Display/thresholds
  // is never lost if a change-handler didn't fire.
  document.querySelectorAll('#colRows .col-row').forEach(function(rowEl){
    const col = b.columns.find(function(c){ return c.id === rowEl.dataset.col; });
    if(!col) return;
    const labelEl = rowEl.querySelector('.col-label');
    const multEl = rowEl.querySelector('.col-mult');
    const unitEl = rowEl.querySelector('.col-unit');
    const dispEl = rowEl.querySelector('.col-display');
    const modeEl = rowEl.querySelector('.col-th-mode');
    const yEl = rowEl.querySelector('.col-th-yellow');
    const rEl = rowEl.querySelector('.col-th-red');
    if(labelEl) col.label = labelEl.value;
    if(multEl) col.multiplier = parseFloat(multEl.value) || 1;
    if(unitEl) col.unit = unitEl.value;
    if(dispEl && dispEl.value) col.display = dispEl.value;
    if(!col.thresholds) col.thresholds = { mode: 'off', yellow: 75, red: 90 };
    if(modeEl) col.thresholds.mode = modeEl.value;
    if(yEl && yEl.value !== '') col.thresholds.yellow = parseFloat(yEl.value);
    if(rEl && rEl.value !== '') col.thresholds.red = parseFloat(rEl.value);
    const aggs = Array.from(rowEl.querySelectorAll('.agg-group input:checked')).map(function(cb){ return cb.value; });
    if(aggs.length) col.aggregations = aggs;
  });

  const columns = b.columns.map(function(c){
    // Normalize host_items keys to strings and values to ints
    const hi = {};
    const raw = c.host_items || {};
    Object.keys(raw).forEach(function(k){
      const v = parseInt(raw[k], 10);
      if(!isNaN(v)) hi[String(k)] = v;
    });
    const disp = (['bar','number_bar','graph','number_graph'].indexOf(c.display) >= 0) ? c.display : 'number';
    return {
      id: c.id,
      label: c.label,
      aggregations: c.aggregations && c.aggregations.length ? c.aggregations : ['avg'],
      multiplier: c.multiplier != null ? c.multiplier : 1,
      unit: c.unit || '',
      decimals: c.decimals != null ? c.decimals : 1,
      color_mode: c.color_mode || 'none',
      display: disp,
      thresholds: c.thresholds || { mode: 'off', yellow: 75, red: 90 },
      host_items: hi,
    };
  });
  const share = readSharePicker('dashShare');
  b.shared_userids = share.shared_userids;
  b.shared_usrgrpids = share.shared_usrgrpids;
  const payload = {
    name: b.name, hostids: b.hostids, columns: columns, is_shared: b.is_shared,
    shared_userids: b.shared_userids, shared_usrgrpids: b.shared_usrgrpids,
  };
  const url = b.id ? '/api/dashboards/'+b.id : '/api/dashboards';
  const method = b.id ? 'PUT' : 'POST';
  try{
    const res = await apiFetch(url, { method: method, body: JSON.stringify(payload) });
    if(!res.ok){
      const err = await res.json().catch(function(){ return {}; });
      throw new Error(formatApiDetail(err.detail, 'Save failed'));
    }
    showDashboardList();
  }catch(err){
    statusEl.textContent = err.message||String(err);
    statusEl.className='status-msg warn';
  }
}

async function openRun(dashId){
  dashState.view = 'run';
  dashRoot().innerHTML = loadingStateHtml('Opening dashboard…');
  let dashboard;
  try{
    const res = await apiFetch('/api/dashboards/'+dashId);
    if(!res.ok) throw new Error('HTTP '+res.status);
    dashboard = await res.json();
  }catch(err){
    dashRoot().innerHTML = errorStateHtml({
      title: 'Could not open dashboard',
      body: String(err.message||err),
      retryId: 'backFailBtn',
    }).replace('>Try again</button>', '>Back to list</button>');
    const back = document.getElementById('backFailBtn');
    if(back) back.addEventListener('click', showDashboardList);
    return;
  }
  (dashboard.columns||[]).forEach(function(c){
    if(!c.aggregations||!c.aggregations.length) c.aggregations = ['avg','max'];
    if(!c.host_items) c.host_items = {};
    if(!c.thresholds) c.thresholds = { mode: 'off', yellow: 75, red: 90 };
    if(c.decimals == null) c.decimals = 1;
    if(!c.display) c.display = 'number';
  });
  dashState.current = dashboard;
  const nowSec = Math.floor(Date.now()/1000);
  const fromVal = fromEpochToLocalInput(nowSec - 24*3600);
  const toVal = fromEpochToLocalInput(nowSec);
  dashRoot().innerHTML =
    '<div class="filterbar dash-run-bar dash-run-bar-compact dash-run-bar-ref">'+
      '<div class="dash-run-row dash-run-row-compact">'+
        '<div class="dash-run-title"><div class="eyebrow" style="margin-bottom:2px;">Dashboard</div>'+
          '<h3 style="margin:0;font-size:15px;line-height:1.25;">'+escHtml(dashboard.name)+shareBadgeHtml(dashboard)+'</h3></div>'+
        '<div class="field dash-run-date"><label for="dashFrom">From</label>'+
          '<input type="datetime-local" id="dashFrom" value="'+fromVal+'"></div>'+
        '<div class="field dash-run-date"><label for="dashTo">To</label>'+
          '<input type="datetime-local" id="dashTo" value="'+toVal+'"></div>'+
        datePresetBar('dashFrom','dashTo')+
        dayHoursPresetBar('dashDayFrom','dashDayTo','dashDay')+
        '<div class="dash-run-actions">'+
          '<label class="dash-run-compare"><input type="checkbox" id="dashComparePrev"> Compare previous</label>'+
          '<button class="btn btn-primary" id="runDashBtn"><span class="spinner"></span><span class="btn-label">Show metrics</span></button>'+
          '<button class="btn btn-ghost" id="backToListBtn" type="button">← All dashboards</button>'+
          '<span class="status-msg" id="dashRunStatus"></span>'+
        '</div>'+
      '</div>'+
    '</div>'+
    '<div id="pivotWrap" style="margin-top:12px;"></div>';
  wireDatePresets(dashRoot(), 'dashFrom', 'dashTo');
  wireDayHoursPresets(dashRoot(), 'dashDay');
  document.getElementById('backToListBtn').addEventListener('click', showDashboardList);
  document.getElementById('runDashBtn').addEventListener('click', function(){ runDashboard(dashboard); });
  runDashboard(dashboard);
}

async function runDashboard(dashboard){
  const fromVal = document.getElementById('dashFrom').value;
  const toVal = document.getElementById('dashTo').value;
  if(!fromVal||!toVal) return;
  const runBtn = document.getElementById('runDashBtn');
  if(runBtn){ runBtn.classList.add('loading'); runBtn.disabled = true; }
  const statusEl = document.getElementById('dashRunStatus');
  if(statusEl) statusEl.textContent = '';
  const pivotWrap = document.getElementById('pivotWrap');
  if(pivotWrap) pivotWrap.innerHTML = loadingStateHtml('Computing metrics…');
  const dateFrom = toEpoch(fromVal), dateTo = toEpoch(toVal);
  const hours = readDayHoursPreset('dashDay', 'dashDayFrom', 'dashDayTo');
  const dayPayload = {
    day_time_from: hours.day_time_from,
    day_time_to: hours.day_time_to,
    tz_offset_min: apiTzOffsetMin(),
  };
  const comparePrev = !!(document.getElementById('dashComparePrev')||{}).checked;
  try{
    const res = await apiFetch('/api/dashboards/'+dashboard.id+'/run', {
      method: 'POST',
      body: JSON.stringify(Object.assign({ date_from: dateFrom, date_to: dateTo }, dayPayload)),
    });
    if(!res.ok){
      const err = await res.json().catch(function(){ return {}; });
      throw new Error((typeof formatApiDetail === 'function' ? formatApiDetail(err.detail, 'HTTP '+res.status) : (err.detail && (err.detail.message || JSON.stringify(err.detail))) || ('HTTP '+res.status)));
    }
    const result = await res.json();

    let prevResult = null;
    if(comparePrev){
      const span = dateTo - dateFrom;
      try{
        const prevRes = await apiFetch('/api/dashboards/'+dashboard.id+'/run', {
          method: 'POST',
          body: JSON.stringify(Object.assign({ date_from: dateFrom - span, date_to: dateFrom }, dayPayload)),
        });
        if(prevRes.ok) prevResult = await prevRes.json();
      }catch(e){ console.warn('previous-period fetch failed', e); }
    }

    if(pivotWrap){
      if(!(result.rows||[]).length){
        pivotWrap.innerHTML = emptyResultHtml({
          title: 'No hosts matched',
          body: 'No host metrics were returned. Try a wider date range, different hours filter, or check item mappings.',
          retryId: 'dashEmptyRetryBtn',
          retryLabel: 'Run again',
        });
        const emptyRetry = document.getElementById('dashEmptyRetryBtn');
        if(emptyRetry) emptyRetry.addEventListener('click', function(){ runDashboard(dashboard); });
        return;
      }
      let audit = '';
      try{
        (dashboard.columns||[]).forEach(function(col){
          const missing = (dashboard.hostids||[]).filter(function(hid){
            return !(col.host_items && col.host_items[String(hid)]);
          });
          if(missing.length){
            audit += '<div><b>'+escHtml(col.label)+'</b>: not mapped on '+missing.length+' host(s)</div>';
          }
        });
      }catch(e){}
      pivotWrap.innerHTML =
        '<div class="metrics-results-toolbar">'+
          computeInsightStrip(dashboard, result) +
          '<div class="table-tools metrics-tools">'+
            '<input type="search" id="dashTableSearch" placeholder="Filter rows…">'+
            '<label class="table-tools-refresh"><span>Auto</span> '+
              '<select id="dashRefreshSel"><option value="0">Off</option><option value="30">30s</option><option value="60">1m</option><option value="300">5m</option></select></label>'+
            '<span class="table-tools-group">'+
              '<button type="button" class="btn-export" id="dashExportBtn">Export CSV</button>'+
              '<button type="button" class="btn-export" id="dashExportPdfBtn">Export PDF</button>'+
            '</span>'+
            '<button type="button" class="chip-btn" id="dashShareBtn">Copy link</button>'+
          '</div>'+
        '</div>'+
        renderPivot(dashboard, result, prevResult) +
        (audit ? '<div class="audit-box">'+audit+'</div>' : '') +
        (comparePrev && !prevResult ? '<div class="audit-box" style="border-color:var(--danger);">Could not load the previous period for comparison.</div>' : '');
      const tbl = pivotWrap.querySelector('table');
      makeTableSortable(tbl);
      wireTableSearch(document.getElementById('dashTableSearch'), tbl);
      wirePivotStickyHeaders(pivotWrap);
      wirePivotDrilldown(pivotWrap, dateFrom, dateTo, hours);
      wireInsightHealthFilter(pivotWrap);
      wireHostDetailLinks(pivotWrap, dateFrom, dateTo, hours);
      const exportMeta = {
        title: dashboard.name || 'Dashboard',
        dateFrom: dateFrom,
        dateTo: dateTo,
        day_time_from: hours.day_time_from,
        day_time_to: hours.day_time_to,
        comparePrev: comparePrev,
      };
      const dashBase = (typeof sanitizeExportFilename === 'function'
        ? sanitizeExportFilename(exportMeta.title, 'dashboard')
        : 'dashboard');
      document.getElementById('dashExportBtn').addEventListener('click', function(){ exportVisibleTable(pivotWrap, dashBase + '.csv', exportMeta); });
      document.getElementById('dashExportPdfBtn').addEventListener('click', function(){
        exportVisibleTablePdf(pivotWrap, dashBase + '.pdf', exportMeta);
      });
      document.getElementById('dashShareBtn').addEventListener('click', function(){
        setShareLink({ tab: 'metrics', dash: dashboard.id, pdash: '' });
        navigator.clipboard.writeText(location.href).then(function(){ showToast('Link copied to clipboard.', { type: 'success' }); });
      });
      wireAutoRefresh('dash-'+dashboard.id, document.getElementById('dashRefreshSel'), function(){ runDashboard(dashboard); });
    }
  }catch(err){
    if(statusEl){ statusEl.textContent = ''; statusEl.className='status-msg'; }
    if(pivotWrap){
      pivotWrap.innerHTML = errorStateHtml({
        title: 'Could not run dashboard',
        body: err.message || String(err),
        retryId: 'dashRetryBtn',
      });
      const retry = document.getElementById('dashRetryBtn');
      if(retry) retry.addEventListener('click', function(){ runDashboard(dashboard); });
    }
  }finally{
    if(runBtn){ runBtn.classList.remove('loading'); runBtn.disabled = false; }
  }
}

function metricBarHtml(value, col){
  if(typeof value !== 'number' || isNaN(value)) return '';
  const th = col.thresholds || {};
  const mode = th.mode || 'off';
  // Normalize 0..100-ish scale for the bar width
  let maxRef = 100;
  if(mode === 'high_bad' || mode === 'high_good'){
    const red = Number(th.red);
    const yellow = Number(th.yellow);
    if(!isNaN(red) && !isNaN(yellow)){
      maxRef = Math.max(Math.abs(red), Math.abs(yellow), Math.abs(value)) * 1.1;
    }
  } else {
    maxRef = Math.max(100, Math.abs(value) * 1.2);
  }
  if(maxRef <= 0) maxRef = 1;
  const pct = Math.max(0, Math.min(100, (Math.abs(value) / maxRef) * 100));
  const cls = metricClass(value, col) || 'metric-good';
  return '<div class="metric-bar" title="'+value+'"><div class="metric-bar-fill '+cls+'" style="width:'+pct.toFixed(1)+'%"></div></div>';
}


/** Classify a pivot row for insight filters: critical | warning | healthy | offline (shown as "no data") */
function pivotRowHealth(row, columns){
  let hasBad = false, hasWarn = false, hasGood = false, hasData = false;
  (columns || []).forEach(function(col){
    const cell = row.cells && row.cells[col.id];
    const primaryAgg = (col.aggregations || [])[0];
    if(!cell || primaryAgg == null) return;
    const v = cell.values ? cell.values[primaryAgg] : null;
    if(typeof v !== 'number') return;
    hasData = true;
    const cls = metricClass(v, col);
    if(cls === 'metric-bad') hasBad = true;
    else if(cls === 'metric-warn') hasWarn = true;
    else if(cls === 'metric-good') hasGood = true;
  });
  if(!hasData) return 'offline';
  if(hasBad) return 'critical';
  if(hasWarn) return 'warning';
  return 'healthy';
}


/** Quick view: multiplier + unit inputs under each metric group header. */
function wireQuickColControls(container){
  if(!container) return;
  const last = dashState.quickLast;
  if(!last || !last.columns) return;
  container.querySelectorAll('.qv-col-controls').forEach(function(wrap){
    const colId = wrap.getAttribute('data-col-id');
    const col = last.columns.find(function(c){ return c.id === colId; });
    if(!col) return;
    const multEl = wrap.querySelector('.qv-col-mult');
    const unitEl = wrap.querySelector('.qv-col-unit');
    const modeTog = wrap.querySelector('.qv-col-mode-tog');
    const threshEl = wrap.querySelector('.qv-col-thresh');
    function currentMode(){
      const active = modeTog && modeTog.querySelector('.qv-mode-btn.active');
      return (active && active.getAttribute('data-mode')) || 'high_bad';
    }
    function apply(){
      if(multEl){
        const m = parseFloat(multEl.value);
        col.multiplier = (isFinite(m) && m !== 0) ? m : 1;
      }
      if(unitEl) col.unit = unitEl.value || '';
      if(!col.thresholds) col.thresholds = { mode: 'off', yellow: 75, red: 90 };
      const mode = currentMode();
      if(threshEl){
        const t = parseFloat(threshEl.value);
        if(threshEl.value === '' || !isFinite(t)){
          col.thresholds.mode = 'off';
          col.thresholds._prefMode = mode;
        } else {
          // Single critical threshold T; warn band is ±10%.
          // high_bad: yellow = T*0.9, red = T
          // high_good: red = T, yellow = T*1.1
          col.thresholds.mode = mode;
          col.thresholds._prefMode = mode;
          col.thresholds.red = t;
          col.thresholds.yellow = (mode === 'high_good') ? (t * 1.1) : (t * 0.9);
        }
      }
      // Re-render pivot body + headers from cached result
      const pivotParent = container.querySelector('.pivot-wrap');
      if(!pivotParent) return;
      const html = renderPivot({ name: 'Quick view', columns: last.columns }, last.data, last.prevResult);
      // Replace only the pivot-wrap (and legend that follows)
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      const next = pivotParent.nextElementSibling;
      if(next && next.classList && next.classList.contains('metrics-legend')) next.remove();
      pivotParent.replaceWith(tmp.firstElementChild);
      // legend if present
      if(tmp.children.length > 1){
        const newPivot = container.querySelector('.pivot-wrap');
        if(newPivot && tmp.children[1]) newPivot.after(tmp.children[1]);
      }
      // re-wire controls + table features
      wireQuickColControls(container);
      const tbl = container.querySelector('table.pivot');
      if(typeof makeTableSortable === 'function') makeTableSortable(tbl);
      if(typeof wireTableSearch === 'function'){
        const search = container.querySelector('#dqTableSearch') || container.querySelector('input[type=search]');
        if(search) wireTableSearch(search, tbl);
      }
      if(typeof wirePivotStickyHeaders === 'function') wirePivotStickyHeaders(container);
      if(last.dateFrom != null && typeof wirePivotDrilldown === 'function'){
        wirePivotDrilldown(container, last.dateFrom, last.dateTo, last.hours);
      }
      if(typeof wireHostDetailLinks === 'function'){
        dashState.current = { name: 'Quick view', columns: last.columns };
        wireHostDetailLinks(container, last.dateFrom, last.dateTo, last.hours);
      }
      // Refresh health insight strip (critical / healthy / no data) after threshold change
      const strip = container.querySelector('.insight-strip-filter');
      if(strip && typeof computeInsightStrip === 'function'){
        const fresh = computeInsightStrip({ columns: last.columns }, last.data);
        if(fresh){
          const tmpS = document.createElement('div');
          tmpS.innerHTML = fresh;
          strip.replaceWith(tmpS.firstElementChild);
        } else {
          strip.remove();
        }
        if(typeof wireInsightHealthFilter === 'function') wireInsightHealthFilter(container);
      }
    }
    if(multEl){
      multEl.addEventListener('change', apply);
      multEl.addEventListener('blur', apply);
      multEl.addEventListener('keydown', function(e){ if(e.key === 'Enter'){ e.preventDefault(); apply(); multEl.blur(); } });
    }
    if(unitEl){
      unitEl.addEventListener('change', apply);
      unitEl.addEventListener('blur', apply);
      unitEl.addEventListener('keydown', function(e){ if(e.key === 'Enter'){ e.preventDefault(); apply(); unitEl.blur(); } });
    }
    if(modeTog){
      modeTog.querySelectorAll('.qv-mode-btn').forEach(function(btn){
        btn.addEventListener('click', function(e){
          e.preventDefault();
          e.stopPropagation();
          modeTog.querySelectorAll('.qv-mode-btn').forEach(function(b){ b.classList.remove('active'); });
          btn.classList.add('active');
          // Remember preferred mode even when thresh is empty
          if(!col.thresholds) col.thresholds = { mode: 'off', yellow: 75, red: 90 };
          if(col.thresholds.mode === 'off'){
            col.thresholds._prefMode = btn.getAttribute('data-mode');
          }
          apply();
        });
      });
    }
    if(threshEl){
      threshEl.addEventListener('change', apply);
      threshEl.addEventListener('blur', apply);
      threshEl.addEventListener('keydown', function(e){ if(e.key === 'Enter'){ e.preventDefault(); apply(); threshEl.blur(); } });
    }
    // stop sort click when interacting with inputs
    wrap.addEventListener('click', function(e){ e.stopPropagation(); });
    wrap.addEventListener('mousedown', function(e){ e.stopPropagation(); });
  });
}

function renderPivot(dashboard, result, prevResult){
  const columns = dashboard.columns || [];
  const prevByHost = {};
  if(prevResult && prevResult.rows){
    prevResult.rows.forEach(function(r){ prevByHost[String(r.hostid)] = r.cells; });
  } else {
    try{ window._zrCompareHostStatus = {}; }catch(e){}
  }
  // data-sort-col maps header cells to tbody column index (Host=0, then each aggregation leaf)
  let sortCol = 1;
  const isQuick = (dashboard && dashboard.name === 'Quick view');
  const headerRow1 = ['<th rowspan="2" data-sort-col="0" class="sortable host-head">Host</th>'].concat(
    columns.map(function(c){
      const controls = isQuick
        ? (function(){
            const th = c.thresholds || {};
            const mode = (th.mode && th.mode !== 'off')
              ? th.mode
              : (th._prefMode || 'high_bad');
            const threshVal = (th.mode && th.mode !== 'off' && th.red != null) ? th.red : '';
            return '<div class="qv-col-controls" data-col-id="'+escHtml(c.id)+'">'+
             '<label class="qv-col-ctrl" title="Multiply all values in this column">'+
               '<span class="qv-col-ctrl-lbl">Mult</span>'+
               '<input type="number" class="qv-col-mult" step="any" min="0" value="'+(c.multiplier != null ? c.multiplier : 1)+'">'+
             '</label>'+
             '<label class="qv-col-ctrl" title="Unit shown after each value">'+
               '<span class="qv-col-ctrl-lbl">Unit</span>'+
               '<input type="text" class="qv-col-unit" placeholder="%, ms" value="'+escHtml(c.unit || '')+'">'+
             '</label>'+
             '<div class="qv-col-ctrl" title="high_bad: higher is worse · high_good: higher is better">'+
               '<span class="qv-col-ctrl-lbl">Mode</span>'+
               '<div class="qv-col-mode-tog" role="group" aria-label="Threshold mode">'+
                 '<button type="button" class="qv-mode-btn'+(mode==='high_bad'?' active':'')+'" data-mode="high_bad" title="Higher is worse">bad↑</button>'+
                 '<button type="button" class="qv-mode-btn'+(mode==='high_good'?' active':'')+'" data-mode="high_good" title="Higher is better">good↑</button>'+
               '</div>'+
             '</div>'+
             '<label class="qv-col-ctrl" title="Critical threshold. Warn is auto ±10%. Leave empty to disable.">'+
               '<span class="qv-col-ctrl-lbl">Thresh</span>'+
               '<input type="number" class="qv-col-thresh" step="any" placeholder="—" value="'+threshVal+'">'+
             '</label>'+
           '</div>';
          })()
        : '';
      return '<th colspan="'+(c.aggregations||[]).length+'" class="sort-group metric-group'+(isQuick?' has-qv-controls':'')+'">'+
        '<div class="metric-group-label">'+escHtml(c.label)+'</div>'+controls+'</th>';
    })
  ).join('');
  const headerRow2 = columns.reduce(function(acc,c){
    return acc.concat((c.aggregations||[]).map(function(a){
      const html = '<th data-sort-col="'+sortCol+'" class="sortable metric-sub">'+escHtml(a)+'</th>';
      sortCol++;
      return html;
    }));
  }, []).join('');
  const bodyRows = (result.rows||[]).map(function(row){
    const cells = columns.reduce(function(acc, col){
      const cell = row.cells[col.id];
      const itemid = col.host_items && (col.host_items[String(row.hostid)] || col.host_items[row.hostid]);
      const disp = col.display || 'number';
      const tds = (col.aggregations||[]).map(function(agg, aIdx){
        if(!cell || cell.values[agg] === null || cell.values[agg] === undefined){
          return '<td class="metric-empty" data-export-text="—"><span class="badge-nodata" title="No values in this period">No data</span></td>';
        }
        const v = cell.values[agg];
        // Saved dashboards: backend already applied col.multiplier.
        // Quick view (col.raw): API uses mult=1; apply col.multiplier here only.
        const mult = (Number(col.multiplier) > 0 && isFinite(Number(col.multiplier))) ? Number(col.multiplier) : 1;
        const applyClientMult = !!col.raw;
        const num = typeof v === 'number' ? (applyClientMult ? (v * mult) : v) : null;
        const display = num != null ? num.toFixed(col.decimals != null ? col.decimals : 2) : v;
        // raw: no auto Zabbix units; still show user-set col.unit
        const unit = col.raw ? (col.unit || '') : (cell.units || col.unit || '');
        const thOff = !col.thresholds || !col.thresholds.mode || col.thresholds.mode === 'off';
        const cls = (col.raw && thOff) ? 'metric-raw' : metricClass(num, col);
        let deltaHtml = '';
        let cellDelta = null;
        let prevHtml = '';
        // Previous-period comparison for every aggregation (avg, min, max, last)
        if(num != null && prevByHost[String(row.hostid)]){
          const prevCell = prevByHost[String(row.hostid)][col.id];
          if(prevCell && typeof prevCell.values[agg] === 'number'){
            const pvRaw = prevCell.values[agg];
            const pv = applyClientMult ? (pvRaw * mult) : pvRaw;
            // high_good / good_high: higher is better → green on up
            // high_bad / bad_high / default: lower is better → green on down
            const thMode = col.thresholds && col.thresholds.mode;
            const mode = (thMode && thMode !== 'off')
              ? thMode
              : (col.color_mode === 'good_high' ? 'high_good' : 'high_bad');
            const goodWhenDown = mode === 'high_bad' || mode === 'bad_high';
            // Compare in the same space as displayed numbers
            deltaHtml = deltaBadgeHtml(num, pv, goodWhenDown);
            cellDelta = (typeof num === 'number' && typeof pv === 'number') ? (num - pv) : null;
            prevHtml = '<div class="metric-prev">prev '+pv.toFixed(col.decimals != null ? col.decimals : 2)+(unit?' '+unit:'')+'</div>';
          }
        }
        const clickable = itemid ? ' pivot-clickable' : '';
        // Graphs only on avg — min / max / last are always plain numbers
        const isAvg = agg === 'avg';
        const showGraph = isAvg
          && (disp === 'graph' || disp === 'number_graph')
          && !!itemid;
        const th = col.thresholds || {};
        const thMode = (th.mode && th.mode !== 'off')
          ? th.mode
          : (col.color_mode === 'good_high' ? 'high_good' : (col.color_mode === 'bad_high' ? 'high_bad' : 'off'));
        const thYellow = th.yellow != null ? th.yellow : 75;
        const thRed = th.red != null ? th.red : 90;
        // Threshold + multiplier on the cell so drill-down chart can match sparkline coloring
        // data-export-num  → CSV (number, always 2 decimals)
        // data-export-text → PDF (formatted value + unit)
        // data-export-tone → PDF threshold colour (good|warn|bad)
        const exportNum = num != null ? num.toFixed(2) : '';
        // Consistent unit spacing: "100.00%" (no space), otherwise "2.27 ms"
        const exportText = num != null
          ? (exportNum + (unit ? (unit === '%' ? '%' : ' ' + unit) : ''))
          : String(v);
        const exportTone = cls === 'metric-bad' ? 'bad' : (cls === 'metric-warn' ? 'warn' : (cls === 'metric-good' ? 'good' : ''));
        const exportAttrs = (exportNum !== '' ? ' data-export-num="'+exportNum+'"' : '') +
          ' data-export-text="'+escHtml(exportText)+'"' +
          (exportTone ? ' data-export-tone="'+exportTone+'"' : '') +
          (cellDelta != null && isFinite(cellDelta) ? ' data-delta="'+cellDelta.toFixed(4)+'"' : '');
        const dataAttrs = (itemid
          ? ' data-itemid="'+itemid+'" data-host="'+escHtml(row.host)+'" data-col="'+escHtml(col.label)+'" data-unit="'+escHtml(unit)+'"'+
            ' data-mult="'+mult+'" data-th-mode="'+thMode+'" data-th-yellow="'+thYellow+'" data-th-red="'+thRed+'"'
          : '') + exportAttrs;
        // Fixed-size spark placeholder (identical box in every graph cell)
        const spark = showGraph
          ? '<div class="metric-spark" data-itemid="'+itemid+'" data-mult="'+mult+'"'+
            ' data-unit="'+escHtml(unit)+'"'+
            ' data-th-mode="'+thMode+'"'+
            ' data-th-yellow="'+thYellow+'"'+
            ' data-th-red="'+thRed+'"'+
            ' title="Period trend (avg)"></div>'
          : '';
        // Unified cell stack: value on top, fixed graphic underneath
        const valueHtml = '<div class="metric-num">'+display+(unit?' '+unit:'')+deltaHtml+'</div>';
        let inner = '';
        if(!isAvg){
          // min / max / last — number only (right-aligned)
          inner = '<div class="metric-num">'+display+(unit?' '+unit:'')+deltaHtml+'</div>'+prevHtml;
        } else if(showGraph){
          // graph / number_graph → same structure always
          inner = '<div class="metric-with-spark">'+valueHtml+spark+'</div>'+prevHtml;
        } else if((disp === 'bar' || disp === 'number_bar') && num != null){
          // bar modes use the same vertical stack + fixed-width bar slot
          inner = '<div class="metric-with-spark">'+
            valueHtml+
            '<div class="metric-spark metric-spark-bar">'+metricBarHtml(num, col)+'</div>'+
            '</div>'+prevHtml;
        } else {
          inner = valueHtml+prevHtml;
        }
        return '<td class="'+cls+clickable+'"'+dataAttrs+'>'+inner+'</td>';
      });
      return acc.concat(tds);
    }, []).join('');
    const health = pivotRowHealth(row, columns);
    const hostLabel = row.host || row.name || String(row.hostid || '');
    const hostLink = '<button type="button" class="host-link" data-hostid="'+escHtml(String(row.hostid||''))+'" data-host="'+escHtml(hostLabel)+'" title="Host details">'+escHtml(hostLabel)+'</button>';
    var cmp = '';
    try{
      if(window._zrCompareHostStatus && row.hostid != null)
        cmp = window._zrCompareHostStatus[String(row.hostid)] || '';
    }catch(e){ cmp = ''; }
    return '<tr data-health="'+health+'" data-compare="'+(cmp||'')+'" data-hostid="'+escHtml(String(row.hostid||''))+'"><td class="host-cell">'+hostLink+'</td>'+cells+'</tr>';
  }).join('');
  return '<div class="pivot-wrap"><table class="pivot"><thead><tr>'+headerRow1+'</tr><tr>'+headerRow2+'</tr></thead><tbody>'+bodyRows+'</tbody></table></div>'+
    '<div class="metrics-legend">'+
      '<span class="leg ok"><i></i> Normal</span>'+
      '<span class="leg warn"><i></i> Approaching threshold</span>'+
      '<span class="leg bad"><i></i> Over threshold</span>'+
    '</div>';
}

function computeInsightStrip(dashboard, result){
  const columns = dashboard.columns || [];
  let bad = 0, warn = 0, ok = 0, offline = 0;
  (result.rows || []).forEach(function(row){
    const h = pivotRowHealth(row, columns);
    if(h === 'critical') bad++;
    else if(h === 'warning') warn++;
    else if(h === 'offline') offline++;
    else ok++;
  });
  if(!bad && !warn && !ok && !offline) return '';
  let html = '<div class="insight-strip insight-strip-filter" title="Click a badge to filter hosts">';
  if(bad) html += '<button type="button" class="insight-chip bad" data-health-filter="critical" aria-pressed="false"><b>'+bad+'</b> critical</button>';
  if(warn) html += '<button type="button" class="insight-chip warn" data-health-filter="warning" aria-pressed="false"><b>'+warn+'</b> warning</button>';
  if(ok) html += '<button type="button" class="insight-chip ok" data-health-filter="healthy" aria-pressed="false"><b>'+ok+'</b> healthy</button>';
  if(offline) html += '<button type="button" class="insight-chip muted" data-health-filter="offline" aria-pressed="false"><b>'+offline+'</b> no data</button>';
  html += '</div>';
  return html;
}

/** Toggle table rows by health / compare badges. */
function wireInsightHealthFilter(container){
  if(!container) return;
  const table = container.querySelector('table.pivot');
  if(!table) return;
  // Health strip + compare strip may both use insight-strip-filter
  const strips = container.querySelectorAll('.insight-strip-filter, .compare-strip');
  if(!strips.length) return;

  function apply(){
    const healthActive = [];
    const compareActive = [];
    container.querySelectorAll('[data-health-filter].active').forEach(function(c){
      healthActive.push(c.getAttribute('data-health-filter'));
    });
    container.querySelectorAll('[data-compare-filter].active').forEach(function(c){
      compareActive.push(c.getAttribute('data-compare-filter'));
    });
    table.querySelectorAll('tbody tr').forEach(function(tr){
      const h = tr.getAttribute('data-health') || '';
      const cmp = tr.getAttribute('data-compare') || '';
      const healthOk = !healthActive.length || healthActive.indexOf(h) >= 0;
      const compareOk = !compareActive.length || compareActive.indexOf(cmp) >= 0;
      tr.style.display = (healthOk && compareOk) ? '' : 'none';
    });
  }

  container.querySelectorAll('[data-health-filter], [data-compare-filter]').forEach(function(chip){
    if(chip.tagName !== 'BUTTON'){
      // Upgrade spans to buttons for a11y if needed — already buttons in new markup
      chip.style.cursor = 'pointer';
    }
    chip.addEventListener('click', function(){
      const on = !chip.classList.contains('active');
      // Exclusive within same filter group (health vs compare)
      const group = chip.hasAttribute('data-health-filter') ? 'data-health-filter' : 'data-compare-filter';
      container.querySelectorAll('['+group+']').forEach(function(c){
        if(c === chip) return;
        // allow multi-select within group — only toggle this chip
      });
      chip.classList.toggle('active', on);
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
      apply();
    });
  });
}

/** Collect dashboard columns mapped to this host for host-detail charts. */
function hostDetailMetricsFor(hostid){
  const dash = dashState.current;
  if(!dash || !dash.columns) return [];
  const hid = String(hostid);
  const out = [];
  (dash.columns || []).forEach(function(col){
    const itemid = col.host_items && (col.host_items[hid] || col.host_items[hostid]);
    if(!itemid) return;
    const th = col.thresholds || {};
    const thMode = (th.mode && th.mode !== 'off')
      ? th.mode
      : (col.color_mode === 'good_high' ? 'high_good' : (col.color_mode === 'bad_high' ? 'high_bad' : 'off'));
    out.push({
      itemid: parseInt(itemid, 10),
      label: col.label || col.name || ('Metric '+itemid),
      unit: col.unit || '',
      multiplier: (col.multiplier != null && !isNaN(col.multiplier)) ? Number(col.multiplier) : 1,
      thresholds: {
        mode: thMode,
        yellow: th.yellow != null ? th.yellow : 75,
        red: th.red != null ? th.red : 90,
      },
    });
  });
  return out;
}

/** Open host detail drawer (problems + metric snapshot) when a hostname is clicked. */
function wireHostDetailLinks(container, dateFrom, dateTo, dayHours){
  if(!container) return;
  container.querySelectorAll('button.host-link').forEach(function(btn){
    btn.addEventListener('click', function(ev){
      ev.preventDefault();
      ev.stopPropagation();
      const hostid = btn.getAttribute('data-hostid');
      openHostDetailDrawer({
        hostid: hostid,
        host: btn.getAttribute('data-host') || '',
        dateFrom: dateFrom,
        dateTo: dateTo,
        dayHours: dayHours || {},
        metrics: hostDetailMetricsFor(hostid),
      });
    });
  });
}

async function openHostDetailDrawer(opts){
  const hostid = parseInt(opts.hostid, 10);
  const hostName = opts.host || ('Host '+opts.hostid);
  const metrics = opts.metrics || [];
  const dayHours = opts.dayHours || {};

  // Clear any previous single-chart resize handler from cell drill-down
  if(window._ddChartResizeHandler){
    window.removeEventListener('resize', window._ddChartResizeHandler);
    window._ddChartResizeHandler = null;
  }
  if(window._hostDetailKeyHandler){
    document.removeEventListener('keydown', window._hostDetailKeyHandler);
    window._hostDetailKeyHandler = null;
  }

  const chartsHtml = metrics.length
    ? '<div class="host-detail-section"><h4>Metrics (avg)</h4>'+
        '<p class="host-detail-sub host-detail-chart-hint">Drag any chart to zoom all · <kbd>0</kbd> resets all charts</p>'+
        '<div id="hostDetailCharts" class="host-detail-charts">'+
          metrics.map(function(m, i){
            return '<div class="host-metric-card" data-metric-idx="'+i+'">'+
              '<div class="host-metric-head">'+
                '<span class="host-metric-label">'+escHtml(m.label)+'</span>'+
                '<span class="host-metric-stats" id="hdStats'+i+'">Loading…</span>'+
              '</div>'+
              '<div class="chart-wrap chart-wrap-hd">'+
                '<canvas class="chart" id="hdChart'+i+'" height="160"></canvas>'+
                '<div class="tooltip" id="hdTooltip'+i+'"></div>'+
              '</div>'+
              '<div class="hd-zoom-bar">'+
                '<span class="hd-zoom-range" id="hdZoomRange'+i+'" hidden></span>'+
                '<button type="button" class="btn btn-ghost hd-reset-zoom" id="hdReset'+i+'" style="display:none;">Reset zoom</button>'+
              '</div>'+
            '</div>';
          }).join('')+
        '</div></div>'
    : '<div class="host-detail-section"><h4>Metrics</h4><div class="host-detail-empty">No mapped metrics for this host on the current dashboard.</div></div>';

  openDrawer(hostName,
    '<div class="host-detail">'+
      '<div class="host-detail-toolbar">'+
        '<p class="host-detail-sub">Active problems and average graphs for dashboard metrics.</p>'+
        '<button type="button" class="btn btn-ghost" id="hostDetailMaxBtn" title="Expand panel to full page width">Maximize</button>'+
      '</div>'+
      chartsHtml+
      '<div class="host-detail-section"><h4>Active problems</h4><div id="hostDetailProblems"><span class="stat">Loading…</span></div></div>'+
    '</div>');

  // Problems (parallel with charts)
  (async function loadProblems(){
    const box = document.getElementById('hostDetailProblems');
    try{
      const res = await apiFetch('/api/problems', {
        method: 'POST',
        timeoutMs: 20000,
        body: JSON.stringify({ hostids: [hostid], min_severity: 0 }),
      });
      if(!res.ok){
        const err = await res.json().catch(function(){ return {}; });
        throw new Error((typeof formatApiDetail === 'function' ? formatApiDetail(err.detail, 'HTTP '+res.status) : (err.detail && (err.detail.message || JSON.stringify(err.detail))) || ('HTTP '+res.status)));
      }
      const data = await res.json();
      const problems = data.problems || data || [];
      if(!box) return;
      if(!problems.length){
        box.innerHTML = '<div class="host-detail-empty">No active problems on this host.</div>';
        return;
      }
      box.innerHTML = '<ul class="host-detail-problems">'+problems.slice(0, 40).map(function(p){
        const sev = p.severity_label || ('Sev '+p.severity);
        const name = p.problem_name || p.name || p.description || 'Problem';
        const since = p.clock ? fmtTime(p.clock) : '';
        return '<li class="host-detail-prob sev-'+p.severity+'">'+
          '<span class="sev-pill">'+escHtml(String(sev))+'</span> '+
          '<span class="prob-name">'+escHtml(name)+'</span>'+
          (since ? '<span class="prob-since">'+escHtml(since)+'</span>' : '')+
        '</li>';
      }).join('')+
      (problems.length > 40 ? '<li class="host-detail-empty">…and '+(problems.length-40)+' more</li>' : '')+
      '</ul>';
    }catch(err){
      if(box) box.innerHTML = '<div class="host-detail-empty">Could not load problems: '+escHtml(String(err.message||err))+'</div>';
    }
  })();

  // Metric charts with threshold coloring + linked drag-zoom (one zoom → all graphs)
  if(!metrics.length) return;
  const controllers = [];
  // Shared zoom as ratios of each series length so charts with different point counts stay aligned
  let sharedFromRatio = 0;
  let sharedToRatio = 1;

  function applySharedZoomToAll(){
    controllers.forEach(function(c){
      try{ c.applyRatio(sharedFromRatio, sharedToRatio); }catch(_){}
    });
  }
  function resetAllZoom(){
    sharedFromRatio = 0;
    sharedToRatio = 1;
    applySharedZoomToAll();
  }

  async function loadMetricChart(m, idx){
    const statsEl = document.getElementById('hdStats'+idx);
    const canvas = document.getElementById('hdChart'+idx);
    const tip = document.getElementById('hdTooltip'+idx);
    const rangeEl = document.getElementById('hdZoomRange'+idx);
    const resetBtn = document.getElementById('hdReset'+idx);
    if(!canvas || !tip) return;

    try{
      const res = await apiFetch('/api/items/series', {
        method: 'POST',
        timeoutMs: 30000,
        body: JSON.stringify({
          itemids: [m.itemid],
          date_from: opts.dateFrom,
          date_to: opts.dateTo,
          resolution: 'auto',
          day_time_from: dayHours.day_time_from || null,
          day_time_to: dayHours.day_time_to || null,
          tz_offset_min: apiTzOffsetMin(),
        }),
      });
      if(!res.ok){
        const err = await res.json().catch(function(){ return {}; });
        throw new Error((typeof formatApiDetail === 'function' ? formatApiDetail(err.detail, 'HTTP '+res.status) : (err.detail && (err.detail.message || JSON.stringify(err.detail))) || ('HTTP '+res.status)));
      }
      const data = await res.json();
      const s = (data.series || [])[0];
      if(!s || !s.points || !s.points.length){
        if(statsEl) statsEl.textContent = 'No data';
        return;
      }
      const mult = m.multiplier || 1;
      const unit = m.unit || s.units || '';
      const labels = s.points.map(function(p){ return fmtTimeShort(p.clock); });
      const values = s.points.map(function(p){
        const v = typeof p.value === 'number' ? p.value : p.avg;
        return typeof v === 'number' ? v * mult : null;
      });
      const nFull = labels.length;
      let zoomFrom = 0;
      let zoomTo = nFull - 1;

      function ratiosToIndices(fromR, toR){
        if(nFull <= 1) return { from: 0, to: 0 };
        let from = Math.round(fromR * (nFull - 1));
        let to = Math.round(toR * (nFull - 1));
        from = Math.max(0, Math.min(nFull - 1, from));
        to = Math.max(0, Math.min(nFull - 1, to));
        if(to < from){ const t = from; from = to; to = t; }
        if(to === from && nFull > 1){
          if(to < nFull - 1) to = from + 1;
          else from = Math.max(0, to - 1);
        }
        return { from: from, to: to };
      }
      function isZoomed(){ return zoomFrom > 0 || zoomTo < nFull - 1; }
      function updateZoomUi(){
        if(resetBtn) resetBtn.style.display = isZoomed() ? '' : 'none';
        if(rangeEl){
          if(isZoomed() && labels[zoomFrom] != null && labels[zoomTo] != null){
            rangeEl.hidden = false;
            rangeEl.textContent = labels[zoomFrom]+' → '+labels[zoomTo];
          } else {
            rangeEl.hidden = true;
            rangeEl.textContent = '';
          }
        }
        const vis = values.slice(zoomFrom, zoomTo + 1).filter(function(v){ return typeof v === 'number'; });
        const vmin = vis.length ? Math.min.apply(null, vis) : null;
        const vmax = vis.length ? Math.max.apply(null, vis) : null;
        const vavg = vis.length ? vis.reduce(function(a,b){ return a+b; },0)/vis.length : null;
        if(statsEl){
          statsEl.innerHTML =
            'min '+(vmin!=null?formatValue(vmin,unit):'—')+
            ' · avg '+(vavg!=null?formatValue(vavg,unit):'—')+
            ' · max '+(vmax!=null?formatValue(vmax,unit):'—');
        }
      }
      function chartHeight(){
        const drawer = document.getElementById('detailDrawer');
        const maximized = drawer && drawer.classList.contains('drawer-maximized');
        if(!maximized) return 160;
        const n = Math.max(1, metrics.length);
        const avail = Math.max(220, ((window.innerHeight || 700) - 200) / Math.min(n, 3));
        return Math.min(Math.round(avail), 360);
      }
      function redraw(){
        const c = document.getElementById('hdChart'+idx);
        const t = document.getElementById('hdTooltip'+idx);
        if(!c || !t) return;
        drawLineChart(c, t, {
          labels: labels,
          datasets: [{ label: m.label, data: values, color: '#3FBF6F' }],
          showLegend: false,
          height: chartHeight(),
          valueFmt: function(v){ return formatValue(v, unit); },
          thresholds: m.thresholds && m.thresholds.mode !== 'off' ? m.thresholds : null,
          viewFrom: zoomFrom,
          viewTo: zoomTo,
          onZoom: function(absFrom, absTo){
            if(absTo <= absFrom) return;
            // Publish shared ratios so every graph zooms to the same relative window
            if(nFull > 1){
              sharedFromRatio = absFrom / (nFull - 1);
              sharedToRatio = absTo / (nFull - 1);
            } else {
              sharedFromRatio = 0;
              sharedToRatio = 1;
            }
            applySharedZoomToAll();
          },
        });
      }
      function applyRatio(fromR, toR){
        const idxRange = ratiosToIndices(fromR, toR);
        zoomFrom = idxRange.from;
        zoomTo = idxRange.to;
        updateZoomUi();
        redraw();
      }
      function resetZoom(){
        applyRatio(0, 1);
      }
      if(resetBtn){
        resetBtn.addEventListener('click', function(){
          resetAllZoom();
        });
      }
      controllers.push({
        resetZoom: resetZoom,
        redraw: redraw,
        applyRatio: applyRatio,
        canvas: canvas,
      });
      // Apply current shared zoom (in case another chart already zoomed)
      applyRatio(sharedFromRatio, sharedToRatio);
    }catch(err){
      if(statsEl) statsEl.textContent = 'Failed: '+(err.message || err);
    }
  }

  // Load charts (stagger slightly to avoid thundering herd)
  metrics.forEach(function(m, i){
    setTimeout(function(){ loadMetricChart(m, i); }, i * 40);
  });

  function redrawAllHostCharts(){
    controllers.forEach(function(c){ try{ if(c.redraw) c.redraw(); }catch(_){} });
  }
  function setHostDetailMaximized(on){
    const drawer = document.getElementById('detailDrawer');
    const maxBtn = document.getElementById('hostDetailMaxBtn');
    if(!drawer) return;
    drawer.classList.toggle('drawer-maximized', !!on);
    if(maxBtn){
      maxBtn.textContent = on ? 'Restore' : 'Maximize';
      maxBtn.title = on ? 'Restore panel size (Esc)' : 'Expand panel to full page width';
      maxBtn.classList.toggle('is-active', !!on);
    }
    setTimeout(redrawAllHostCharts, 240);
  }
  const maxBtn = document.getElementById('hostDetailMaxBtn');
  if(maxBtn){
    maxBtn.addEventListener('click', function(){
      const drawer = document.getElementById('detailDrawer');
      if(!drawer) return;
      setHostDetailMaximized(!drawer.classList.contains('drawer-maximized'));
    });
  }
  if(window._hostDetailResizeHandler){
    window.removeEventListener('resize', window._hostDetailResizeHandler);
  }
  window._hostDetailResizeHandler = function(){
    const drawer = document.getElementById('detailDrawer');
    if(drawer && drawer.classList.contains('show') && drawer.classList.contains('drawer-maximized')){
      redrawAllHostCharts();
    }
  };
  window.addEventListener('resize', window._hostDetailResizeHandler);

  // Keyboard: 0 resets zoom on ALL charts; Esc restores maximize first
  window._hostDetailKeyHandler = function(ev){
    const drawer = document.getElementById('detailDrawer');
    if(!drawer || !drawer.classList.contains('show')) return;
    const tag = (ev.target && ev.target.tagName) || '';
    if(tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if(ev.key === '0' && !ev.ctrlKey && !ev.metaKey && !ev.altKey){
      resetAllZoom();
    }
    if(ev.key === 'Escape' && drawer.classList.contains('drawer-maximized')){
      ev.preventDefault();
      ev.stopPropagation();
      setHostDetailMaximized(false);
    }
  };
  document.addEventListener('keydown', window._hostDetailKeyHandler);
}


/**
 * Summary of vs-previous-period movement (uses same good/bad direction as delta badges).
 * Counts hosts that got worse / better on any metric cell, plus cell-level totals.
 */
function computeCompareStrip(dashboard, result, prevResult){
  if(!prevResult || !prevResult.rows || !result || !result.rows) return '';
  const columns = dashboard.columns || [];
  const prevByHost = {};
  prevResult.rows.forEach(function(r){ prevByHost[String(r.hostid)] = r.cells; });

  let cellsWorse = 0, cellsBetter = 0, cellsFlat = 0, cellsCompared = 0;
  const hostsWorse = {};
  const hostsBetter = {};

  (result.rows || []).forEach(function(row){
    const prevCells = prevByHost[String(row.hostid)];
    if(!prevCells) return;
    columns.forEach(function(col){
      const cell = row.cells[col.id];
      const prevCell = prevCells[col.id];
      if(!cell || !prevCell) return;
      const thMode = col.thresholds && col.thresholds.mode;
      const mode = (thMode && thMode !== 'off')
        ? thMode
        : (col.color_mode === 'good_high' ? 'high_good' : 'high_bad');
      const goodWhenDown = mode === 'high_bad' || mode === 'bad_high';
      (col.aggregations || []).forEach(function(agg){
        const v = cell.values[agg];
        const pv = prevCell.values[agg];
        if(typeof v !== 'number' || typeof pv !== 'number') return;
        cellsCompared++;
        let dir = 'flat';
        if(pv === 0){
          if(v !== 0) dir = v > 0 ? 'up' : 'down';
        } else {
          const pct = ((v - pv) / Math.abs(pv)) * 100;
          if(isFinite(pct)){
            if(pct > 0.5) dir = 'up';
            else if(pct < -0.5) dir = 'down';
          }
        }
        if(dir === 'flat'){ cellsFlat++; return; }
        // Movement is "worse" when value went the wrong way for this metric
        const worse = goodWhenDown ? (dir === 'up') : (dir === 'down');
        if(worse){
          cellsWorse++;
          hostsWorse[String(row.hostid)] = true;
        } else {
          cellsBetter++;
          hostsBetter[String(row.hostid)] = true;
        }
      });
    });
  });

  if(!cellsCompared) return '';

  const nWorse = Object.keys(hostsWorse).length;
  const nBetter = Object.keys(hostsBetter).length;
  const nHosts = (result.rows || []).length;

  let html = '<div class="insight-strip compare-strip" title="Compared to the previous period of equal length">';
  html += '<span class="insight-chip compare-label">vs previous</span>';
  if(nWorse){
    html += '<span class="insight-chip bad"><b>'+nWorse+'</b> host'+(nWorse===1?'':'s')+' worse</span>';
  }
  if(nBetter){
    html += '<span class="insight-chip ok"><b>'+nBetter+'</b> host'+(nBetter===1?'':'s')+' better</span>';
  }
  if(!nWorse && !nBetter){
    html += '<span class="insight-chip flat"><b>0</b> hosts changed</span>';
  }
  html += '<span class="insight-chip muted">'+cellsWorse+'↑bad · '+cellsBetter+'↑good · '+cellsFlat+' flat · '+nHosts+' hosts</span>';
  html += '</div>';
  return html;
}

/** Measure first thead row so the second sticky header row sits flush under it.
 *  Also writes top on second-row th cells so sticky works even if CSS var lags. */
function wirePivotStickyHeaders(container){
  if(!container) return;
  const wrap = container.classList && container.classList.contains('pivot-wrap')
    ? container
    : container.querySelector('.pivot-wrap');
  if(!wrap) return;
  const table = wrap.querySelector('table.pivot') || wrap.querySelector('table.problems-table');
  if(!table) return;
  const thead = table.querySelector('thead');
  const first = thead && thead.querySelector('tr:first-child');
  if(!first) return;
  const secondCells = thead.querySelectorAll('tr:nth-child(2) th');
  const apply = function(){
    const h = Math.ceil(first.getBoundingClientRect().height);
    if(h > 0){
      wrap.style.setProperty('--pivot-head-h', h + 'px');
      // Inline top so dual-row sticky is reliable across browsers
      secondCells.forEach(function(th){ th.style.top = h + 'px'; });
    }
  };
  apply();
  // Re-measure after fonts/layout settle (inputs in Quick-view headers can grow row)
  requestAnimationFrame(function(){ apply(); requestAnimationFrame(apply); });
  if(typeof ResizeObserver !== 'undefined'){
    if(wrap._pivotHeadRO) try{ wrap._pivotHeadRO.disconnect(); }catch(_){}
    wrap._pivotHeadRO = new ResizeObserver(apply);
    wrap._pivotHeadRO.observe(first);
    wrap._pivotHeadRO.observe(table);
  }
}

function wirePivotDrilldown(container, dateFrom, dateTo, dayHours){
  if(!container) return;
  wirePivotStickyHeaders(container);
  const hours = dayHours || { day_time_from: null, day_time_to: null };
  container.querySelectorAll('td.pivot-clickable').forEach(function(td){
    td.addEventListener('click', function(){
      openPivotCellDrilldown({
        itemid: parseInt(td.dataset.itemid, 10),
        host: td.dataset.host,
        colLabel: td.dataset.col,
        unit: td.dataset.unit,
        dateFrom: dateFrom,
        dateTo: dateTo,
        multiplier: parseFloat(td.dataset.mult) || 1,
        thresholds: {
          mode: td.dataset.thMode || 'off',
          yellow: parseFloat(td.dataset.thYellow),
          red: parseFloat(td.dataset.thRed),
        },
        day_time_from: hours.day_time_from,
        day_time_to: hours.day_time_to,
      });
    });
  });
  wirePivotSparklines(container, dateFrom, dateTo, hours);
}

/** Load time series for sparkline placeholders (graph / number_graph display). */
async function wirePivotSparklines(container, dateFrom, dateTo, dayHours){
  if(!container) return;
  const nodes = Array.from(container.querySelectorAll('.metric-spark[data-itemid]'));
  if(!nodes.length) return;
  const hours = dayHours || { day_time_from: null, day_time_to: null };
  const byId = {};
  nodes.forEach(function(el){
    const id = parseInt(el.dataset.itemid, 10);
    if(!id) return;
    if(!byId[id]) byId[id] = [];
    byId[id].push(el);
    el.innerHTML = '<span class="spark-loading">…</span>';
  });
  const ids = Object.keys(byId).map(function(k){ return parseInt(k, 10); });
  // Batch in chunks of 40 (API limit)
  const CHUNK = 40;
  const seriesByItem = {};
  const seriesBody = {
    date_from: dateFrom,
    date_to: dateTo,
    resolution: 'auto',
    day_time_from: hours.day_time_from || null,
    day_time_to: hours.day_time_to || null,
    tz_offset_min: apiTzOffsetMin(),
  };
  for(let i = 0; i < ids.length; i += CHUNK){
    const chunk = ids.slice(i, i + CHUNK);
    try{
      const res = await apiFetch('/api/items/series', {
        method: 'POST',
        body: JSON.stringify(Object.assign({ itemids: chunk }, seriesBody)),
      });
      if(!res.ok) continue;
      const data = await res.json();
      (data.series || []).forEach(function(s){
        seriesByItem[String(s.itemid)] = s;
      });
    }catch(e){ console.warn('sparkline series', e); }
  }
  const SPARK_H = 28;
  function paintSparkEl(el, values, thOpts){
    // Width follows the column/cell; measure after layout
    let w = Math.round(el.clientWidth || el.offsetWidth || 0);
    if(w < 40){
      // Cell may not be laid out yet — fall back to parent td
      const td = el.closest('td');
      if(td) w = Math.round(td.clientWidth - 24);
    }
    if(w < 40) w = 64;
    if(w > 320) w = 320;
    el.innerHTML = sparklineSvg(values, w, SPARK_H, thOpts, null);
  }

  Object.keys(byId).forEach(function(idStr){
    const series = seriesByItem[idStr];
    byId[idStr].forEach(function(el){
      if(!series || !(series.points||[]).length){
        el.innerHTML = '';
        el._sparkValues = null;
        return;
      }
      const mult = parseFloat(el.dataset.mult) || 1;
      const values = (series.points || []).map(function(p){
        let v = null;
        if(typeof p.avg === 'number') v = p.avg;
        else if(typeof p.value === 'number') v = p.value;
        else if(typeof p.value_avg === 'number') v = p.value_avg;
        return v == null ? null : v * mult;
      }).filter(function(v){ return typeof v === 'number' && !isNaN(v); });
      const thOpts = {
        mode: el.dataset.thMode || 'off',
        yellow: parseFloat(el.dataset.thYellow),
        red: parseFloat(el.dataset.thRed),
      };
      // Cache for resize repaints
      el._sparkValues = values;
      el._sparkTh = thOpts;
      paintSparkEl(el, values, thOpts);
    });
  });

  // Re-paint sparklines when column widths change (window resize / maximize)
  if(container._sparkRO){
    try{ container._sparkRO.disconnect(); }catch(_){}
    container._sparkRO = null;
  }
  function repaintAllSparks(){
    container.querySelectorAll('.metric-spark[data-itemid]').forEach(function(el){
      if(!el._sparkValues || !el._sparkValues.length) return;
      paintSparkEl(el, el._sparkValues, el._sparkTh || { mode: 'off' });
    });
  }
  // Double-rAF so first paint uses final column widths after table layout
  requestAnimationFrame(function(){
    requestAnimationFrame(repaintAllSparks);
  });
  if(typeof ResizeObserver !== 'undefined'){
    let roTimer = null;
    container._sparkRO = new ResizeObserver(function(){
      if(roTimer) clearTimeout(roTimer);
      roTimer = setTimeout(repaintAllSparks, 80);
    });
    const wrap = container.querySelector('.pivot-wrap') || container;
    container._sparkRO.observe(wrap);
  } else {
    if(container._sparkResizeHandler){
      window.removeEventListener('resize', container._sparkResizeHandler);
    }
    let t = null;
    container._sparkResizeHandler = function(){
      if(t) clearTimeout(t);
      t = setTimeout(repaintAllSparks, 100);
    };
    window.addEventListener('resize', container._sparkResizeHandler);
  }
}




