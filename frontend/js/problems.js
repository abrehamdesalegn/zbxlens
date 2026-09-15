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
      const meta =
        '<span class="meta-tok">'+owner+'</span>'+
        (g ? '<span class="meta-sep">·</span><span class="meta-tok">'+escHtml(g)+'</span>' : '')+
        '<span class="meta-sep">·</span><span class="meta-tok">'+nHosts+' host'+(nHosts===1?'':'s')+'</span>'+
        '<span class="meta-sep">·</span><span class="meta-tok">'+(d.status||'open')+'</span>'+
        '<span class="meta-sep">·</span><span class="meta-tok">min sev '+(d.min_severity||0)+'</span>'+
        '<span class="meta-sep">·</span><span class="meta-tok">updated '+new Date(d.updated_at*1000).toLocaleDateString()+'</span>';
      const moreItems = [];
      moreItems.push('<button type="button" role="menuitem" data-act="export" data-id="'+d.id+'">Export JSON</button>');
      if(canManage()) moreItems.push('<button type="button" role="menuitem" data-act="dup" data-id="'+d.id+'">Duplicate</button>');
      if(d.can_edit){
        moreItems.push('<button type="button" role="menuitem" data-act="edit" data-id="'+d.id+'">Edit</button>');
        moreItems.push('<button type="button" role="menuitem" data-act="delete" data-id="'+d.id+'" class="danger">Delete</button>');
      }
      return '<div class="dash-card dash-card-clickable" data-act="run" data-id="'+d.id+'" title="Open problem view" role="button" tabindex="0">'+
        '<div class="dash-card-top">'+
          '<h4>'+escHtml(d.name)+shareBadge+'</h4>'+
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
        '<div class="dash-meta">'+meta+'</div>'+
        '<div class="dash-card-hint">Click to run</div>'+
      '</div>';
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
    '<div class="filterbar qv-bar qv-bar-problems qv-bar-compact" style="margin-bottom:12px;">'+
      '<div class="qv-row qv-row-problems">'+
        '<div class="field qv-prob-group"><label for="qvGroup">Host groups</label>'+
          '<select id="qvGroup">'+groupOpts+'</select></div>'+
        '<div class="field qv-prob-hosts"><label for="qvHostsTrigger">Hosts</label>'+
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
        '<div class="field qv-prob-sev"><label for="qvSev">Min severity</label>'+
          '<select id="qvSev">'+sevOpts+'</select></div>'+
        '<div class="field qv-prob-status"><label for="qvProbStatus">Status</label>'+
          '<select id="qvProbStatus">'+problemStatusOptions((probState.quick&&probState.quick.status)||'open')+'</select></div>'+
        '<div class="field qv-prob-actions"><label class="qv-actions-spacer">&nbsp;</label>'+
          '<div class="qv-prob-btns">'+
            '<button class="btn btn-primary" id="qvRunBtn"><span class="spinner"></span><span class="btn-label">Show problems</span></button>'+
            '<button type="button" class="btn btn-ghost" id="qvClearBtn" title="Clear host and group selection">Clear</button>'+
          '</div></div>'+
      '</div>'+
      '<div class="qv-status-line qv-status-compact"><span class="status-msg" id="qvStatus" style="display:none;"></span><span class="prob-count" id="qvCount"></span></div>'+
      '<div id="qvResults" style="margin-top:6px;"></div>'+
    '</div>'+
    // ---- Saved views ----
    '<div class="eyebrow dash-list-head" style="margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">'+
      '<span>Saved views</span>'+
      '<span class="dash-list-head-actions">'+
        (canManage() ? '<button type="button" class="btn btn-primary" id="emptyNewProbBtnTop" style="height:30px;padding:0 12px;font-size:12px;">+ New view</button>' : '')+
        (canManage() ? '<button type="button" class="btn btn-ghost" id="pdashImportBtn" style="height:30px;padding:0 10px;font-size:12px;">Import JSON</button>' : '')+
      '</span>'+
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
            ? 'Save a host/group scope as a view for one-click problem refresh, or use Quick view above.'
            : 'No problem views have been shared with you yet. Use Quick view above anytime.',
          actionsHtml: canManage()
            ? '<div class="es-actions"><button type="button" class="btn btn-primary" id="emptyNewProbBtn">New problem view</button></div>'
            : '',
        })
      : '')+
    '<div class="dash-list" id="pdashListGrid">'+cards+
      (canManage() && list.length > 0 ?
      '<div class="new-dash-card" id="newProbDashCard" role="button" tabindex="0">'+
        '<div class="new-dash-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 5V19M5 12H19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></div>'+
        '<div class="new-dash-title">New view</div>'+
        '<div class="new-dash-sub">Save a host/group problem scope</div>'+
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
  const emptyNewProbBtnTop = document.getElementById('emptyNewProbBtnTop');
  if(emptyNewProbBtnTop) emptyNewProbBtnTop.addEventListener('click', function(){ openProblemBuilder(null); });

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
    function runView(id){
      if(!id) return;
      pushRecent('pdash', id, cardNameFor(id));
      openProblemRun(id);
    }
    root.querySelectorAll('.dash-card-clickable').forEach(function(card){
      card.addEventListener('click', function(e){
        if(e.target.closest && e.target.closest('.dash-card-tools, .card-more-menu, .pin-btn, .card-more-btn')) return;
        runView(card.dataset.id);
      });
      card.addEventListener('keydown', function(e){
        if(e.key === 'Enter' || e.key === ' '){
          e.preventDefault();
          runView(card.dataset.id);
        }
      });
    });
    root.querySelectorAll('[data-act="run"]').forEach(function(b){
      if(b.classList.contains('dash-card-clickable')) return;
      b.addEventListener('click', function(){ runView(b.dataset.id); });
    });
    root.querySelectorAll('[data-act="edit"]').forEach(function(b){
      b.addEventListener('click', async function(e){
        e.stopPropagation();
        const res = await apiFetch('/api/problem-dashboards/'+b.dataset.id);
        if(!res.ok){ showToast('Failed to load problem view.', { type: 'warn' }); return; }
        const d = await res.json();
        pushRecent('pdash', d.id, d.name);
        openProblemBuilder(d);
      });
    });
    root.querySelectorAll('[data-act="dup"]').forEach(function(b){
      b.addEventListener('click', async function(e){
        e.stopPropagation();
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
            throw new Error(formatApiDetail(err.detail, 'HTTP '+created.status));
          }
          showToast('Problem view duplicated (as a private copy).', { type: 'success' });
          showProblemDashList();
        }catch(err){ showToast('Duplicate failed: '+(err.message||err), { type: 'warn' }); }
      });
    });
    root.querySelectorAll('[data-act="export"]').forEach(function(b){
      b.addEventListener('click', async function(e){
        e.stopPropagation();
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
      b.addEventListener('click', async function(e){
        e.stopPropagation();
        const ok = await confirmModal('Delete this problem view? This cannot be undone.', { title: 'Delete problem view' });
        if(!ok) return;
        try{
          const res = await apiFetch('/api/problem-dashboards/'+b.dataset.id, { method:'DELETE' });
          if(!res.ok){
            const err = await res.json().catch(function(){ return {}; });
            throw new Error(formatApiDetail(err.detail, 'HTTP '+res.status));
          }
          showToast('Problem view deleted.');
          showProblemDashList();
        }catch(err){ showToast('Delete failed: '+(err.message||err), { type: 'warn' }); }
      });
    });
  }
  wireCardActions();

  // ··· more menu on problem view cards
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
  if(root._probMoreCloser) document.removeEventListener('click', root._probMoreCloser);
  root._probMoreCloser = function(e){
    if(e.target.closest && e.target.closest('.card-more')) return;
    root.querySelectorAll('.card-more-menu').forEach(function(m){ m.hidden = true; });
    root.querySelectorAll('.card-more-btn').forEach(function(b){ b.setAttribute('aria-expanded','false'); });
  };
  document.addEventListener('click', root._probMoreCloser);

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
    const newCardHtml = canManage() && list.length > 0
      ? '<div class="new-dash-card" id="newProbDashCard" role="button" tabindex="0">'+
          '<div class="new-dash-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 5V19M5 12H19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></div>'+
          '<div class="new-dash-title">New view</div>'+
          '<div class="new-dash-sub">Save a host/group problem scope</div>'+
        '</div>'
      : '';
    grid.innerHTML = renderCards(sortList(filtered)) + newCardHtml;
    const newCard = document.getElementById('newProbDashCard');
    if(newCard) newCard.addEventListener('click', function(){ openProblemBuilder(null); });
    wireCardActions();
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
    if(!trigger || !placeholder) return;
    // Compact summary only — never expand into per-host pills
    trigger.querySelectorAll('.pill').forEach(function(p){ p.remove(); });
    const n = (q.hostids || []).length;
    if(!n){
      placeholder.style.display = '';
      placeholder.textContent = 'Select hosts…';
      placeholder.classList.remove('picker-summary');
      return;
    }
    placeholder.style.display = '';
    placeholder.classList.add('picker-summary');
    placeholder.textContent = n === 1 ? '1 host selected' : (n + ' hosts selected');
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

  async function loadHostsForGroup(gid){
    if(!gid){
      q.groupid = null;
      return;
    }
    try{
      const res = await apiFetch('/api/hostgroups/'+gid+'/hosts');
      if(!res.ok) throw new Error('HTTP '+res.status);
      const hosts = await res.json();
      q.groupid = parseInt(gid, 10);
      q.hostids = hosts.map(function(h){ return parseInt(h.hostid, 10); });
      renderQvHostOptions(document.getElementById('qvHostsSearch')?.value || '');
      renderQvHostTrigger();
      // Brief corner toast only — host count is already in the Hosts control
      if(typeof showToast === 'function'){
        showToast('Loaded '+q.hostids.length+' host'+(q.hostids.length===1?'':'s')+' from group.', { type: 'success' });
      }
    }catch(err){
      if(typeof showToast === 'function'){
        showToast('Failed to load hosts: '+(err.message||err), { type: 'warn' });
      }
    }
  }

  // Auto-load hosts when host group changes (no manual Load hosts button)
  const qvGroupEl = document.getElementById('qvGroup');
  if(qvGroupEl){
    qvGroupEl.addEventListener('change', function(){
      const gid = qvGroupEl.value;
      if(!gid){
        q.groupid = null;
        // Don't wipe hostids on clear-of-group alone — user may still want them
        const status = document.getElementById('qvStatus');
        if(status){ status.textContent = ''; status.className = 'status-msg'; }
        return;
      }
      loadHostsForGroup(gid);
    });
    // If a group was restored from localStorage, auto-load its hosts once
    if(q.groupid && (!q.hostids || !q.hostids.length)){
      loadHostsForGroup(String(q.groupid));
    }
  }

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
      name: 'Quick view',
      title: 'Quick view',
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
        throw new Error(formatApiDetail(err.detail, 'HTTP '+res.status));
      }
      const data = await res.json();
      const problems = data.problems || [];
      if(countEl) countEl.textContent = ''; // severity strip shows totals
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
        results.innerHTML = computeSeverityChips(problems) + renderProblemsTable(problems);
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
        selectedGroupIds: Array.isArray(existing.selectedGroupIds)
          ? existing.selectedGroupIds.map(function(id){ return parseInt(id,10); }).filter(Boolean)
          : (existing.groupid ? [parseInt(existing.groupid,10)] : []),
        min_severity: existing.min_severity || 0,
        status: existing.status || 'open',
        is_shared: !!existing.is_shared,
        shared_userids: existing.shared_userids || [],
        shared_usrgrpids: existing.shared_usrgrpids || [],
      }
    : { id: null, name: '', hostids: [], groupid: null, selectedGroupIds: [], min_severity: 0, status: 'open', is_shared: false, shared_userids: [], shared_usrgrpids: [] };
  // Load Zabbix users/groups before first paint (same as metrics builder)
  try{
    await loadShareDirectories();
  }catch(e){
    console.warn('share directories', e);
  }
  renderProblemBuilder();
}

function renderProblemBuilder(){
  const b = probState.builder;
  const root = probRoot();
  if(!Array.isArray(b.selectedGroupIds)){
    b.selectedGroupIds = b.groupid ? [parseInt(b.groupid,10)] : [];
  }
  const sevOpts = [
    [0,'All severities'],[1,'Info+'],[2,'Warning+'],[3,'Average+'],[4,'High+'],[5,'Disaster only']
  ].map(function(p){
    return '<option value="'+p[0]+'"'+(Number(b.min_severity)===p[0]?' selected':'')+'>'+p[1]+'</option>';
  }).join('');

  root.innerHTML =
    '<div class="filterbar">'+
      /* Row 1: Name + Users + User groups */
      '<div class="builder-head builder-meta-row">'+
        '<div class="field builder-field-name"><label for="probName">Name</label>'+
          '<input id="probName" placeholder="e.g. Core switches — open problems" value="'+String(b.name||'').replace(/"/g,'&quot;')+'"></div>'+
        sharePickerHtml('probShare', b.shared_userids || [], b.shared_usrgrpids || [])+
      '</div>'+
      /* Row 3: Host groups (multi) + Load + Hosts compact */
      '<div class="row builder-scope-row">'+
        '<div class="field builder-field-groups"><label>Host groups</label>'+
          '<div class="picker" id="probGroupsPicker">'+
            '<div class="picker-trigger" id="probGroupsTrigger" tabindex="0">'+
              '<span class="picker-placeholder" id="probGroupsPlaceholder">Select host groups…</span>'+
              '<svg class="picker-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 9L12 15L18 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'+
            '</div>'+
            '<div class="picker-panel" id="probGroupsPanel">'+
              '<input class="picker-search" id="probGroupsSearch" placeholder="Filter groups…" autocomplete="off">'+
              '<div class="picker-list" id="probGroupsList"></div>'+
            '</div>'+
          '</div></div>'+
        '<div class="field builder-field-hosts"><label>Hosts</label>'+
          '<div class="picker" id="probHostsPicker">'+
            '<div class="picker-trigger picker-trigger-compact" id="probHostsTrigger" tabindex="0">'+
              '<span class="picker-placeholder" id="probHostsPlaceholder">Select hosts…</span>'+
              '<svg class="picker-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 9L12 15L18 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'+
            '</div>'+
            '<div class="picker-panel" id="probHostsPanel">'+
              '<input class="picker-search" id="probHostsSearch" placeholder="Filter hosts…" autocomplete="off">'+
              '<div class="picker-list" id="probHostsList"></div>'+
            '</div>'+
          '</div></div>'+
      '</div>'+
      /* Row 4: Min severity + Status */
      '<div class="builder-head" style="margin-top:0;">'+
        '<div class="field" style="flex:0 0 200px;"><label for="probSev">Min severity</label>'+
          '<select id="probSev">'+sevOpts+'</select></div>'+
        '<div class="field" style="flex:0 0 200px;"><label for="probStatus">Status</label>'+
          '<select id="probStatus">'+problemStatusOptions(b.status||'open')+'</select></div>'+
      '</div>'+
      '<div class="col-label-hint">Pick a host group and/or hosts, set a minimum severity, then save. Run anytime to refresh open problems.</div>'+
      '<div class="actions-row">'+
        '<button class="btn btn-primary" id="probSaveBtn">Save dashboard</button>'+
        '<button type="button" class="btn btn-ghost" id="probPreviewBtn">Preview</button>'+
        '<button class="btn btn-ghost" id="probCancelBtn" type="button">Cancel</button>'+
        '<span class="status-msg" id="probStatusMsg"></span>'+
      '</div>'+
      '<div class="builder-preview" id="probBuilderPreview" hidden></div>'+
    '</div>';

  renderProbHostOptions();
  renderProbHostTrigger();

  document.getElementById('probHostsTrigger').addEventListener('click', function(){
    toggleProbPicker('probHostsTrigger', 'probHostsPanel', 'probHostsSearch');
  });
  document.getElementById('probHostsSearch').addEventListener('input', function(e){ renderProbHostOptions(e.target.value); });

  renderProbGroupOptions();
  renderProbGroupTrigger();

  function toggleProbPicker(triggerId, panelId, searchId){
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

  document.getElementById('probGroupsTrigger').addEventListener('click', function(){
    toggleProbPicker('probGroupsTrigger', 'probGroupsPanel', 'probGroupsSearch');
  });
  document.getElementById('probGroupsSearch').addEventListener('input', function(e){
    renderProbGroupOptions(e.target.value);
  });

  document.getElementById('probSev').addEventListener('change', function(e){
    b.min_severity = parseInt(e.target.value, 10) || 0;
  });
  const statusSel = document.getElementById('probStatus');
  if(statusSel){
    statusSel.addEventListener('change', function(e){
      b.status = e.target.value || 'open';
    });
  }
  document.getElementById('probSaveBtn').addEventListener('click', saveProblemDashboard);
  document.getElementById('probPreviewBtn').addEventListener('click', previewProblemBuilder);
  document.getElementById('probCancelBtn').addEventListener('click', showProblemDashList);
  wireShareRetry('probShare', renderProblemBuilder);
  wireSharePicker('probShare');
}


function renderProbGroupOptions(filter){
  const list = document.getElementById('probGroupsList');
  const b = probState.builder;
  if(!list || !b) return;
  if(!Array.isArray(b.selectedGroupIds)) b.selectedGroupIds = [];
  const f = (filter||'').trim().toLowerCase();
  const selected = new Set(b.selectedGroupIds.map(function(id){ return parseInt(id,10); }));
  const groups = probState.groups || dashState.allGroups || [];
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
      // Keep legacy groupid in sync for single-group case
      b.groupid = b.selectedGroupIds.length === 1 ? b.selectedGroupIds[0] : null;
      renderProbGroupOptions(document.getElementById('probGroupsSearch')?.value||'');
      renderProbGroupTrigger();
      await loadProbHostsFromGroups();
    });
  });
}

function renderProbGroupTrigger(){
  const ph = document.getElementById('probGroupsPlaceholder');
  const b = probState.builder;
  if(!ph || !b) return;
  if(!Array.isArray(b.selectedGroupIds)) b.selectedGroupIds = [];
  const n = b.selectedGroupIds.length;
  if(!n){
    ph.textContent = 'Select host groups…';
    ph.classList.remove('picker-summary');
    return;
  }
  const groups = probState.groups || dashState.allGroups || [];
  const selected = groups.filter(function(g){
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

async function loadProbHostsFromGroups(){
  const b = probState.builder;
  // Note: #probStatus is the Status <select> in the builder — never use it as a message target
  const status = document.getElementById('probStatusMsg') || document.getElementById('probBuilderStatus');
  if(!b) return;
  if(!Array.isArray(b.selectedGroupIds)) b.selectedGroupIds = [];
  const gids = b.selectedGroupIds.slice();
  if(!gids.length){
    b.hostids = [];
    renderProbHostOptions();
    renderProbHostTrigger();
    if(status){ status.textContent = ''; status.className = 'status-msg'; }
    return;
  }
  if(status){
    status.textContent = 'Loading hosts from '+gids.length+' group'+(gids.length===1?'':'s')+'…';
    status.className = 'status-msg';
  }
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
    if(!probState.hosts) probState.hosts = [];
    const known = {};
    probState.hosts.forEach(function(h){ known[parseInt(h.hostid,10)] = true; });
    hostObjs.forEach(function(h){
      const id = parseInt(h.hostid,10);
      if(!known[id]) probState.hosts.push(h);
    });
    b.hostids = hostids;
    b.groupid = gids.length === 1 ? gids[0] : null;
    renderProbHostOptions();
    renderProbHostTrigger();
    if(status){
      status.textContent = 'Loaded '+hostids.length+' host'+(hostids.length===1?'':'s')+' from '+gids.length+' group'+(gids.length===1?'':'s')+'.';
      status.className = 'status-msg';
    }
  }catch(err){
    if(status){
      status.textContent = 'Failed to load hosts: '+(err.message||err);
      status.className = 'status-msg warn';
    }
  }
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
  if(!ids.length){
    placeholder.style.display = '';
    placeholder.textContent = 'Select hosts…';
    placeholder.classList.remove('picker-summary');
    placeholder.title = '';
    return;
  }
  placeholder.style.display = '';
  const n = ids.length;
  if(n <= 3){
    const names = ids.map(function(hostid){
      const hid = parseInt(hostid,10);
      const h = (probState.hosts||[]).find(function(x){ return parseInt(x.hostid,10)===hid; });
      return h ? (h.name||h.host) : String(hid);
    });
    placeholder.textContent = names.join(', ');
  } else {
    placeholder.textContent = n + ' hosts selected';
  }
  placeholder.title = ids.map(function(hostid){
    const hid = parseInt(hostid,10);
    const h = (probState.hosts||[]).find(function(x){ return parseInt(x.hostid,10)===hid; });
    return h ? (h.name||h.host) : String(hid);
  }).join(', ');
  placeholder.classList.add('picker-summary');
}


async function previewProblemBuilder(){
  const b = probState.builder;
  const msg = document.getElementById('probStatusMsg') || document.getElementById('probBuilderStatus');
  const previewEl = document.getElementById('probBuilderPreview');
  if(!b || !previewEl) return;

  b.min_severity = parseInt((document.getElementById('probSev')||{}).value, 10) || 0;
  b.status = (document.getElementById('probStatus')||{}).value || 'open';
  if(!Array.isArray(b.selectedGroupIds)) b.selectedGroupIds = [];
  b.groupid = b.selectedGroupIds.length === 1 ? b.selectedGroupIds[0]
    : (b.selectedGroupIds.length > 1 ? null : (b.groupid || null));

  if(!b.hostids.length && !b.groupid){
    if(msg){ msg.textContent = 'Select a host group or at least one host.'; msg.className = 'status-msg warn'; }
    return;
  }

  if(msg){ msg.textContent = 'Running preview…'; msg.className = 'status-msg'; }
  previewEl.hidden = false;
  previewEl.innerHTML = loadingStateHtml('Preview problems…');

  const min_severity = b.min_severity || 0;
  const sevs = (function(){ const a=[]; for(let i=min_severity;i<=5;i++) a.push(i); return a; })();
  const payload = {
    hostids: b.hostids || [],
    groupid: b.groupid || null,
    min_severity: min_severity,
    status: b.status || 'open',
    ack: 'all',
    severities: sevs,
    include_suppressed: true,
  };

  try{
    const res = await apiFetch('/api/problems', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if(!res.ok){
      const err = await res.json().catch(function(){ return {}; });
      throw new Error(typeof formatApiDetail === 'function' ? formatApiDetail(err.detail, 'Preview failed') : (err.detail || 'Preview failed'));
    }
    const data = await res.json();
    const problems = data.problems || [];
    if(!problems.length){
      previewEl.innerHTML =
        '<div class="builder-preview-head">'+
          '<span class="eyebrow" style="margin:0;">Preview</span>'+
          '<button type="button" class="chip-btn" id="probPreviewClose">Close</button>'+
        '</div>'+
        emptyResultHtml({
          title: 'No problems matched',
          body: 'Nothing matched this scope and filters right now.',
        });
      const c0 = document.getElementById('probPreviewClose');
      if(c0) c0.addEventListener('click', function(){ previewEl.hidden = true; previewEl.innerHTML = ''; });
      if(msg){ msg.textContent = ''; msg.className = 'status-msg'; }
      return;
    }
    previewEl.innerHTML =
      '<div class="builder-preview-head">'+
        '<span class="eyebrow" style="margin:0;">Preview · ' + problems.length + ' problem'+(problems.length===1?'':'s')+'</span>'+
        '<button type="button" class="chip-btn" id="probPreviewClose">Close</button>'+
      '</div>'+
      (typeof computeSeverityChips === 'function' ? computeSeverityChips(problems) : '') +
      renderProblemsTable(problems);
    const closeBtn = document.getElementById('probPreviewClose');
    if(closeBtn) closeBtn.addEventListener('click', function(){ previewEl.hidden = true; previewEl.innerHTML = ''; });
    try{
      if(typeof enhanceProblemsResults === 'function'){
        enhanceProblemsResults(previewEl, problems, 'prob-preview', function(){ previewProblemBuilder(); }, payload);
      }
    }catch(e){ console.warn(e); }
    if(msg){ msg.textContent = 'Preview ready.'; msg.className = 'status-msg'; }
    previewEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }catch(err){
    previewEl.innerHTML = errorStateHtml({
      title: 'Preview failed',
      body: err.message || String(err),
    });
    if(msg){ msg.textContent = err.message || String(err); msg.className = 'status-msg warn'; }
  }
}

async function saveProblemDashboard(){
  const b = probState.builder;
  b.name = document.getElementById('probName').value.trim();
  b.min_severity = parseInt(document.getElementById('probSev').value, 10) || 0;
  if(!Array.isArray(b.selectedGroupIds)) b.selectedGroupIds = [];
  // Persist single groupid for backend compatibility (first selected, or null when hosts already resolved)
  b.groupid = b.selectedGroupIds.length === 1 ? b.selectedGroupIds[0]
    : (b.selectedGroupIds.length > 1 ? null : (b.groupid || null));
  b.status = (document.getElementById('probStatus')||{}).value || 'open';
  b.is_shared = !!b.is_shared;
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
    '<div class="filterbar prob-run-bar">'+
      '<div class="prob-run-head">'+
        '<div class="prob-run-title">'+
          '<div class="eyebrow">Problem view</div>'+
          '<h3>'+escHtml(dashboard.name)+'</h3>'+
        '</div>'+
        '<div class="prob-run-actions">'+
          '<button class="btn btn-primary" id="probRunBtn"><span class="spinner"></span><span class="btn-label">Refresh</span></button>'+
          '<button class="btn btn-ghost" id="probBackBtn" type="button">Back</button>'+
        '</div>'+
      '</div>'+
    '</div>'+
    '<div id="probResults" class="prob-results"></div>';

  document.getElementById('probBackBtn').addEventListener('click', showProblemDashList);
  document.getElementById('probRunBtn').addEventListener('click', function(){ runProblemDashboard(dashboard); });
  runProblemDashboard(dashboard);
}

/**
 * Split a long problem/trigger name into primary title + secondary context tag.
 * e.g. "Cisco IOS: Switch 2 - Power Supply B, Shutdown: Power supply is in critical state"
 *   → primary: "Power supply is in critical state"
 *   → secondary: "Cisco IOS · Switch 2 - Power Supply B"
 */
function formatProblemHierarchy(raw){
  const full = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  if(!full) return { primary: '—', secondary: '' };
  // Prefer text after the last ": " as the actionable issue title
  const colonIdx = full.lastIndexOf(': ');
  if(colonIdx > 0 && colonIdx < full.length - 2){
    const secondary = full.slice(0, colonIdx).trim();
    const primary = full.slice(colonIdx + 2).trim();
    if(primary.length >= 8 && secondary.length >= 3){
      return { primary: primary, secondary: secondary };
    }
  }
  // Fallback: first clause before " - " if the rest is long
  const dashIdx = full.indexOf(' - ');
  if(dashIdx > 8 && full.length - dashIdx > 12){
    return {
      primary: full.slice(dashIdx + 3).trim(),
      secondary: full.slice(0, dashIdx).trim()
    };
  }
  return { primary: full, secondary: '' };
}

function renderAgeTimeline(problems){
  if(!problems || !problems.length) return '';
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
    for(let i = 0; i < bands.length; i++){
      if(age >= bands[i].min && (bands[i].max === Infinity || age < bands[i].max)){
        counts[i]++; break;
      }
    }
  });
  const max = Math.max.apply(null, counts.concat([1]));
  // Compact horizontal mini-bars inside a tight card
  const rows = counts.map(function(c, i){
    const pct = Math.max(c ? 6 : 0, Math.round((c / max) * 100));
    const maxAttr = bands[i].max === Infinity ? '' : String(bands[i].max);
    const countHtml = c
      ? '<span class="age-h-count">'+c+'</span>'
      : '<span class="age-h-count is-empty">—</span>';
    return '<div class="age-h-row'+(c ? '' : ' is-empty')+(c === max && c ? ' is-peak' : '')+'" role="button" tabindex="0"'+
      ' data-age-min="'+bands[i].min+'" data-age-max="'+maxAttr+'" data-age-label="'+bands[i].label+'"'+
      ' title="Filter: '+bands[i].label+' ('+c+')">'+
      '<span class="age-h-label">'+bands[i].label+'</span>'+
      '<span class="age-h-track"><span class="age-h-fill" style="width:'+pct+'%"></span></span>'+
      countHtml+
    '</div>';
  }).join('');
  return '<div class="age-timeline age-timeline-compact" title="Click a row to filter the table by age">'+
    '<div class="age-timeline-title">Age distribution</div>'+
    '<div class="age-h-list">'+rows+'</div></div>';
}

function renderProblemsTable(problems){
  if(!problems.length){
    return emptyResultHtml({
      title: 'No problems matched',
      body: 'Nothing matched the current severity, status, or host filters. Try widening the criteria.',
    });
  }
  return '<div class="pivot-wrap"><table class="problems-table problems-table-ref">'+
    '<thead><tr>'+
      '<th class="no-sort" style="width:28px;"><input type="checkbox" class="prob-check-all" title="Select all"></th>'+
      '<th>Severity</th>'+
      '<th>Host</th>'+
      '<th>Problem</th>'+
      '<th>Duration</th>'+
      '<th>Ack</th>'+
    '</tr></thead><tbody>'+
    problems.map(function(p){
      const sev = parseInt(p.severity, 10) || 0;
      const hostRaw = p.host_name || p.host || p.hostid || '';
      const host = escHtml(hostRaw);
      const parts = formatProblemHierarchy(p.problem_name || p.trigger_name || '—');
      const primary = escHtml(parts.primary);
      const secondary = parts.secondary
        ? '<span class="prob-sub">'+escHtml(parts.secondary)+'</span>'
        : '';
      // Export-only problem text (primary + secondary, never severity)
      const problemExport = parts.secondary
        ? (parts.primary + ' — ' + parts.secondary)
        : parts.primary;
      const sevLabel = p.severity_label || (typeof SEV_LABELS !== 'undefined' ? SEV_LABELS[sev] : '') || String(sev);
      const age = typeof formatAge === 'function' ? formatAge(p.age_seconds) : String(p.age_seconds || '');
      const isClosed = (typeof isProblemOpen === 'function')
        ? !isProblemOpen(p)
        : (String(p.problem_status || '').toLowerCase() === 'closed' ||
           !(p.r_eventid == null || p.r_eventid === 0 || p.r_eventid === '0'));
      const durationText = isClosed ? 'Closed' : age;
      const isAcked = (p.ack_status === 'Acknowledged') || (parseInt(p.acknowledged, 10) === 1);
      const ackLabel = isAcked ? 'Yes' : 'No';
      const eid = p.eventid || '';
      const selectedCls = ''; // toggled via checkbox handler
      return '<tr data-eventid="'+eid+'" data-age-seconds="'+(parseInt(p.age_seconds,10)||0)+'" data-severity="'+sev+'" class="prob-row sev-row-'+sev+(isClosed?' is-closed':'')+'">'+
        '<td class="prob-check-cell"><input type="checkbox" class="prob-check" value="'+eid+'"></td>'+
        '<td class="sev-cell" data-export-text="'+escHtml(String(sevLabel))+'" data-export-tone="'+(sev>=4?'bad':(sev>=2?'warn':'ok'))+'">'+
          '<span class="sev-inline sev-'+sev+'"><i class="sev-bar"></i>'+escHtml(String(sevLabel))+'</span></td>'+
        '<td class="host-cell" data-export-text="'+escHtml(String(hostRaw))+'">'+host+'</td>'+
        '<td class="prob-name-cell" data-export-text="'+escHtml(problemExport)+'">'+
          '<div class="prob-primary">'+primary+'</div>'+
          (secondary ? '<div class="prob-meta-row">'+secondary+'</div>' : '')+
        '</td>'+
        '<td class="prob-duration'+(isClosed?' is-closed':'')+'" data-export-text="'+escHtml(durationText)+'">'+escHtml(durationText)+'</td>'+
        '<td class="prob-ack-cell" data-export-text="'+escHtml(ackLabel)+'" title="'+(isAcked ? 'Acknowledged' : 'Unacknowledged')+'">'+
          '<span class="ack-pill '+(isAcked?'ack-yes':'ack-no')+'">'+ackLabel+'</span></td>'+
      '</tr>';
    }).join('')+
    '</tbody></table></div>';
}

async function runProblemDashboard(dashboard){
  // Prefer dedicated message slots — never the builder's Status <select>
  const status = document.getElementById('probRunStatus')
    || document.getElementById('probStatusMsg')
    || document.querySelector('#probResults ~ .status-msg, .status-msg#probStatusMsg');
  const results = document.getElementById('probResults');
  const btn = document.getElementById('probRunBtn');
  if(btn){ btn.classList.add('loading'); btn.disabled = true; }
  if(status && status.tagName !== 'SELECT'){ status.textContent = ''; status.className = 'status-msg'; }
  if(results) results.innerHTML = loadingStateHtml('Fetching problems…');

  try{
    const res = await apiFetch('/api/problem-dashboards/'+dashboard.id+'/run', { method:'POST', body: '{}' });
    if(!res.ok){
      const err = await res.json().catch(function(){ return {detail: res.statusText}; });
      throw new Error(typeof err.detail === 'string' ? err.detail : (err.detail && JSON.stringify(err.detail)) || 'Request failed');
    }
    const data = await res.json();
    const problems = data.problems || [];
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
        results.innerHTML = computeSeverityChips(problems) + renderProblemsTable(problems);
        const exportScope = {
          name: dashboard.name || 'Problems',
          title: dashboard.name || 'Problems',
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
    if(status && status.tagName !== 'SELECT'){ status.textContent = ''; status.className='status-msg'; }
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
