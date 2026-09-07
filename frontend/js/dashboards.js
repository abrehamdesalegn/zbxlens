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
        total++;
      }
    });
  });
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
  const existingIds = new Set(dashboards.map(function(d){ return d.id; }));
  const recents = getRecents('dash');

  function renderCards(list){
    return list.map(function(d){
      const nHosts = (d.hostids && d.hostids.length) || 0;
      const nCols = (d.columns && d.columns.length) || 0;
      const updated = d.updated_at ? new Date(d.updated_at*1000).toLocaleDateString() : '';
      const owner = d.mine ? 'You' : ('By '+escHtml(d.owner_username||'unknown'));
      const shareBadge = shareBadgeHtml(d);
      const pinned = isPinned('dashboard', d.id);
      const editBtns = d.can_edit
        ? '<button data-act="edit" data-id="'+d.id+'">Edit</button>'+
          '<button data-act="delete" data-id="'+d.id+'" class="danger">Delete</button>'
        : '';
      const dupBtn = canManage() ? '<button data-act="dup" data-id="'+d.id+'">Duplicate</button>' : '';
      return '<div class="dash-card">'+
        '<div class="dash-card-top"><h4>'+escHtml(d.name||'Untitled')+shareBadge+'</h4>'+
          '<button type="button" class="pin-btn'+(pinned?' pinned':'')+'" data-act="pin" data-id="'+d.id+'" title="'+(pinned?'Unpin':'Pin to top')+'">★</button>'+
        '</div>'+
        '<div class="dash-meta">'+owner+' · '+nHosts+' host'+(nHosts===1?'':'s')+' · '+nCols+' metric'+(nCols===1?'':'s')+(updated?' · updated '+updated:'')+'</div>'+
        '<div class="dash-actions">'+
          '<button data-act="run" data-id="'+d.id+'">Run</button>'+
          '<button data-act="export" data-id="'+d.id+'">Export</button>'+
          dupBtn+editBtns+
        '</div></div>';
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
  let fromVal = '', toVal = '', lab = 'UTC';
  try{
    fromVal = fromEpochToLocalInput(nowSec - 24*3600);
    toVal = fromEpochToLocalInput(nowSec);
    lab = tzLabel();
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
    '<p class="page-intro">Browse live metrics across hosts, or open a saved dashboard for multi-column layouts.</p>'+
    '<div class="filterbar qv-bar" style="margin-bottom:18px;">'+
      '<div class="eyebrow" style="margin-bottom:8px;">Quick view</div>'+
      /* Row 1: Host group · Load · Hosts */
      '<div class="qv-row">'+
        '<div class="field" style="flex:0 1 200px;min-width:140px;"><label for="dqGroup">Host group</label><select id="dqGroup">'+groupOpts+'</select></div>'+
        '<div class="field" style="flex:0 0 auto;"><label>&nbsp;</label>'+
          '<button type="button" class="btn btn-ghost" id="dqLoadGroupBtn" style="height:38px;white-space:nowrap;">Load hosts</button></div>'+
        '<div class="field" style="flex:1 1 220px;min-width:160px;"><label>Hosts</label>'+
          '<div class="picker" id="dqHostsPicker">'+
            '<div class="picker-trigger" id="dqHostsTrigger" tabindex="0">'+
              '<span class="picker-placeholder" id="dqHostsPlaceholder">Select hosts…</span>'+
              '<svg class="picker-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 9L12 15L18 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'+
            '</div>'+
            '<div class="picker-panel" id="dqHostsPanel">'+
              '<input class="picker-search" id="dqHostsSearch" placeholder="Filter hosts…" autocomplete="off">'+
              '<div class="picker-list" id="dqHostsList"></div>'+
            '</div>'+
          '</div></div>'+
      '</div>'+
      /* Row 2: Item · Clear */
      '<div class="qv-row">'+
        '<div class="field" style="flex:1 1 280px;min-width:180px;"><label>Item</label>'+
          '<div class="picker" id="dqItemPicker">'+
            '<div class="picker-trigger" id="dqItemTrigger" tabindex="0">'+
              '<span class="picker-placeholder" id="dqItemPlaceholder">Select hosts first…</span>'+
              '<svg class="picker-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 9L12 15L18 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'+
            '</div>'+
            '<div class="picker-panel" id="dqItemPanel">'+
              '<input class="picker-search" id="dqItemSearch" placeholder="Filter by name or key…" autocomplete="off">'+
              '<div class="picker-list" id="dqItemList"></div>'+
            '</div>'+
          '</div></div>'+
        '<div class="field" style="flex:0 0 auto;"><label>&nbsp;</label>'+
          '<button type="button" class="btn btn-ghost" id="dqClearBtn" style="height:38px;" title="Clear host and item selection">Clear</button></div>'+
      '</div>'+
      /* Row 3: From · To · RANGE · HOURS · Compare · Show metrics */
      '<div class="qv-row qv-row-main">'+
        '<div class="field" style="flex:0 0 168px;"><label for="dqFrom">From ('+lab+')</label><input type="datetime-local" id="dqFrom" value="'+fromVal+'"></div>'+
        '<div class="field" style="flex:0 0 168px;"><label for="dqTo">To ('+lab+')</label><input type="datetime-local" id="dqTo" value="'+toVal+'"></div>'+
        datePresetBar('dqFrom','dqTo')+
        dayHoursPresetBar('dqDayFrom','dqDayTo','dqDay')+
        '<label class="dash-run-compare" style="align-self:end;padding-bottom:8px;">'+
          '<input type="checkbox" id="dqComparePrev"> Compare previous</label>'+
        '<div class="field" style="flex:0 0 auto;"><label>&nbsp;</label>'+
          '<button class="btn btn-primary" id="dqRunBtn" style="height:38px;"><span class="spinner"></span><span class="btn-label">Show metrics</span></button></div>'+
        '<span class="status-msg" id="dqStatus" style="align-self:end;padding-bottom:8px;"></span>'+
      '</div>'+
      '<div id="dqResults" style="margin-top:12px;"></div>'+
    '</div>'+
    '<div class="eyebrow" style="margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;">'+
      '<span>Saved dashboards</span>'+
      (canManage() ? '<button type="button" class="btn btn-ghost" id="dashImportBtn" style="height:26px;padding:0 10px;font-size:11px;">Import JSON</button>' : '')+
    '</div>'+
    recentStripHtml('dash', recents, existingIds)+
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
      '<div class="new-dash-card" id="newDashCard">'+
        '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 5V19M5 12H19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'+
        'New dashboard'+
      '</div>' : '')+
    '</div>';

  }catch(renderErr){
    console.error(renderErr);
    root.innerHTML = '<div class="placeholder" style="padding:40px;"><div class="ph-sub">UI render failed: '+String(renderErr.message||renderErr)+'</div></div>';
    return;
  }

  if(!dashState.quick) dashState.quick = { hostids: [], hostsWithItems: [], selectedItemQuery: '', selectedItemLabel: '' };

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
    root.querySelectorAll('[data-act="run"]').forEach(function(b){
      b.addEventListener('click', function(){
        pushRecent('dash', b.dataset.id, cardNameFor(b.dataset.id));
        openRun(b.dataset.id);
      });
    });
    root.querySelectorAll('[data-act="edit"]').forEach(function(b){
      b.addEventListener('click', async function(){
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
      b.addEventListener('click', async function(){
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
            throw new Error(err.detail || ('HTTP '+created.status));
          }
          showToast('Dashboard duplicated (as a private copy).', { type: 'success' });
          showDashboardList();
        }catch(err){ showToast('Duplicate failed: '+(err.message||err), { type: 'warn' }); }
      });
    });
    root.querySelectorAll('[data-act="export"]').forEach(function(b){
      b.addEventListener('click', async function(){
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
      b.addEventListener('click', async function(){
        const ok = await confirmModal('Delete this dashboard? This cannot be undone.', { title: 'Delete dashboard' });
        if(!ok) return;
        try{
          const res = await apiFetch('/api/dashboards/'+b.dataset.id, { method: 'DELETE' });
          if(!res.ok){
            const err = await res.json().catch(function(){ return {}; });
            throw new Error(err.detail || ('HTTP '+res.status));
          }
          showToast('Dashboard deleted.');
          showDashboardList();
        }catch(err){ showToast('Delete failed: '+(err.message||err), { type: 'warn' }); }
      });
    });
  }
  wireCardActions();

  root.querySelectorAll('[data-recent-id]').forEach(function(chip){
    chip.addEventListener('click', function(){
      pushRecent('dash', chip.dataset.recentId, cardNameFor(chip.dataset.recentId));
      openRun(chip.dataset.recentId);
    });
  });

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
    if(!q.selectedItems.length){
      placeholder.style.display = '';
      placeholder.textContent = q.hostids.length ? 'Search & select one or more items…' : 'Select hosts first…';
      return;
    }
    placeholder.style.display = 'none';
    q.selectedItems.forEach(function(it){
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.innerHTML = (it.label || it.query) +
        ' <button type="button" aria-label="Remove">'+
        '<svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M6 6L18 18M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg></button>';
      pill.querySelector('button').addEventListener('click', function(e){
        e.stopPropagation();
        q.selectedItems = q.selectedItems.filter(function(x){ return x.query !== it.query; });
        q.selectedItemQuery = q.selectedItems.length ? q.selectedItems[0].query : '';
        renderDqItemTrigger();
        renderDqItemOptions((document.getElementById('dqItemSearch')||{}).value||'');
      });
      trigger.insertBefore(pill, trigger.querySelector('.picker-chevron'));
    });
  }

  function renderDqHostOptions(filter){
    const list = document.getElementById('dqHostsList');
    if(!list) return;
    const f = (filter||'').trim().toLowerCase();
    const filtered = (dashState.allHosts||[]).filter(function(h){
      const label = (h.name||h.host||'');
      return !f || label.toLowerCase().includes(f) || (h.groups||'').toLowerCase().includes(f);
    });
    const selected = new Set((q.hostids||[]).map(function(id){ return parseInt(id,10); }));
    list.innerHTML = filtered.length ? filtered.map(function(h){
      const hid = parseInt(h.hostid,10);
      return '<label class="picker-option">'+
        '<input type="checkbox" value="'+hid+'" '+(selected.has(hid)?'checked':'')+'>'+
        '<div class="opt-main"><div class="opt-name">'+(h.name||h.host)+'</div>'+
        '<div class="opt-meta">'+(h.groups||'')+'</div></div></label>';
    }).join('') : '<div class="picker-empty">No hosts match.</div>';
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
    if(!trigger) return;
    trigger.querySelectorAll('.pill').forEach(function(p){ p.remove(); });
    if(!q.hostids.length){ placeholder.style.display=''; return; }
    placeholder.style.display='none';
    q.hostids.forEach(function(hostid){
      const hid = parseInt(hostid,10);
      const h = (dashState.allHosts||[]).find(function(x){ return parseInt(x.hostid,10)===hid; });
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.innerHTML = (h?(h.name||h.host):hid)+
        ' <button type="button"><svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M6 6L18 18M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg></button>';
      pill.querySelector('button').addEventListener('click', async function(e){
        e.stopPropagation();
        q.hostids = q.hostids.filter(function(id){ return parseInt(id,10)!==hid; });
        renderDqHostTrigger();
        renderDqHostOptions(document.getElementById('dqHostsSearch')?.value||'');
        q.hostsWithItems = q.hostids.length ? await fetchHostsItems(q.hostids) : [];
        q.selectedItemQuery = ''; q.selectedItemLabel = '';
        renderDqItemTrigger(); renderDqItemOptions('');
      });
      trigger.insertBefore(pill, trigger.querySelector('.picker-chevron'));
    });
  }

  renderDqHostOptions();
  renderDqHostTrigger();
  renderDqItemTrigger();
  renderDqItemOptions('');

  document.getElementById('dqHostsTrigger').addEventListener('click', function(){
    const panel = document.getElementById('dqHostsPanel');
    const open = !panel.classList.contains('open');
    panel.classList.toggle('open', open);
    document.getElementById('dqHostsTrigger').classList.toggle('open', open);
    if(open) document.getElementById('dqHostsSearch').focus();
  });
  document.getElementById('dqHostsSearch').addEventListener('input', function(e){ renderDqHostOptions(e.target.value); });
  document.getElementById('dqItemTrigger').addEventListener('click', async function(){
    const panel = document.getElementById('dqItemPanel');
    const open = !panel.classList.contains('open');
    panel.classList.toggle('open', open);
    document.getElementById('dqItemTrigger').classList.toggle('open', open);
    if(open){
      if(q.hostids.length && (!q.hostsWithItems || !q.hostsWithItems.length)){
        const list = document.getElementById('dqItemList');
        if(list) list.innerHTML = '<div class="picker-empty">Loading items…</div>';
        try{ q.hostsWithItems = await fetchHostsItems(q.hostids); }
        catch(err){ if(list) list.innerHTML = '<div class="picker-empty">Failed to load items</div>'; return; }
      }
      renderDqItemOptions((document.getElementById('dqItemSearch')||{}).value||'');
      const search = document.getElementById('dqItemSearch');
      if(search) search.focus();
    }
  });
  document.getElementById('dqItemSearch').addEventListener('input', function(e){ renderDqItemOptions(e.target.value); });

  document.getElementById('dqLoadGroupBtn').addEventListener('click', async function(){
    const gid = document.getElementById('dqGroup').value;
    const status = document.getElementById('dqStatus');
    if(!gid){ status.textContent='Pick a host group first.'; status.className='status-msg warn'; return; }
    status.textContent='Loading…'; status.className='status-msg';
    try{
      const res = await apiFetch('/api/hostgroups/'+gid+'/hosts');
      if(!res.ok) throw new Error('HTTP '+res.status);
      const hosts = await res.json();
      q.hostids = hosts.map(function(h){ return parseInt(h.hostid,10); });
      q.hostsWithItems = q.hostids.length ? await fetchHostsItems(q.hostids) : [];
      q.selectedItemQuery = ''; q.selectedItemLabel = '';
      renderDqHostOptions(); renderDqHostTrigger(); renderDqItemTrigger(); renderDqItemOptions('');
      status.textContent = 'Loaded '+q.hostids.length+' hosts.';
    }catch(err){
      status.textContent = 'Failed: '+(err.message||err);
      status.className='status-msg warn';
    }
  });

  const clearBtn = document.getElementById('dqClearBtn');
  if(clearBtn) clearBtn.addEventListener('click', function(){
    q.hostids = [];
    q.hostsWithItems = [];
    q.selectedItems = [];
    q.selectedItemQuery = '';
    q.selectedItemLabel = '';
    const groupEl = document.getElementById('dqGroup');
    if(groupEl) groupEl.value = '';
    const hostSearch = document.getElementById('dqHostsSearch');
    if(hostSearch) hostSearch.value = '';
    const itemSearch = document.getElementById('dqItemSearch');
    if(itemSearch) itemSearch.value = '';
    renderDqHostOptions('');
    renderDqHostTrigger();
    renderDqItemOptions('');
    renderDqItemTrigger();
    const results = document.getElementById('dqResults');
    if(results) results.innerHTML = '';
    const status = document.getElementById('dqStatus');
    if(status){ status.textContent = 'Selection cleared.'; status.className = 'status-msg'; }
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
          columns.push({
            id: 'col_q'+idx, label: it.label || it.query,
            aggregations: ['avg','min','max','last'],
            multiplier: 1, unit: '', decimals: 2, color_mode: 'none',
            thresholds: { mode: 'off', yellow: 75, red: 90 }, host_items: host_items,
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
        body: JSON.stringify(Object.assign({
          name: 'adhoc', hostids: q.hostids, columns: columns,
          date_from: dateFrom, date_to: dateTo,
        }, dayPayload)),
      });
      if(!res.ok){
        const err = await res.json().catch(function(){ return {}; });
        throw new Error(err.detail || ('HTTP '+res.status));
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
      results.innerHTML = computeInsightStrip({ columns: columns }, data) +
        (prevResult ? computeCompareStrip({ columns: columns }, data, prevResult) : '') +
        '<div class="table-tools">'+
          '<input type="search" id="dqTableSearch" placeholder="Filter rows…">'+
          '<span class="table-tools-spacer"></span>'+
          '<span class="table-tools-group">'+
            '<button type="button" class="chip-btn" id="dqExportBtn">Export CSV</button>'+
            '<button type="button" class="chip-btn" id="dqExportPdfBtn">Export PDF</button>'+
          '</span>'+
        '</div>'+
        renderPivot({ name: 'Quick view', columns: columns }, data, prevResult) +
        (auditLines.length ? '<div class="audit-box">'+auditLines.join('<br>')+'</div>' : '');
      const tbl = results.querySelector('table');
      makeTableSortable(tbl);
      wireTableSearch(document.getElementById('dqTableSearch'), tbl);
      wirePivotStickyHeaders(results);
      wirePivotDrilldown(results, dateFrom, dateTo, hours);
      const exportMeta = {
        title: 'Metrics quick view',
        dateFrom: dateFrom,
        dateTo: dateTo,
        day_time_from: hours.day_time_from,
        day_time_to: hours.day_time_to,
        comparePrev: comparePrev,
      };
      const ex = document.getElementById('dqExportBtn');
      if(ex) ex.addEventListener('click', function(){ exportVisibleTable(results, 'metrics-quick.csv', exportMeta); });
      const exPdf = document.getElementById('dqExportPdfBtn');
      if(exPdf) exPdf.addEventListener('click', function(){ exportVisibleTablePdf(results, 'metrics-quick.pdf', exportMeta); });
    }catch(err){
      status.textContent = '';
      status.className='status-msg';
      results.innerHTML = errorStateHtml({
        title: 'Could not load metrics',
        body: err.message || String(err),
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
        selectedGroupId: null,
        is_shared: !!existing.is_shared,
        shared_userids: existing.shared_userids || [],
        shared_usrgrpids: existing.shared_usrgrpids || [],
      }
    : { id: null, name: '', hostids: [], columns: [], selectedGroupId: null, is_shared: false, shared_userids: [], shared_usrgrpids: [] };
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
  const groupOpts = ['<option value="">— optional host group —</option>'].concat(
    (dashState.allGroups||[]).map(function(g){
      const sel = String(b.selectedGroupId||'')===String(g.groupid)?' selected':'';
      return '<option value="'+g.groupid+'"'+sel+'>'+g.name+' ('+(g.host_count||0)+')</option>';
    })
  ).join('');

  root.innerHTML =
    '<div class="filterbar">'+
      '<div class="builder-head">'+
        '<div class="field" style="flex:1.2"><label for="dashName">Name</label>'+
          '<input id="dashName" placeholder="e.g. Campus CPU & memory" value="'+String(b.name||'').replace(/"/g,'&quot;')+'"></div>'+
        '<div class="field" style="flex:0 0 auto"><label>&nbsp;</label>'+
          '<label style="display:flex;align-items:center;gap:6px;height:38px;font-size:12px;color:var(--text-dim);white-space:nowrap;">'+
            '<input type="checkbox" id="dashShared"'+(b.is_shared?' checked':'')+'> Shared with all users'+
          '</label></div>'+
        '</div>'+
        '<div class="field share-field">'+
          sharePickerHtml('dashShare', b.shared_userids || [], b.shared_usrgrpids || [])+
        '</div>'+
        '<div class="row">'+
        '<div class="field" style="flex:1"><label for="dashGroup">Host group</label><select id="dashGroup">'+groupOpts+'</select></div>'+
        '<div class="field" style="flex:0 0 auto"><label>&nbsp;</label>'+
          '<button type="button" class="btn btn-ghost" id="dashLoadGroupBtn" style="height:38px;">Load hosts from group</button></div>'+
        '<div class="field" style="flex:1.5"><label>Hosts</label>'+
          '<div class="picker" id="dashHostsPicker">'+
            '<div class="picker-trigger" id="dashHostsTrigger" tabindex="0">'+
              '<span class="picker-placeholder" id="dashHostsPlaceholder">Select hosts…</span>'+
              '<svg class="picker-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 9L12 15L18 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'+
            '</div>'+
            '<div class="picker-panel" id="dashHostsPanel">'+
              '<input class="picker-search" id="dashHostsSearch" placeholder="Filter hosts…" autocomplete="off">'+
              '<div class="picker-list" id="dashHostsList"></div>'+
            '</div>'+
          '</div></div>'+
      '</div>'+
      '<div class="eyebrow" style="margin:16px 0 8px;">Columns</div>'+
      '<div class="col-rows" id="colRows"></div>'+
      '<button type="button" class="add-col-btn" id="addColBtn">+ Add column</button>'+
      '<div class="eyebrow" style="margin:16px 0 8px;">Item mapping</div>'+
      '<div id="mapGrid"></div>'+
      '<div class="actions-row" style="margin-top:16px;">'+
        '<button class="btn btn-primary" id="saveDashBtn">Save dashboard</button>'+
        '<button class="btn btn-ghost" id="cancelDashBtn" type="button">Cancel</button>'+
        '<span class="status-msg" id="builderStatus"></span>'+
      '</div>'+
    '</div>';

  renderHostPickerOptions();
  renderHostPickerTrigger();
  renderColRows();
  renderMapGrid();

  document.getElementById('dashHostsTrigger').addEventListener('click', function(){
    const panel = document.getElementById('dashHostsPanel');
    const open = !panel.classList.contains('open');
    panel.classList.toggle('open', open);
    document.getElementById('dashHostsTrigger').classList.toggle('open', open);
    if(open) document.getElementById('dashHostsSearch').focus();
  });
  document.getElementById('dashHostsSearch').addEventListener('input', function(e){ renderHostPickerOptions(e.target.value); });
  document.getElementById('dashLoadGroupBtn').addEventListener('click', async function(){
    const gid = document.getElementById('dashGroup').value;
    const status = document.getElementById('builderStatus');
    if(!gid){ status.textContent='Pick a group.'; status.className='status-msg warn'; return; }
    status.textContent='Loading hosts…';
    try{
      const res = await apiFetch('/api/hostgroups/'+gid+'/hosts');
      if(!res.ok) throw new Error('HTTP '+res.status);
      const hosts = await res.json();
      b.selectedGroupId = parseInt(gid,10);
      b.hostids = hosts.map(function(h){ return parseInt(h.hostid,10); });
      dashState.builderHosts = await fetchHostsItems(b.hostids);
      renderHostPickerOptions(); renderHostPickerTrigger(); renderMapGrid();
      status.textContent = 'Loaded '+b.hostids.length+' hosts.';
    }catch(err){
      status.textContent = 'Failed: '+(err.message||err);
      status.className='status-msg warn';
    }
  });
  document.getElementById('addColBtn').addEventListener('click', function(){
    b.columns.push(newColumn());
    renderColRows();
    renderMapGrid();
  });
  document.getElementById('saveDashBtn').addEventListener('click', saveDashboard);
  document.getElementById('cancelDashBtn').addEventListener('click', showDashboardList);
  wireShareRetry('dashShare', renderBuilder);
  wireSharePicker('dashShare');
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
  if(!ids.length){ placeholder.style.display=''; return; }
  placeholder.style.display='none';
  ids.forEach(function(hostid){
    const hid = parseInt(hostid,10);
    const h = (dashState.allHosts||[]).find(function(x){ return parseInt(x.hostid,10)===hid; });
    const pill = document.createElement('span');
    pill.className = 'pill';
    pill.innerHTML = (h?(h.name||h.host):hid)+
      ' <button type="button"><svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M6 6L18 18M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg></button>';
    pill.querySelector('button').addEventListener('click', async function(e){
      e.stopPropagation();
      dashState.builder.hostids = dashState.builder.hostids.filter(function(id){ return parseInt(id,10)!==hid; });
      renderHostPickerTrigger();
      renderHostPickerOptions(document.getElementById('dashHostsSearch')?.value||'');
      dashState.builderHosts = dashState.builder.hostids.length ? await fetchHostsItems(dashState.builder.hostids) : [];
      renderMapGrid();
    });
    trigger.insertBefore(pill, trigger.querySelector('.picker-chevron'));
  });
}

function renderColRows(){
  const b = dashState.builder;
  const wrap = document.getElementById('colRows');
  if(!wrap) return;
  if(!b.columns.length){
    wrap.innerHTML = '<div class="picker-empty">No columns yet — add a metric column.</div>';
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
  (dashState.builderHosts||[]).forEach(function(h){
    const match = matchItemOnHost(h, query);
    if(match){
      if(!col.host_items) col.host_items = {};
      col.host_items[String(h.hostid)] = parseInt(match.itemid,10);
      mapped++;
    } else if(col.host_items){
      delete col.host_items[String(h.hostid)];
    }
  });
  renderMapGrid();
  const status = document.getElementById('builderStatus');
  if(status) status.textContent = 'Mapped "'+query+'" on '+mapped+' host(s).';
}

async function saveDashboard(){
  const b = dashState.builder;
  b.name = document.getElementById('dashName').value.trim();
  const sharedEl = document.getElementById('dashShared');
  b.is_shared = sharedEl ? !!sharedEl.checked : !!b.is_shared;
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
      throw new Error(err.detail || 'Save failed');
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
  const lab = tzLabel();
  dashRoot().innerHTML =
    '<div class="filterbar dash-run-bar">'+
      /* Row 1: title + date range */
      '<div class="dash-run-row">'+
        '<div class="dash-run-title"><div class="eyebrow" style="margin-bottom:2px;">Dashboard</div>'+
          '<h3 style="margin:0;font-size:15px;line-height:1.25;">'+escHtml(dashboard.name)+shareBadgeHtml(dashboard)+'</h3></div>'+
        '<div class="field dash-run-date"><label for="dashFrom">From ('+lab+')</label>'+
          '<input type="datetime-local" id="dashFrom" value="'+fromVal+'"></div>'+
        '<div class="field dash-run-date"><label for="dashTo">To ('+lab+')</label>'+
          '<input type="datetime-local" id="dashTo" value="'+toVal+'"></div>'+
        datePresetBar('dashFrom','dashTo')+
      '</div>'+
      /* Row 2: hours + actions */
      '<div class="dash-run-row dash-run-row-actions">'+
        dayHoursPresetBar('dashDayFrom','dashDayTo','dashDay')+
        '<div class="dash-run-actions">'+
          '<button class="btn btn-primary" id="runDashBtn"><span class="spinner"></span><span class="btn-label">Run</span></button>'+
          '<button class="btn btn-ghost" id="backToListBtn" type="button">← All dashboards</button>'+
          '<label class="dash-run-compare"><input type="checkbox" id="dashComparePrev"> Compare previous</label>'+
          '<span class="status-msg" id="dashRunStatus"></span>'+
        '</div>'+
      '</div>'+
    '</div>'+
    '<div id="pivotWrap" style="margin-top:20px;"></div>';
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
      throw new Error(err.detail || ('HTTP '+res.status));
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
      pivotWrap.innerHTML = computeInsightStrip(dashboard, result) +
        (prevResult ? computeCompareStrip(dashboard, result, prevResult) : '') +
        '<div class="table-tools">'+
          '<input type="search" id="dashTableSearch" placeholder="Filter rows…">'+
          '<span class="table-tools-spacer"></span>'+
          '<label class="table-tools-refresh"><span>Refresh</span> '+
            '<select id="dashRefreshSel"><option value="0">Off</option><option value="30">30s</option><option value="60">1m</option><option value="300">5m</option></select></label>'+
          '<span class="table-tools-group">'+
            '<button type="button" class="chip-btn" id="dashExportBtn">Export CSV</button>'+
            '<button type="button" class="chip-btn" id="dashExportPdfBtn">Export PDF</button>'+
          '</span>'+
          '<button type="button" class="chip-btn" id="dashShareBtn">Copy link</button>'+
        '</div>'+
        renderPivot(dashboard, result, prevResult) +
        (audit ? '<div class="audit-box">'+audit+'</div>' : '') +
        (comparePrev && !prevResult ? '<div class="audit-box" style="border-color:var(--danger);">Could not load the previous period for comparison.</div>' : '');
      const tbl = pivotWrap.querySelector('table');
      makeTableSortable(tbl);
      wireTableSearch(document.getElementById('dashTableSearch'), tbl);
      wirePivotStickyHeaders(pivotWrap);
      wirePivotDrilldown(pivotWrap, dateFrom, dateTo, hours);
      const exportMeta = {
        title: dashboard.name || 'Dashboard',
        dateFrom: dateFrom,
        dateTo: dateTo,
        day_time_from: hours.day_time_from,
        day_time_to: hours.day_time_to,
        comparePrev: comparePrev,
      };
      document.getElementById('dashExportBtn').addEventListener('click', function(){ exportVisibleTable(pivotWrap, 'dashboard.csv', exportMeta); });
      document.getElementById('dashExportPdfBtn').addEventListener('click', function(){
        exportVisibleTablePdf(pivotWrap, 'dashboard.pdf', exportMeta);
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

function renderPivot(dashboard, result, prevResult){
  const columns = dashboard.columns || [];
  const prevByHost = {};
  if(prevResult && prevResult.rows){
    prevResult.rows.forEach(function(r){ prevByHost[String(r.hostid)] = r.cells; });
  }
  // data-sort-col maps header cells to tbody column index (Host=0, then each aggregation leaf)
  let sortCol = 1;
  const headerRow1 = ['<th rowspan="2" data-sort-col="0" class="sortable">Host</th>'].concat(
    columns.map(function(c){
      return '<th colspan="'+(c.aggregations||[]).length+'" class="sort-group">'+escHtml(c.label)+'</th>';
    })
  ).join('');
  const headerRow2 = columns.reduce(function(acc,c){
    return acc.concat((c.aggregations||[]).map(function(a){
      const html = '<th data-sort-col="'+sortCol+'" class="sortable">'+escHtml(a)+'</th>';
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
          return '<td class="metric-empty">—</td>';
        }
        const v = cell.values[agg];
        const num = typeof v === 'number' ? v : null;
        const display = num != null ? v.toFixed(col.decimals != null ? col.decimals : 2) : v;
        const unit = cell.units || col.unit || '';
        const cls = metricClass(num, col);
        let deltaHtml = '';
        let prevHtml = '';
        // Previous-period comparison for every aggregation (avg, min, max, last)
        if(num != null && prevByHost[String(row.hostid)]){
          const prevCell = prevByHost[String(row.hostid)][col.id];
          if(prevCell && typeof prevCell.values[agg] === 'number'){
            const pv = prevCell.values[agg];
            // high_good / good_high: higher is better → green on up
            // high_bad / bad_high / default: lower is better → green on down
            const thMode = col.thresholds && col.thresholds.mode;
            const mode = (thMode && thMode !== 'off')
              ? thMode
              : (col.color_mode === 'good_high' ? 'high_good' : 'high_bad');
            const goodWhenDown = mode === 'high_bad' || mode === 'bad_high';
            deltaHtml = deltaBadgeHtml(v, pv, goodWhenDown);
            prevHtml = '<div class="metric-prev">prev '+pv.toFixed(col.decimals != null ? col.decimals : 2)+(unit?' '+unit:'')+'</div>';
          }
        }
        const clickable = itemid ? ' pivot-clickable' : '';
        const mult = col.multiplier != null ? col.multiplier : 1;
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
        const exportText = num != null ? (exportNum + (unit ? ' ' + unit : '')) : String(v);
        const exportTone = cls === 'metric-bad' ? 'bad' : (cls === 'metric-warn' ? 'warn' : (cls === 'metric-good' ? 'good' : ''));
        const exportAttrs = (exportNum !== '' ? ' data-export-num="'+exportNum+'"' : '') +
          ' data-export-text="'+escHtml(exportText)+'"' +
          (exportTone ? ' data-export-tone="'+exportTone+'"' : '');
        const dataAttrs = (itemid
          ? ' data-itemid="'+itemid+'" data-host="'+escHtml(row.host)+'" data-col="'+escHtml(col.label)+'" data-unit="'+escHtml(unit)+'"'+
            ' data-mult="'+mult+'" data-th-mode="'+thMode+'" data-th-yellow="'+thYellow+'" data-th-red="'+thRed+'"'
          : '') + exportAttrs;
        const spark = showGraph
          ? '<div class="metric-spark" data-itemid="'+itemid+'" data-mult="'+mult+'"'+
            ' data-th-mode="'+thMode+'"'+
            ' data-th-yellow="'+thYellow+'"'+
            ' data-th-red="'+thRed+'"'+
            ' title="Period trend (avg)"></div>'
          : '';
        let inner = '';
        if(!isAvg){
          // min / max / last — always number only
          inner = display+(unit?' '+unit:'')+deltaHtml+prevHtml;
        } else if(disp === 'bar' && num != null){
          inner = metricBarHtml(num, col) + deltaHtml + prevHtml;
        } else if(disp === 'number_bar' && num != null){
          inner = '<div class="metric-num">'+display+(unit?' '+unit:'')+deltaHtml+'</div>'+metricBarHtml(num, col)+prevHtml;
        } else if(disp === 'graph' && showGraph){
          inner = '<div class="metric-with-spark metric-spark-only">'+spark+deltaHtml+'</div>'+prevHtml;
        } else if(disp === 'number_graph' && showGraph){
          inner = '<div class="metric-with-spark">'+
            '<div class="metric-num">'+display+(unit?' '+unit:'')+deltaHtml+'</div>'+
            spark+
            '</div>'+prevHtml;
        } else {
          inner = display+(unit?' '+unit:'')+deltaHtml+prevHtml;
        }
        return '<td class="'+cls+clickable+'"'+dataAttrs+'>'+inner+'</td>';
      });
      return acc.concat(tds);
    }, []).join('');
    return '<tr><td class="host-cell">'+escHtml(row.host)+'</td>'+cells+'</tr>';
  }).join('');
  return '<div class="pivot-wrap"><table class="pivot"><thead><tr>'+headerRow1+'</tr><tr>'+headerRow2+'</tr></thead><tbody>'+bodyRows+'</tbody></table></div>';
}

function computeInsightStrip(dashboard, result){
  const columns = dashboard.columns || [];
  const hasThresholds = columns.some(function(c){
    return (c.thresholds && c.thresholds.mode && c.thresholds.mode !== 'off') || (c.color_mode && c.color_mode !== 'none');
  });
  if(!hasThresholds) return '';
  let bad = 0, warn = 0, ok = 0;
  (result.rows||[]).forEach(function(row){
    columns.forEach(function(col){
      const cell = row.cells[col.id];
      if(!cell) return;
      const primaryAgg = (col.aggregations||[])[0];
      if(!primaryAgg) return;
      const v = cell.values[primaryAgg];
      if(typeof v !== 'number') return;
      const cls = metricClass(v, col);
      if(cls === 'metric-bad') bad++;
      else if(cls === 'metric-warn') warn++;
      else if(cls === 'metric-good') ok++;
    });
  });
  if(!bad && !warn && !ok) return '';
  let html = '<div class="insight-strip">';
  if(bad) html += '<span class="insight-chip bad"><b>'+bad+'</b> critical</span>';
  if(warn) html += '<span class="insight-chip warn"><b>'+warn+'</b> warning</span>';
  html += '<span class="insight-chip ok"><b>'+ok+'</b> healthy</span>';
  html += '</div>';
  return html;
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

/** Measure first thead row so the second sticky header row sits flush under it. */
function wirePivotStickyHeaders(container){
  if(!container) return;
  const wrap = container.classList && container.classList.contains('pivot-wrap')
    ? container
    : container.querySelector('.pivot-wrap');
  if(!wrap) return;
  const first = wrap.querySelector('table.pivot thead tr:first-child');
  if(!first) return;
  const apply = function(){
    const h = Math.ceil(first.getBoundingClientRect().height);
    if(h > 0) wrap.style.setProperty('--pivot-head-h', h + 'px');
  };
  apply();
  // Re-measure after fonts/layout settle
  requestAnimationFrame(apply);
  if(typeof ResizeObserver !== 'undefined'){
    if(wrap._pivotHeadRO) try{ wrap._pivotHeadRO.disconnect(); }catch(_){}
    wrap._pivotHeadRO = new ResizeObserver(apply);
    wrap._pivotHeadRO.observe(first);
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
  Object.keys(byId).forEach(function(idStr){
    const series = seriesByItem[idStr];
    byId[idStr].forEach(function(el){
      if(!series || !(series.points||[]).length){
        el.innerHTML = '';
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
      // Dynamic width: fill remaining space beside the number
      const only = el.closest('.metric-spark-only');
      const thOpts = {
        mode: el.dataset.thMode || 'off',
        yellow: parseFloat(el.dataset.thYellow),
        red: parseFloat(el.dataset.thRed),
      };
      el.innerHTML = sparklineSvg(values, only ? 100 : 80, 22, thOpts);
    });
  });
}




