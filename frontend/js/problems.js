/**
 * problems.js — Problems tab: live problems, saved problem dashboards, diagnostics
 * Loaded as classic script (global scope). Order matters — see index.html.
 */


function formatAge(seconds){
  if(seconds == null) return '—';
  const s = Math.max(0, parseInt(seconds, 10));
  if(s < 60) return s + 's';
  if(s < 3600) return Math.floor(s/60) + 'm';
  if(s < 86400) return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm';
  return Math.floor(s/86400) + 'd ' + Math.floor((s%86400)/3600) + 'h';
}


function problemStatusOptions(selected){
  selected = selected || 'open';
  const opts = [
    ['open', 'Open'],
    ['open_unack', 'Open · Unacknowledged'],
    ['open_ack', 'Open · Acknowledged'],
    ['closed', 'Closed'],
    ['all', 'All (open + closed)'],
  ];
  return opts.map(function(p){
    return '<option value="'+p[0]+'"'+(selected===p[0]?' selected':'')+'>'+p[1]+'</option>';
  }).join('');
}

async function ensureProbData(){
  if(probState.dataReady && (probState.hosts||[]).length) return;
  // Prefer shared caches when Metrics already loaded them
  try{
    if(!(dashState.allHosts&&dashState.allHosts.length)) await ensureAllHosts();
    if(!(dashState.allGroups&&dashState.allGroups.length)) await ensureAllGroups();
  }catch(e){ console.warn(e); }
  if(dashState.allHosts && dashState.allHosts.length){
    probState.hosts = dashState.allHosts;
  } else {
    const hRes = await apiFetch('/api/hosts');
    if(!hRes.ok) throw new Error('Failed to load hosts ('+hRes.status+')');
    probState.hosts = await hRes.json();
    dashState.allHosts = probState.hosts;
  }
  if(dashState.allGroups && dashState.allGroups.length){
    probState.groups = dashState.allGroups;
  } else {
    const gRes = await apiFetch('/api/hostgroups');
    if(!gRes.ok) throw new Error('Failed to load host groups ('+gRes.status+')');
    probState.groups = await gRes.json();
    dashState.allGroups = probState.groups;
  }
  probState.dataReady = true;
}

async function showProblemsView(){
  const root = probRoot();
  if(!root){
    console.error('problemsView missing');
    return;
  }
  root.innerHTML = loadingStateHtml('Loading problem views…');
  try{
    if(typeof probState === 'undefined'){
      throw new Error('probState not initialized');
    }
    await ensureProbData();
    await showProblemDashList();
  }catch(err){
    console.error(err);
    root.innerHTML = '<div class="placeholder" style="padding:40px;"><div class="ph-sub">'+String(err.message||err)+'</div></div>';
  }
}

async function showProblemDashList(){
  probState.view = 'list';
  const root = probRoot();
  root.innerHTML = loadingStateHtml('Loading…');
  const res = await apiFetch('/api/problem-dashboards');
  if(!res.ok){
    root.innerHTML = '<div class="placeholder" style="padding:40px;"><div class="ph-sub">Failed to list problem dashboards ('+res.status+')</div></div>';
    return;
  }
  const list = await res.json();
  await loadPins();
  const existingIds = new Set(list.map(function(d){ return d.id; }));
  const recents = getRecents('pdash');

  function renderCards(items){
    return items.map(function(d){
      const nHosts = (d.hostids||[]).length;
      const g = d.groupid ? (probState.groups.find(function(x){ return String(x.groupid)===String(d.groupid); })||{}).name : null;
      const owner = d.mine ? 'You' : ('By '+escHtml(d.owner_username||'unknown'));
      const shareBadge = shareBadgeHtml(d);
      const pinned = isPinned('problem_dashboard', d.id);
      const meta = owner+' · '+(g ? escHtml(g)+' · ' : '') + nHosts + ' host'+(nHosts===1?'':'s')+
        ' · '+(d.status||'open')+' · min sev '+(d.min_severity||0)+
        ' · updated '+new Date(d.updated_at*1000).toLocaleDateString();
      const editBtns = d.can_edit
        ? '<button data-act="edit" data-id="'+d.id+'">Edit</button>'+
          '<button data-act="delete" data-id="'+d.id+'" class="danger">Delete</button>'
        : '';
      const dupBtn = canManage() ? '<button data-act="dup" data-id="'+d.id+'">Duplicate</button>' : '';
      return '<div class="dash-card">'+
        '<div class="dash-card-top"><h4>'+escHtml(d.name)+shareBadge+'</h4>'+
          '<button type="button" class="pin-btn'+(pinned?' pinned':'')+'" data-act="pin" data-id="'+d.id+'" title="'+(pinned?'Unpin':'Pin to top')+'">★</button>'+
        '</div>'+
        '<div class="dash-meta">'+meta+'</div>'+
        '<div class="dash-actions">'+
          '<button data-act="run" data-id="'+d.id+'">Run</button>'+
          '<button data-act="export" data-id="'+d.id+'">Export</button>'+
          dupBtn+editBtns+
        '</div></div>';
    }).join('');
  }

  function sortList(items){
    const sorted = items.slice();
    const sortSel = document.getElementById('pdashSort');
    if(sortSel && sortSel.value === 'name'){
      sorted.sort(function(a,b){ return (a.name||'').localeCompare(b.name||''); });
    } else {
      sorted.sort(function(a,b){
        const pa = isPinned('problem_dashboard', a.id) ? 1 : 0, pb = isPinned('problem_dashboard', b.id) ? 1 : 0;
        return (pb - pa) || ((b.updated_at||0) - (a.updated_at||0));
      });
    }
    return sorted;
  }

  const cards = renderCards(sortList(list));

  const groupOpts = ['<option value="">— optional host group —</option>'].concat(
    (probState.groups||[]).map(function(g){
      return '<option value="'+g.groupid+'">'+g.name+' ('+g.host_count+')</option>';
    })
  ).join('');
  const sevOpts = [
    [0,'All severities'],[1,'Info+'],[2,'Warning+'],[3,'Average+'],[4,'High+'],[5,'Disaster only']
  ].map(function(p){ return '<option value="'+p[0]+'">'+p[1]+'</option>'; }).join('');

  root.innerHTML =
    '<p class="page-intro">See current open problems for a host or group, or save a scope as a dashboard for one-click refresh.</p>'+
    // ---- Instant viewer (no save) ----
    '<div class="filterbar qv-bar" style="margin-bottom:18px;">'+
      '<div class="eyebrow" style="margin-bottom:8px;">Quick view</div>'+
      /* Row 1: Host group · Load · Min sev · Status  |  Show problems · Clear (right) */
      '<div class="qv-row qv-row-actions">'+
        '<div class="field" style="flex:0 1 280px;min-width:200px;"><label for="qvGroup">Host group</label>'+
          '<select id="qvGroup">'+groupOpts+'</select></div>'+
        '<div class="field" style="flex:0 0 auto;"><label>&nbsp;</label>'+
          '<button type="button" class="btn btn-ghost" id="qvLoadGroupBtn" style="height:38px;white-space:nowrap;">Load hosts</button></div>'+
        '<div class="field" style="flex:0 0 150px;"><label for="qvSev">Min severity</label>'+
          '<select id="qvSev">'+sevOpts+'</select></div>'+
        '<div class="field" style="flex:0 0 130px;"><label for="qvProbStatus">Status</label>'+
          '<select id="qvProbStatus">'+problemStatusOptions((probState.quick&&probState.quick.status)||'open')+'</select></div>'+
        '<div class="qv-row-end">'+
          '<button class="btn btn-primary" id="qvRunBtn" style="height:38px;"><span class="spinner"></span><span class="btn-label">Show problems</span></button>'+
          '<button type="button" class="btn btn-ghost" id="qvClearBtn" style="height:38px;" title="Clear host and group selection">Clear</button>'+
          '<span class="status-msg" id="qvStatus"></span>'+
          '<span class="prob-count" id="qvCount"></span>'+
        '</div>'+
      '</div>'+
      /* Row 2: Hosts full width */
      '<div class="qv-row">'+
        '<div class="field" style="flex:1 1 100%;min-width:200px;"><label for="qvHostsTrigger">Hosts</label>'+
          '<div class="picker" id="qvHostsPicker">'+
            '<div class="picker-trigger" id="qvHostsTrigger" tabindex="0">'+
              '<span class="picker-placeholder" id="qvHostsPlaceholder">Select hosts…</span>'+
              '<svg class="picker-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 9L12 15L18 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'+
            '</div>'+
            '<div class="picker-panel" id="qvHostsPanel">'+
              '<input class="picker-search" id="qvHostsSearch" placeholder="Filter hosts…" autocomplete="off">'+
              '<div class="picker-list" id="qvHostsList"></div>'+
            '</div>'+
          '</div></div>'+
      '</div>'+
      '<div id="qvResults" style="margin-top:12px;"></div>'+
    '</div>'+
    // ---- Saved dashboards ----
    '<div class="eyebrow" style="margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;">'+
      '<span>Saved dashboards</span>'+
      (canManage() ? '<button type="button" class="btn btn-ghost" id="pdashImportBtn" style="height:26px;padding:0 10px;font-size:11px;">Import JSON</button>' : '')+
    '</div>'+
    recentStripHtml('pdash', recents, existingIds)+
    (list.length > 1 ? '<div class="list-toolbar">'+
      '<input type="search" id="pdashSearch" placeholder="Filter saved views by name…">'+
      '<select id="pdashSort">'+
        '<option value="updated">Sort: Recently updated</option>'+
        '<option value="name">Sort: Name (A–Z)</option>'+
      '</select>'+
    '</div>' : '')+
    (list.length === 0
      ? emptyStateHtml({
          icon: '!',
          title: 'No problem views saved yet',
          body: canManage()
            ? 'Save a host/group scope for one-click problem refresh, or use Quick view above.'
            : 'No problem views have been shared with you yet. Use Quick view above anytime.',
          actionsHtml: canManage()
            ? '<div class="es-actions"><button type="button" class="btn btn-primary" id="emptyNewProbBtn">New problem view</button></div>'
            : '',
        })
      : '')+
    '<div class="dash-list" id="pdashListGrid">'+cards+
      (canManage() && list.length > 0 ?
      '<div class="new-dash-card" id="newProbDashCard">'+
        '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 5V19M5 12H19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'+
        'New dashboard'+
      '</div>' : '')+
    '</div>';

  // Quick-view state — restore last filters from localStorage when available
  if(!probState.quick){
    let saved = null;
    try{ saved = JSON.parse(localStorage.getItem('zr_qv_problems') || 'null'); }catch(e){ saved = null; }
    probState.quick = {
      hostids: (saved && Array.isArray(saved.hostids)) ? saved.hostids.map(function(id){ return parseInt(id,10); }) : [],
      groupid: (saved && saved.groupid) ? parseInt(saved.groupid, 10) : null,
      min_severity: (saved && saved.min_severity != null) ? parseInt(saved.min_severity, 10) : 0,
      status: (saved && saved.status) || 'open',
      severities: (saved && Array.isArray(saved.severities)) ? saved.severities : null,
      include_suppressed: saved ? (saved.include_suppressed !== false) : true,
    };
  }

  const newProbDashCard = document.getElementById('newProbDashCard');
  if(newProbDashCard) newProbDashCard.addEventListener('click', function(){ openProblemBuilder(null); });
  const emptyNewProbBtn = document.getElementById('emptyNewProbBtn');
  if(emptyNewProbBtn) emptyNewProbBtn.addEventListener('click', function(){ openProblemBuilder(null); });

  const importBtn = document.getElementById('pdashImportBtn');
  if(importBtn) importBtn.addEventListener('click', function(){
    const input = document.getElementById('importFileInput');
    input.onchange = async function(){
      const file = input.files[0];
      input.value = '';
      if(!file) return;
      try{
        const text = await file.text();
        const obj = JSON.parse(text);
        if(!obj || !Array.isArray(obj.hostids)){
          throw new Error('Not a recognized problem-view export');
        }
        openProblemBuilder({
          name: (obj.name||'Imported view')+' (imported)', hostids: obj.hostids,
          groupid: obj.groupid||null, min_severity: obj.min_severity||0,
          status: obj.status||'open', is_shared: false, shared_userids: [], shared_usrgrpids: [],
        });
        showToast('Imported — review and save to keep it.', { type: 'success' });
      }catch(err){
        showToast('Import failed: '+(err.message||err), { type: 'warn' });
      }
    };
    input.click();
  });

  function cardNameFor(id){
    const d = list.find(function(x){ return x.id === id; });
    return d ? d.name : '';
  }
  function wireCardActions(){
    root.querySelectorAll('[data-act="run"]').forEach(function(b){
      b.addEventListener('click', function(){
        pushRecent('pdash', b.dataset.id, cardNameFor(b.dataset.id));
        openProblemRun(b.dataset.id);
      });
    });
    root.querySelectorAll('[data-act="edit"]').forEach(function(b){
      b.addEventListener('click', async function(){
        const res = await apiFetch('/api/problem-dashboards/'+b.dataset.id);
        if(!res.ok){ showToast('Failed to load problem dashboard.', { type: 'warn' }); return; }
        const d = await res.json();
        pushRecent('pdash', d.id, d.name);
        openProblemBuilder(d);
      });
    });
    root.querySelectorAll('[data-act="dup"]').forEach(function(b){
      b.addEventListener('click', async function(){
        try{
          const res = await apiFetch('/api/problem-dashboards/'+b.dataset.id);
          if(!res.ok) throw new Error('HTTP '+res.status);
          const d = await res.json();
          const created = await apiFetch('/api/problem-dashboards', {
            method: 'POST',
            body: JSON.stringify({
              name: (d.name||'Untitled')+' (copy)', hostids: d.hostids, groupid: d.groupid,
              min_severity: d.min_severity, status: d.status,
              is_shared: false, shared_userids: [], shared_usrgrpids: [],
            }),
          });
          if(!created.ok){
            const err = await created.json().catch(function(){ return {}; });
            throw new Error(err.detail || ('HTTP '+created.status));
          }
          showToast('Problem dashboard duplicated (as a private copy).', { type: 'success' });
          showProblemDashList();
        }catch(err){ showToast('Duplicate failed: '+(err.message||err), { type: 'warn' }); }
      });
    });
    root.querySelectorAll('[data-act="export"]').forEach(function(b){
      b.addEventListener('click', async function(){
        try{
          const res = await apiFetch('/api/problem-dashboards/'+b.dataset.id);
          if(!res.ok) throw new Error('HTTP '+res.status);
          const d = await res.json();
          downloadText(
            (d.name||'problem-view').replace(/[^a-z0-9]+/gi,'_')+'.json',
            JSON.stringify({ name: d.name, hostids: d.hostids, groupid: d.groupid, min_severity: d.min_severity, status: d.status }, null, 2),
            'application/json'
          );
        }catch(err){ showToast('Export failed: '+(err.message||err), { type: 'warn' }); }
      });
    });
    root.querySelectorAll('[data-act="pin"]').forEach(function(b){
      b.addEventListener('click', function(e){
        e.stopPropagation();
        togglePin('problem_dashboard', b.dataset.id, b.classList.contains('pinned'), function(){ showProblemDashList(); });
      });
    });
    root.querySelectorAll('[data-act="delete"]').forEach(function(b){
      b.addEventListener('click', async function(){
        const ok = await confirmModal('Delete this problem dashboard? This cannot be undone.', { title: 'Delete problem dashboard' });
        if(!ok) return;
        try{
          const res = await apiFetch('/api/problem-dashboards/'+b.dataset.id, { method:'DELETE' });
          if(!res.ok){
            const err = await res.json().catch(function(){ return {}; });
            throw new Error(err.detail || ('HTTP '+res.status));
          }
          showToast('Problem dashboard deleted.');
          showProblemDashList();
        }catch(err){ showToast('Delete failed: '+(err.message||err), { type: 'warn' }); }
      });
    });
  }
  wireCardActions();

  root.querySelectorAll('[data-recent-id]').forEach(function(chip){
    chip.addEventListener('click', function(){
      pushRecent('pdash', chip.dataset.recentId, cardNameFor(chip.dataset.recentId));
      openProblemRun(chip.dataset.recentId);
    });
  });

  const searchInput = document.getElementById('pdashSearch');
  const sortSelect = document.getElementById('pdashSort');
  function applyFilter(){
    if(!searchInput) return;
    const f = searchInput.value.trim().toLowerCase();
    const filtered = !f ? list.slice() : list.filter(function(d){ return (d.name||'').toLowerCase().includes(f); });
    const grid = document.getElementById('pdashListGrid');
    const newCard = document.getElementById('newProbDashCard');
    grid.innerHTML = renderCards(sortList(filtered));
    if(newCard) grid.appendChild(newCard);
    wireCardActions();
  }
  if(searchInput) searchInput.addEventListener('input', applyFilter);
  if(sortSelect) sortSelect.addEventListener('change', applyFilter);

  wireQuickView();
}

function wireQuickView(){
  const q = probState.quick;
  // Apply restored filters to form controls
  try{
    if(q.groupid){
      const gEl = document.getElementById('qvGroup');
      if(gEl) gEl.value = String(q.groupid);
    }
    const sevEl = document.getElementById('qvSev');
    if(sevEl && q.min_severity != null) sevEl.value = String(q.min_severity);
    const stEl = document.getElementById('qvProbStatus');
    if(stEl && q.status) stEl.value = q.status;
  }catch(e){ /* ignore */ }

  function renderQvHostOptions(filter){
    const list = document.getElementById('qvHostsList');
    if(!list) return;
    const f = (filter || '').trim().toLowerCase();
    const filtered = (probState.hosts||[]).filter(function(h){
      const label = (h.name || h.host || '');
      return !f || label.toLowerCase().includes(f) || (h.groups||'').toLowerCase().includes(f);
    });
    const selected = new Set((q.hostids||[]).map(function(id){ return parseInt(id,10); }));
    list.innerHTML = filtered.length ? filtered.map(function(h){
      const hid = parseInt(h.hostid, 10);
      return '<label class="picker-option">'+
        '<input type="checkbox" value="'+hid+'" '+(selected.has(hid)?'checked':'')+'>'+
        '<div class="opt-main"><div class="opt-name">'+(h.name||h.host)+'</div>'+
        '<div class="opt-meta">'+(h.groups||'')+'</div></div></label>';
    }).join('') : '<div class="picker-empty">No hosts match.</div>';
    list.querySelectorAll('input[type=checkbox]').forEach(function(cb){
      cb.addEventListener('change', function(){
        const hid = parseInt(cb.value, 10);
        if(cb.checked){
          if(!q.hostids.includes(hid)) q.hostids.push(hid);
        } else {
          q.hostids = q.hostids.filter(function(id){ return parseInt(id,10) !== hid; });
        }
        renderQvHostTrigger();
      });
    });
  }

  function renderQvHostTrigger(){
    const trigger = document.getElementById('qvHostsTrigger');
    const placeholder = document.getElementById('qvHostsPlaceholder');
    if(!trigger) return;
    trigger.querySelectorAll('.pill').forEach(function(p){ p.remove(); });
    if(!q.hostids.length){ placeholder.style.display = ''; return; }
    placeholder.style.display = 'none';
    q.hostids.forEach(function(hostid){
      const hid = parseInt(hostid, 10);
      const h = (probState.hosts||[]).find(function(x){ return parseInt(x.hostid,10)===hid; });
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.innerHTML = (h ? (h.name||h.host) : hid)+
        ' <button type="button" aria-label="Remove">'+
        '<svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M6 6L18 18M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg></button>';
      pill.querySelector('button').addEventListener('click', function(e){
        e.stopPropagation();
        q.hostids = q.hostids.filter(function(id){ return parseInt(id,10)!==hid; });
        renderQvHostTrigger();
        renderQvHostOptions(document.getElementById('qvHostsSearch')?.value || '');
      });
      trigger.insertBefore(pill, trigger.querySelector('.picker-chevron'));
    });
  }

  renderQvHostOptions();
  renderQvHostTrigger();

  document.getElementById('qvHostsTrigger').addEventListener('click', function(){
    const panel = document.getElementById('qvHostsPanel');
    const trigger = document.getElementById('qvHostsTrigger');
    const open = !panel.classList.contains('open');
    panel.classList.toggle('open', open);
    trigger.classList.toggle('open', open);
    if(open) document.getElementById('qvHostsSearch').focus();
  });
  document.getElementById('qvHostsSearch').addEventListener('input', function(e){ renderQvHostOptions(e.target.value); });

  document.getElementById('qvLoadGroupBtn').addEventListener('click', async function(){
    const gid = document.getElementById('qvGroup').value;
    const status = document.getElementById('qvStatus');
    if(!gid){ status.textContent = 'Pick a host group first.'; status.className='status-msg warn'; return; }
    status.textContent = 'Loading hosts…'; status.className='status-msg';
    try{
      const res = await apiFetch('/api/hostgroups/'+gid+'/hosts');
      if(!res.ok) throw new Error('HTTP '+res.status);
      const hosts = await res.json();
      q.groupid = parseInt(gid, 10);
      q.hostids = hosts.map(function(h){ return parseInt(h.hostid, 10); });
      renderQvHostOptions();
      renderQvHostTrigger();
      status.textContent = 'Loaded '+q.hostids.length+' hosts.';
    }catch(err){
      status.textContent = 'Failed: '+(err.message||err);
      status.className='status-msg warn';
    }
  });

  const qvClearBtn = document.getElementById('qvClearBtn');
  if(qvClearBtn) qvClearBtn.addEventListener('click', function(){
    q.hostids = [];
    q.groupid = null;
    const gEl = document.getElementById('qvGroup');
    if(gEl) gEl.value = '';
    const search = document.getElementById('qvHostsSearch');
    if(search) search.value = '';
    renderQvHostOptions('');
    renderQvHostTrigger();
    const results = document.getElementById('qvResults');
    if(results) results.innerHTML = '';
    const countEl = document.getElementById('qvCount');
    if(countEl) countEl.textContent = '';
    const status = document.getElementById('qvStatus');
    if(status){ status.textContent = 'Selection cleared.'; status.className = 'status-msg'; }
    try{ localStorage.removeItem('zr_qv_problems'); }catch(e){}
  });

  document.getElementById('qvGroup').addEventListener('change', function(e){
    q.groupid = e.target.value ? parseInt(e.target.value, 10) : null;
  });
  document.getElementById('qvSev').addEventListener('change', function(e){
    q.min_severity = parseInt(e.target.value, 10) || 0;
  });

  document.getElementById('qvRunBtn').addEventListener('click', async function(){
    const status = document.getElementById('qvStatus');
    const countEl = document.getElementById('qvCount');
    const results = document.getElementById('qvResults');
    const btn = document.getElementById('qvRunBtn');
    const groupid = document.getElementById('qvGroup').value
      ? parseInt(document.getElementById('qvGroup').value, 10) : null;
    const hostids = (q.hostids || []).slice();
    const min_severity = parseInt(document.getElementById('qvSev').value, 10) || 0;
    const probStatus = (document.getElementById('qvProbStatus')||{}).value || 'open';
    q.status = probStatus;

    if(!groupid && !hostids.length){
      status.textContent = 'Select a host group or at least one host.';
      status.className = 'status-msg warn';
      return;
    }
    btn.classList.add('loading'); btn.disabled = true;
    status.textContent = ''; status.className = 'status-msg';
    countEl.textContent = '';
    results.innerHTML = loadingStateHtml('Fetching problems…');

    // Persist Quick View filter state
    try{
      localStorage.setItem('zr_qv_problems', JSON.stringify({
        hostids: hostids, groupid: groupid, min_severity: min_severity,
        status: probStatus,
        severities: (function(){ const m = min_severity||0; const a=[]; for(let i=m;i<=5;i++) a.push(i); return a; })(),
        include_suppressed: true,
      }));
    }catch(e){ /* ignore quota */ }

    const sevs = (function(){ const m = min_severity||0; const a=[]; for(let i=m;i<=5;i++) a.push(i); return a; })();
    const exportScope = {
      hostids: hostids, groupid: groupid, min_severity: min_severity,
      status: probStatus, ack: 'all', severities: sevs.length ? sevs : null,
      include_suppressed: true,
    };

    try{
      const res = await apiFetch('/api/problems', {
        method: 'POST',
        body: JSON.stringify(exportScope),
      });
      if(!res.ok){
        const err = await res.json().catch(function(){ return {}; });
        throw new Error(err.detail || ('HTTP '+res.status));
      }
      const data = await res.json();
      const problems = data.problems || [];
      countEl.textContent = problems.length + ' problem'+(problems.length===1?'':'s');
      trackNewProblems('qv-problems', problems);
      if(!problems.length){
        results.innerHTML = emptyResultHtml({
          title: 'No problems matched',
          body: 'Nothing open for this scope and severity. Try lowering severity or including more hosts.',
        });
        try{
          const dres = await apiFetch('/api/problems/debug', {
            method: 'POST',
            body: JSON.stringify({ hostids: hostids, groupid: groupid, min_severity: min_severity }),
          });
          if(dres.ok) results.innerHTML += renderDiagPanel(await dres.json());
        }catch(e){ /* ignore */ }
      } else {
        results.innerHTML = computeSeverityChips(problems) + renderAgeTimeline(problems) + renderProblemsTable(problems);
        try{
          enhanceProblemsResults(results, problems, 'qv-problems', function(){
            const b = document.getElementById('qvRunBtn');
            if(b) b.click();
          }, exportScope);
        }catch(enhErr){ console.warn('enhanceProblemsResults', enhErr); }
      }
    }catch(err){
      status.textContent = '';
      status.className = 'status-msg';
      results.innerHTML = errorStateHtml({
        title: 'Could not load problems',
        body: err.message || String(err),
        retryId: 'qvRetryBtn',
      });
      const retry = document.getElementById('qvRetryBtn');
      if(retry) retry.addEventListener('click', function(){ btn.click(); });
    }finally{
      btn.classList.remove('loading'); btn.disabled = false;
    }
  });
}


async function openProblemBuilder(existing){
  probState.view = 'builder';
  probState.builder = existing
    ? {
        id: existing.id,
        name: existing.name,
        hostids: (existing.hostids||[]).map(function(id){ return parseInt(id,10); }),
        groupid: existing.groupid || null,
        min_severity: existing.min_severity || 0,
        status: existing.status || 'open',
        is_shared: !!existing.is_shared,
        shared_userids: existing.shared_userids || [],
        shared_usrgrpids: existing.shared_usrgrpids || [],
      }
    : { id: null, name: '', hostids: [], groupid: null, min_severity: 0, status: 'open', is_shared: false, shared_userids: [], shared_usrgrpids: [] };
  renderProblemBuilder();
}

function renderProblemBuilder(){
  const b = probState.builder;
  const root = probRoot();
  const groupOpts = ['<option value="">— optional: fill hosts from group —</option>'].concat(
    (probState.groups||[]).map(function(g){
      const sel = String(b.groupid||'') === String(g.groupid) ? ' selected' : '';
      return '<option value="'+g.groupid+'"'+sel+'>'+g.name+' ('+g.host_count+')</option>';
    })
  ).join('');
  const sevOpts = [
    [0,'All severities'],[1,'Info+'],[2,'Warning+'],[3,'Average+'],[4,'High+'],[5,'Disaster only']
  ].map(function(p){
    return '<option value="'+p[0]+'"'+(Number(b.min_severity)===p[0]?' selected':'')+'>'+p[1]+'</option>';
  }).join('');

  root.innerHTML =
    '<div class="filterbar">'+
      /* Row 1: Name + share-all */
      '<div class="builder-head">'+
        '<div class="field" style="flex:1"><label for="probName">Name</label>'+
          '<input id="probName" placeholder="e.g. Core switches — open problems" value="'+String(b.name||'').replace(/"/g,'&quot;')+'"></div>'+
        '<div class="field" style="flex:0 0 auto"><label>&nbsp;</label>'+
          '<label style="display:flex;align-items:center;gap:6px;height:38px;font-size:12px;color:var(--text-dim);white-space:nowrap;">'+
            '<input type="checkbox" id="probShared"'+(b.is_shared?' checked':'')+'> Shared with all users'+
          '</label></div>'+
      '</div>'+
      /* Row 2: Users / User groups */
      '<div class="field share-field">'+
        sharePickerHtml('probShare', b.shared_userids || [], b.shared_usrgrpids || [])+
      '</div>'+
      /* Row 3: Host group + Load (source first) */
      '<div class="builder-head" style="margin-top:4px;">'+
        '<div class="field" style="flex:1.2"><label for="probGroup">Host group</label>'+
          '<select id="probGroup">'+groupOpts+'</select></div>'+
        '<div class="field" style="flex:0 0 auto"><label>&nbsp;</label>'+
          '<button type="button" class="btn btn-ghost" id="probLoadGroupBtn" style="height:38px;">Load hosts from group</button></div>'+
      '</div>'+
      /* Row 4: Hosts full-width so many pills wrap cleanly */
      '<div class="builder-head" style="margin-top:0;">'+
        '<div class="field" style="flex:1;min-width:100%;"><label for="probHostsTrigger">Hosts</label>'+
          '<div class="picker" id="probHostsPicker">'+
            '<div class="picker-trigger" id="probHostsTrigger" tabindex="0">'+
              '<span class="picker-placeholder" id="probHostsPlaceholder">Select hosts…</span>'+
              '<svg class="picker-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 9L12 15L18 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'+
            '</div>'+
            '<div class="picker-panel" id="probHostsPanel">'+
              '<input class="picker-search" id="probHostsSearch" placeholder="Filter hosts…" autocomplete="off">'+
              '<div class="picker-list" id="probHostsList"></div>'+
            '</div>'+
          '</div></div>'+
      '</div>'+
      /* Row 5: Min severity + Status */
      '<div class="builder-head" style="margin-top:0;">'+
        '<div class="field" style="flex:0 0 200px;"><label for="probSev">Min severity</label>'+
          '<select id="probSev">'+sevOpts+'</select></div>'+
        '<div class="field" style="flex:0 0 200px;"><label for="probStatus">Status</label>'+
          '<select id="probStatus">'+problemStatusOptions(b.status||'open')+'</select></div>'+
      '</div>'+
      '<div class="col-label-hint">Pick a host group and/or hosts, set a minimum severity, then save. Run anytime to refresh open problems.</div>'+
      '<div class="actions-row">'+
        '<button class="btn btn-primary" id="probSaveBtn">Save dashboard</button>'+
        '<button class="btn btn-ghost" id="probCancelBtn" type="button">Cancel</button>'+
        '<span class="status-msg" id="probStatusMsg"></span>'+
      '</div>'+
    '</div>';

  renderProbHostOptions();
  renderProbHostTrigger();

  document.getElementById('probHostsTrigger').addEventListener('click', function(){
    const panel = document.getElementById('probHostsPanel');
    const trigger = document.getElementById('probHostsTrigger');
    const open = !panel.classList.contains('open');
    panel.classList.toggle('open', open);
    trigger.classList.toggle('open', open);
    if(open) document.getElementById('probHostsSearch').focus();
  });
  document.getElementById('probHostsSearch').addEventListener('input', function(e){ renderProbHostOptions(e.target.value); });

  document.getElementById('probLoadGroupBtn').addEventListener('click', async function(){
    const gid = document.getElementById('probGroup').value;
    const status = document.getElementById('probStatus');
    if(!gid){ status.textContent = 'Pick a host group first.'; status.className='status-msg warn'; return; }
    status.textContent = 'Loading hosts…'; status.className='status-msg';
    try{
      const res = await apiFetch('/api/hostgroups/'+gid+'/hosts');
      if(!res.ok) throw new Error('HTTP '+res.status);
      const hosts = await res.json();
      b.groupid = parseInt(gid, 10);
      b.hostids = hosts.map(function(h){ return parseInt(h.hostid, 10); });
      renderProbHostOptions();
      renderProbHostTrigger();
      status.textContent = 'Loaded '+b.hostids.length+' hosts from group.';
    }catch(err){
      status.textContent = 'Failed to load hosts: '+(err.message||err);
      status.className='status-msg warn';
    }
  });
  document.getElementById('probGroup').addEventListener('change', function(e){
    b.groupid = e.target.value ? parseInt(e.target.value, 10) : null;
  });
  document.getElementById('probSev').addEventListener('change', function(e){
    b.min_severity = parseInt(e.target.value, 10) || 0;
  });
  document.getElementById('probSaveBtn').addEventListener('click', saveProblemDashboard);
  document.getElementById('probCancelBtn').addEventListener('click', showProblemDashList);
  wireShareRetry('probShare', renderProblemBuilder);
  wireSharePicker('probShare');
}

function renderProbHostOptions(filter){
  const list = document.getElementById('probHostsList');
  if(!list || !probState.builder) return;
  const f = (filter || '').trim().toLowerCase();
  const filtered = (probState.hosts||[]).filter(function(h){
    const label = (h.name || h.host || '');
    return !f || label.toLowerCase().includes(f) || (h.groups||'').toLowerCase().includes(f);
  });
  const selected = new Set((probState.builder.hostids||[]).map(function(id){ return parseInt(id,10); }));
  if(!filtered.length){
    list.innerHTML = '<div class="picker-empty">No hosts match.</div>';
    return;
  }
  list.innerHTML = filtered.map(function(h){
    const hid = parseInt(h.hostid, 10);
    return '<label class="picker-option">'+
      '<input type="checkbox" value="'+hid+'" '+(selected.has(hid)?'checked':'')+'>'+
      '<div class="opt-main"><div class="opt-name">'+(h.name||h.host)+'</div>'+
      '<div class="opt-meta">'+(h.groups||'')+'</div></div></label>';
  }).join('');
  list.querySelectorAll('input[type=checkbox]').forEach(function(cb){
    cb.addEventListener('change', function(){
      const hid = parseInt(cb.value, 10);
      const b = probState.builder;
      if(cb.checked){
        if(!b.hostids.includes(hid)) b.hostids.push(hid);
      } else {
        b.hostids = b.hostids.filter(function(id){ return parseInt(id,10) !== hid; });
      }
      renderProbHostTrigger();
    });
  });
}

function renderProbHostTrigger(){
  const trigger = document.getElementById('probHostsTrigger');
  const placeholder = document.getElementById('probHostsPlaceholder');
  if(!trigger || !probState.builder) return;
  trigger.querySelectorAll('.pill').forEach(function(p){ p.remove(); });
  const ids = probState.builder.hostids || [];
  if(!ids.length){ placeholder.style.display = ''; return; }
  placeholder.style.display = 'none';
  ids.forEach(function(hostid){
    const hid = parseInt(hostid, 10);
    const h = (probState.hosts||[]).find(function(x){ return parseInt(x.hostid,10)===hid; });
    const pill = document.createElement('span');
    pill.className = 'pill';
    pill.innerHTML = (h ? (h.name||h.host) : hid)+
      ' <button type="button" aria-label="Remove">'+
      '<svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M6 6L18 18M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg></button>';
    pill.querySelector('button').addEventListener('click', function(e){
      e.stopPropagation();
      probState.builder.hostids = probState.builder.hostids.filter(function(id){ return parseInt(id,10)!==hid; });
      renderProbHostTrigger();
      const search = document.getElementById('probHostsSearch');
      renderProbHostOptions(search ? search.value : '');
    });
    trigger.insertBefore(pill, trigger.querySelector('.picker-chevron'));
  });
}

async function saveProblemDashboard(){
  const b = probState.builder;
  b.name = document.getElementById('probName').value.trim();
  b.min_severity = parseInt(document.getElementById('probSev').value, 10) || 0;
  const gval = document.getElementById('probGroup').value;
  b.groupid = gval ? parseInt(gval, 10) : null;
  b.status = (document.getElementById('probStatus')||{}).value || 'open';
  const sharedEl = document.getElementById('probShared');
  b.is_shared = sharedEl ? !!sharedEl.checked : !!b.is_shared;
  const msg = document.getElementById('probStatusMsg') || document.getElementById('probBuilderStatus');

  if(!b.name){ if(msg){ msg.textContent = 'Name your dashboard.'; msg.className='status-msg warn'; } return; }
  if(!b.hostids.length && !b.groupid){
    if(msg){ msg.textContent = 'Select a host group or at least one host.'; msg.className='status-msg warn'; }
    return;
  }
  const payload = {
    name: b.name,
    hostids: b.hostids,
    groupid: b.groupid,
    min_severity: b.min_severity,
    status: b.status || 'open',
    ack: 'all',
    is_shared: b.is_shared,
    shared_userids: (readSharePicker('probShare').shared_userids),
    shared_usrgrpids: (readSharePicker('probShare').shared_usrgrpids),
  };
  const url = b.id ? '/api/problem-dashboards/'+b.id : '/api/problem-dashboards';
  const method = b.id ? 'PUT' : 'POST';
  const res = await apiFetch(url, { method: method, body: JSON.stringify(payload) });
  if(!res.ok){
    const err = await res.json().catch(function(){ return {}; });
    if(msg){ msg.textContent = err.detail || 'Save failed'; msg.className='status-msg warn'; }
    return;
  }
  showProblemDashList();
}

async function openProblemRun(dashId){
  probState.view = 'run';
  const root = probRoot();
  root.innerHTML = loadingStateHtml('Loading…');
  const res = await apiFetch('/api/problem-dashboards/'+dashId);
  if(!res.ok){
    root.innerHTML = '<div class="placeholder" style="padding:40px;"><div class="ph-sub">Dashboard not found</div></div>';
    return;
  }
  const dashboard = await res.json();
  probState.current = dashboard;

  root.innerHTML =
    '<div class="filterbar">'+
      '<div class="builder-head">'+
        '<div><div class="eyebrow" style="margin-bottom:4px;">Problem dashboard</div>'+
          '<h3 style="margin:0;font-size:16px;">'+dashboard.name+'</h3></div>'+
        '<div class="actions-row" style="margin:0;">'+
          '<button class="btn btn-primary" id="probRunBtn"><span class="spinner"></span><span class="btn-label">Refresh problems</span></button>'+
          '<button class="btn btn-ghost" id="probBackBtn" type="button">Back</button>'+
          '<span class="status-msg" id="probStatusMsg"></span>'+
          '<span class="prob-count" id="probCount"></span>'+
        '</div>'+
      '</div>'+
      '<div class="col-label-hint">Showing current open (unrecovered) problems for the saved host scope.</div>'+
    '</div>'+
    '<div id="probResults" style="margin-top:18px;"></div>';

  document.getElementById('probBackBtn').addEventListener('click', showProblemDashList);
  document.getElementById('probRunBtn').addEventListener('click', function(){ runProblemDashboard(dashboard); });
  runProblemDashboard(dashboard);
}

function renderAgeTimeline(problems){
  if(!problems || !problems.length) return '';
  // Bucket open problems by age into 6 bands for a simple bar timeline
  // min is inclusive lower bound (seconds); max is exclusive upper bound (Infinity for last)
  const bands = [
    { label: '<1h', min: 0, max: 3600 },
    { label: '1–6h', min: 3600, max: 21600 },
    { label: '6–24h', min: 21600, max: 86400 },
    { label: '1–3d', min: 86400, max: 259200 },
    { label: '3–7d', min: 259200, max: 604800 },
    { label: '>7d', min: 604800, max: Infinity },
  ];
  const counts = bands.map(function(){ return 0; });
  problems.forEach(function(p){
    const age = parseInt(p.age_seconds, 10) || 0;
    for(let i=0;i<bands.length;i++){
      if(age >= bands[i].min && (bands[i].max === Infinity || age < bands[i].max)){
        counts[i]++; break;
      }
    }
  });
  const max = Math.max.apply(null, counts.concat([1]));
  const bars = counts.map(function(c, i){
    const h = Math.max(2, Math.round((c / max) * 36));
    const maxAttr = bands[i].max === Infinity ? '' : String(bands[i].max);
    return '<div class="age-bar'+(c?'':' is-empty')+'" role="button" tabindex="0"'+
      ' data-age-min="'+bands[i].min+'" data-age-max="'+maxAttr+'" data-age-label="'+bands[i].label+'"'+
      ' title="Click to filter: '+bands[i].label+' ('+c+')">'+
      '<div class="age-bar-fill" style="height:'+h+'px"></div>'+
      '<div class="age-bar-label">'+bands[i].label+'</div>'+
      '<div class="age-bar-count">'+c+'</div></div>';
  }).join('');
  return '<div class="age-timeline" title="Click a bar to filter the table by age">'+bars+'</div>';
}

function renderProblemsTable(problems){
  if(!problems.length){
    return emptyResultHtml({
      title: 'No problems matched',
      body: 'Nothing matched the current severity, status, or host filters. Try widening the criteria.',
    });
  }
  return '<div class="pivot-wrap"><table class="problems-table">'+
    '<thead><tr>'+
      '<th style="width:28px;"><input type="checkbox" class="prob-check-all" title="Select all"></th>'+
      '<th>Severity</th><th>Status</th><th>Ack</th><th>Host</th><th>Problem</th><th>Since</th><th>Age</th>'+
    '</tr></thead><tbody>'+
    problems.map(function(p){
      const sev = parseInt(p.severity, 10) || 0;
      const host = escHtml(p.host_name || p.host || p.hostid);
      const name = escHtml(String(p.problem_name || p.trigger_name || '—'));
      const since = p.clock ? fmtTime(p.clock) : '—';
      const age = formatAge(p.age_seconds);
      const st = p.problem_status || (p.r_eventid == null ? 'Open' : 'Closed');
      const ack = p.ack_status || (parseInt(p.acknowledged,10)===1 ? 'Acknowledged' : 'Unacknowledged');
      const stCls = st === 'Open' ? 'sev-4' : 'sev-0';
      const ackCls = ack === 'Acknowledged' ? 'sev-1' : 'sev-2';
      const eid = p.eventid || '';
      return '<tr data-eventid="'+eid+'" data-age-seconds="'+(parseInt(p.age_seconds,10)||0)+'">'+
        '<td><input type="checkbox" class="prob-check" value="'+eid+'"></td>'+
        '<td><span class="sev-badge sev-'+sev+'">'+(p.severity_label||sev)+'</span></td>'+
        '<td><span class="sev-badge '+stCls+'">'+st+'</span></td>'+
        '<td><span class="sev-badge '+ackCls+'">'+ack+'</span></td>'+
        '<td class="host-cell">'+host+'</td>'+
        '<td>'+name+'</td>'+
        '<td style="white-space:nowrap;font-family:var(--mono);font-size:12px;">'+since+'</td>'+
        '<td style="white-space:nowrap;font-family:var(--mono);font-size:12px;">'+age+'</td>'+
      '</tr>';
    }).join('')+
    '</tbody></table></div>';
}

async function runProblemDashboard(dashboard){
  const status = document.getElementById('probStatus');
  const countEl = document.getElementById('probCount');
  const results = document.getElementById('probResults');
  const btn = document.getElementById('probRunBtn');
  if(btn){ btn.classList.add('loading'); btn.disabled = true; }
  if(status){ status.textContent = ''; status.className = 'status-msg'; }
  if(countEl) countEl.textContent = '';
  if(results) results.innerHTML = loadingStateHtml('Fetching problems…');

  try{
    const res = await apiFetch('/api/problem-dashboards/'+dashboard.id+'/run', { method:'POST', body: '{}' });
    if(!res.ok){
      const err = await res.json().catch(function(){ return {detail: res.statusText}; });
      throw new Error(typeof err.detail === 'string' ? err.detail : (err.detail && JSON.stringify(err.detail)) || 'Request failed');
    }
    const data = await res.json();
    const problems = data.problems || [];
    if(countEl) countEl.textContent = problems.length + ' open problem'+(problems.length===1?'':'s');
    trackNewProblems('pdash-'+dashboard.id, problems);
    if(results){
      if(!problems.length){
        results.innerHTML = emptyResultHtml({
          title: 'No problems matched',
          body: 'Nothing matched this saved view’s filters right now.',
        });
        try{
          const dres = await apiFetch('/api/problems/debug', {
            method:'POST',
            body: JSON.stringify({
              hostids: dashboard.hostids || [],
              groupid: dashboard.groupid || null,
              min_severity: dashboard.min_severity || 0,
            }),
          });
          if(dres.ok) results.innerHTML += renderDiagPanel(await dres.json());
        }catch(e){ /* ignore */ }
      } else {
        results.innerHTML = computeSeverityChips(problems) + renderAgeTimeline(problems) + renderProblemsTable(problems);
        const exportScope = {
          hostids: dashboard.hostids || [],
          groupid: dashboard.groupid || null,
          min_severity: dashboard.min_severity || 0,
          status: dashboard.status || 'open',
          ack: dashboard.ack || 'all',
        };
        try{
          enhanceProblemsResults(results, problems, 'pdash-'+(dashboard.id||'x'), function(){ runProblemDashboard(dashboard); }, exportScope);
        }catch(enhErr){ console.warn(enhErr); }
        const shareBtn = document.createElement('button');
        shareBtn.type='button'; shareBtn.className='chip-btn'; shareBtn.textContent='Copy link';
        const tools = results.querySelector('.table-tools');
        if(tools) tools.appendChild(shareBtn);
        shareBtn.addEventListener('click', function(){
          setShareLink({ tab: 'problems', pdash: dashboard.id, dash: '' });
          navigator.clipboard.writeText(location.href).then(function(){ showToast('Link copied to clipboard.', { type: 'success' }); });
        });
      }
    }
    probState.lastResult = data;
  }catch(err){
    if(status){ status.textContent = ''; status.className='status-msg'; }
    if(results){
      results.innerHTML = errorStateHtml({
        title: 'Could not load problems',
        body: err.message || String(err),
        retryId: 'probRetryBtn',
      });
      const retry = document.getElementById('probRetryBtn');
      if(retry) retry.addEventListener('click', function(){ runProblemDashboard(dashboard); });
    }
  }finally{
    if(btn){ btn.classList.remove('loading'); btn.disabled = false; }
  }
}


// Entry point — all modules loaded; start the app
boot();
