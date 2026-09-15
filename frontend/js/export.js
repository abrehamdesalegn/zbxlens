/* export.js — CSV / PDF table export (no external deps) */

/** Download text as a file. For CSV, always write UTF-8 with BOM so Excel reads symbols cleanly. */
function downloadText(filename, text, mime){
  const isCsv = /\.csv$/i.test(filename || '') || (mime && /csv/i.test(mime));
  let payload = text;
  if(isCsv && payload.charAt(0) !== '\ufeff'){
    payload = '\ufeff' + payload;
  }
  const blob = new Blob([payload], { type: mime || (isCsv ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8') });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
}

/** Force a numeric string to exactly 2 decimal places when possible. */
function toExportDecimals(v){
  if(v == null || v === '') return '';
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
  if(isNaN(n)) return String(v);
  return n.toFixed(2);
}

/**
 * Escape a CSV field (RFC 4180): quote when it contains comma, quote, CR, or LF.
 */
function csvEscapeField(v){
  let s = String(v == null ? '' : v);
  // Normalize newlines inside fields
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if(/[",\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/**
 * Cell value for export.
 * mode 'number'  → number only, 2 decimals (CSV) for metric cells; full text for host/label cells
 * mode 'display' → { text, tone } for PDF (formatted value + threshold colour)
 */
function cellExportValue(td, mode){
  if(!td) return mode === 'display' ? { text: '', tone: '' } : '';
  const tone = (td.dataset && td.dataset.exportTone) || (
    td.classList && td.classList.contains('metric-bad') ? 'bad' :
    td.classList && td.classList.contains('metric-warn') ? 'warn' :
    td.classList && td.classList.contains('metric-good') ? 'good' : ''
  );

  // Host / label columns: always keep the full text (never strip digits from hostnames)
  const isHostCell = !!(td.classList && (
    td.classList.contains('host-cell') ||
    td.querySelector && td.querySelector('.host-link')
  ));
  if(isHostCell){
    const hostEl = td.querySelector && td.querySelector('.host-link');
    const hostText = (hostEl
      ? (hostEl.getAttribute('data-host') || hostEl.innerText || hostEl.textContent)
      : (td.innerText || td.textContent) || ''
    ).replace(/\s+/g, ' ').trim();
    if(mode === 'display') return { text: hostText, tone: '' };
    return hostText;
  }

  if(mode === 'number'){
    if(td.dataset && td.dataset.exportNum != null && td.dataset.exportNum !== ''){
      return toExportDecimals(td.dataset.exportNum);
    }
    if(td.classList && td.classList.contains('metric-empty')) return '';
  }
  if(mode === 'display'){
    if(td.dataset && td.dataset.exportText != null && td.dataset.exportText !== ''){
      return { text: td.dataset.exportText, tone: tone };
    }
    const numEl = td.querySelector && td.querySelector('.metric-num');
    if(numEl){
      const clone = numEl.cloneNode(true);
      clone.querySelectorAll('.delta, .delta-good, .metric-prev').forEach(function(n){ n.remove(); });
      return { text: (clone.innerText || '').replace(/\s+/g, ' ').trim(), tone: tone };
    }
  }
  const clone = td.cloneNode(true);
  clone.querySelectorAll('.metric-prev, .delta, .delta-good, .metric-spark, .metric-bar, .spark-loading').forEach(function(n){ n.remove(); });
  let text = (clone.innerText || '').replace(/\s+/g, ' ').trim();
  if(mode === 'number'){
    if(text === '—' || text === '-' || text === '–' || text === '' || /^no data$/i.test(text)) return '';
    // Only treat as a pure metric number when the cell is clearly numeric (or starts with a number)
    const m = text.replace(/,/g, '').match(/^-?\d+(?:\.\d+)?/);
    if(m && m.index === 0) return toExportDecimals(m[0]);
    // Non-numeric label cell (severity, status, problem name, etc.) — keep full text
    return text;
  }
  return { text: text, tone: tone };
}

/**
 * Expand a <table> (including rowspan/colspan) into a rectangular matrix.
 * Multi-row headers from <thead> are merged into a single row for CSV, e.g.
 *   "CPU %" + "avg" → "CPU % avg"
 * mode 'number'  → string cells (CSV numbers, 2 decimals)
 * mode 'display' → { text, tone } cells (PDF with threshold colours)
 *
 * When opts.preserveHeaderRows is true (PDF path), returns
 *   { headerRows: [...], bodyRows: [...], colCount, headerRowCount }
 * so the PDF writer can draw two-tier grouped headers.
 */
function tableToMatrix(table, mode, opts){
  mode = mode === 'number' ? 'number' : 'display';
  opts = opts || {};
  if(!table) return opts.preserveHeaderRows ? { headerRows: [], bodyRows: [], colCount: 0, headerRowCount: 0 } : [];
  const trs = Array.from(table.querySelectorAll('tr'));
  if(!trs.length) return opts.preserveHeaderRows ? { headerRows: [], bodyRows: [], colCount: 0, headerRowCount: 0 } : [];

  const occupied = {};
  const grid = [];
  const theadRows = table.tHead ? table.tHead.rows.length : 0;
  // Track original span info for header cells (for PDF grouping)
  const headerSpans = []; // [row][col] = { text, colspan, rowspan, isOrigin }

  trs.forEach(function(tr, r){
    if(!grid[r]) grid[r] = [];
    const inHead = r < theadRows;
    if(inHead && !headerSpans[r]) headerSpans[r] = [];
    let c = 0;
    Array.from(tr.querySelectorAll('th,td')).forEach(function(td){
      while(occupied[r + ',' + c]) c++;
      const rs = parseInt(td.getAttribute('rowspan') || td.rowSpan || 1, 10) || 1;
      const cs = parseInt(td.getAttribute('colspan') || td.colSpan || 1, 10) || 1;
      let cellVal;
      if(inHead){
        const t = (td.innerText || '').replace(/\s+/g, ' ').trim();
        cellVal = mode === 'display' ? { text: t, tone: '', isHeader: true } : t;
        headerSpans[r][c] = { text: t, colspan: cs, rowspan: rs, isOrigin: true };
      } else {
        cellVal = cellExportValue(td, mode);
      }
      for(let i = 0; i < rs; i++){
        for(let j = 0; j < cs; j++){
          const rr = r + i, cc = c + j;
          if(!grid[rr]) grid[rr] = [];
          grid[rr][cc] = cellVal;
          occupied[rr + ',' + cc] = true;
          if(inHead && (i > 0 || j > 0)){
            if(!headerSpans[rr]) headerSpans[rr] = [];
            headerSpans[rr][cc] = { text: '', colspan: 1, rowspan: 1, isOrigin: false, originR: r, originC: c };
          }
        }
      }
      c += cs;
    });
  });

  let maxCols = 0;
  grid.forEach(function(row){ if(row && row.length > maxCols) maxCols = row.length; });
  const empty = mode === 'display' ? { text: '', tone: '' } : '';
  for(let r = 0; r < grid.length; r++){
    if(!grid[r]) grid[r] = [];
    for(let c = 0; c < maxCols; c++){
      if(grid[r][c] == null) grid[r][c] = empty;
    }
  }

  if(opts.preserveHeaderRows){
    const headerRows = grid.slice(0, theadRows);
    const bodyRows = grid.slice(theadRows);
    return {
      headerRows: headerRows,
      bodyRows: bodyRows,
      colCount: maxCols,
      headerRowCount: theadRows,
      headerSpans: headerSpans
    };
  }

  // CSV path: merge multi-row headers into one row
  if(theadRows >= 2 && grid.length >= theadRows){
    const merged = [];
    for(let c = 0; c < maxCols; c++){
      const parts = [];
      for(let r = 0; r < theadRows; r++){
        const raw = grid[r][c];
        const v = (typeof raw === 'object' && raw ? raw.text : raw) || '';
        const t = String(v).trim();
        if(!t) continue;
        if(parts.length && parts[parts.length - 1].toLowerCase() === t.toLowerCase()) continue;
        parts.push(t);
      }
      const joined = parts.join(' ');
      merged.push(mode === 'display' ? { text: joined, tone: '' } : joined);
    }
    return [merged].concat(grid.slice(theadRows));
  }

  return grid;
}

function tableToCsv(table){
  if(!table) return '';
  // CSV: flattened headers + numbers at 2 decimal places; host/label cells kept as full text
  const matrix = tableToMatrix(table, 'number');
  return matrix.map(function(row){
    return row.map(function(v){
      return csvEscapeField(v);
    }).join(',');
  }).join('\r\n');
}

/**
 * Sanitize a view/dashboard name into a safe download filename (no extension).
 */
function sanitizeExportFilename(name, fallback){
  let s = String(name == null ? '' : name).trim();
  if(!s) s = fallback || 'export';
  // Collapse whitespace, strip path-ish / control chars
  s = s.replace(/[\/\\?%*:|"<>\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^[.\s]+|[.\s]+$/g, '');
  if(!s) s = fallback || 'export';
  // Keep filename reasonable
  if(s.length > 80) s = s.slice(0, 80).trim();
  return s;
}

/**
 * Format a timestamp consistently for export headers.
 * Always uses the same style as fmtTime (DD/MM/YYYY HH:MM) + timezone label.
 * Accepts epoch seconds, datetime-local strings, or Date.
 */
function fmtExportTimestamp(v){
  if(v == null || v === '') return '';
  if(typeof v === 'number'){
    return typeof fmtTime === 'function' ? fmtTime(v) : String(v);
  }
  // datetime-local "YYYY-MM-DDTHH:MM" → parse as wall time in effective TZ
  const s = String(v).replace('T', ' ').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if(m){
    // Already wall-clock in the configured offset — display as DD/MM/YYYY HH:MM
    return m[3] + '/' + m[2] + '/' + m[1] + ' ' + m[4] + ':' + m[5];
  }
  // ISO / Date parseable
  const d = new Date(s);
  if(!isNaN(d.getTime()) && typeof fmtTime === 'function'){
    return fmtTime(Math.floor(d.getTime() / 1000));
  }
  return s;
}

/**
 * Build human-readable filter metadata for export headers.
 * opts: { title, dateFrom, dateTo, day_time_from, day_time_to, comparePrev, extra[] }
 * Returns { title, lines, pairs } where pairs is [[key, value], ...] for CSV key-value block.
 * ASCII-only symbols so CSV opens cleanly in Excel without mojibake.
 */
function buildExportMeta(opts){
  opts = opts || {};
  const lines = [];
  const pairs = [];
  const title = opts.title || 'Export';
  const tz = typeof tzLabel === 'function' ? tzLabel() : 'UTC';
  function fmtRangePart(v){
    return fmtExportTimestamp(v);
  }
  pairs.push(['Report', title]);
  if(opts.dateFrom != null || opts.dateTo != null){
    const range = fmtRangePart(opts.dateFrom) + ' -> ' + fmtRangePart(opts.dateTo) + ' (' + tz + ')';
    lines.push('Date range: ' + range);
    pairs.push(['Date range', range]);
  }
  const hf = opts.day_time_from, ht = opts.day_time_to;
  // Only show Hours when an explicit day-time window was chosen (omit default 24h)
  if(hf && ht){
    const hours = hf + ' - ' + ht + ' (' + tz + ')';
    lines.push('Hours: ' + hours);
    pairs.push(['Hours', hours]);
  }
  if(opts.comparePrev){
    lines.push('Compare previous period: yes');
    pairs.push(['Compare previous period', 'yes']);
  }
  if(Array.isArray(opts.extra)){
    opts.extra.forEach(function(x){
      if(!x) return;
      const s = String(x);
      lines.push(s);
      // "Key: value" -> split; otherwise put under Extra
      const m = s.match(/^([^:]+):\s*(.*)$/);
      if(m) pairs.push([m[1].trim(), m[2].trim()]);
      else pairs.push(['Extra', s]);
    });
  }
  const nowEpoch = Math.floor(Date.now() / 1000);
  const exported = fmtExportTimestamp(nowEpoch) + ' (' + tz + ')';
  lines.push('Exported: ' + exported);
  pairs.push(['Exported', exported]);
  return { title: title, lines: lines, pairs: pairs };
}

/**
 * Build CSV file contents:
 *   key,value metadata block
 *   blank row
 *   flattened table headers + data
 * Numbers always two decimal places; host names fully preserved and quoted when needed.
 */
function buildCsvDocument(table, meta){
  const metaRows = (meta.pairs || []).map(function(kv){
    return csvEscapeField(kv[0]) + ',' + csvEscapeField(kv[1]);
  });
  const tablePart = tableToCsv(table);
  // Blank row separates metadata from the data table so Excel filters/pivots work on the table alone
  return metaRows.join('\r\n') + '\r\n\r\n' + tablePart;
}

function exportVisibleTable(rootSel, filename, metaOpts){
  const root = typeof rootSel === 'string' ? document.querySelector(rootSel) : rootSel;
  const table = root && root.querySelector('table');
  if(!table){ showToast('Nothing to export.', { type: 'warn' }); return; }
  const meta = buildExportMeta(metaOpts);
  const csv = buildCsvDocument(table, meta);
  downloadText(filename || 'export.csv', csv, 'text/csv;charset=utf-8');
}

const PDF_ORIENT_KEY = 'zr_pdf_orientation';

/** Prompt for PDF page orientation (landscape | portrait). Remembers last choice. */
function choosePdfOrientation(){
  const saved = (typeof localStorage !== 'undefined' && localStorage.getItem(PDF_ORIENT_KEY)) || 'landscape';
  return new Promise(function(resolve){
    let el = document.getElementById('pdfOrientModal');
    if(!el){
      el = document.createElement('div');
      el.id = 'pdfOrientModal';
      el.className = 'modal-backdrop';
      el.innerHTML =
        '<div class="modal" style="width:min(380px,92vw);">'+
          '<h3>PDF page orientation</h3>'+
          '<p style="margin:0 0 14px;color:var(--text-dim);font-size:13px;">Choose how the table is laid out on each page.</p>'+
          '<div class="row" style="gap:10px;flex-wrap:wrap;">'+
            '<button type="button" class="btn btn-primary" data-orient="landscape" style="flex:1;min-width:120px;">Landscape</button>'+
            '<button type="button" class="btn btn-ghost" data-orient="portrait" style="flex:1;min-width:120px;">Portrait</button>'+
          '</div>'+
          '<div class="row" style="margin-top:12px;">'+
            '<button type="button" class="btn btn-ghost" data-orient="cancel">Cancel</button>'+
          '</div>'+
        '</div>';
      document.body.appendChild(el);
    }
    // Highlight last choice
    el.querySelectorAll('[data-orient="landscape"],[data-orient="portrait"]').forEach(function(btn){
      const isSaved = btn.getAttribute('data-orient') === saved;
      btn.className = isSaved ? 'btn btn-primary' : 'btn btn-ghost';
      if(isSaved) btn.style.cssText = 'flex:1;min-width:120px;';
      else btn.style.cssText = 'flex:1;min-width:120px;';
    });
    function onClick(e){
      const btn = e.target.closest('[data-orient]');
      if(!btn) return;
      const val = btn.getAttribute('data-orient');
      el.classList.remove('show');
      el.removeEventListener('click', onClick);
      if(val === 'cancel'){ resolve(null); return; }
      try{ localStorage.setItem(PDF_ORIENT_KEY, val); }catch(_){}
      resolve(val === 'portrait' ? 'portrait' : 'landscape');
    }
    el.addEventListener('click', onClick);
    el.classList.add('show');
  });
}

/**
 * Export the visible table as a downloadable PDF.
 * metaOpts may include orientation: 'landscape' | 'portrait' to skip the chooser.
 */
async function exportVisibleTablePdf(rootSel, filename, metaOpts){
  const root = typeof rootSel === 'string' ? document.querySelector(rootSel) : rootSel;
  const table = root && root.querySelector('table');
  if(!table){ showToast('Nothing to export.', { type: 'warn' }); return; }
  const opts = typeof metaOpts === 'string' ? { title: metaOpts } : (metaOpts || {});
  const meta = buildExportMeta(opts);

  let orientation = opts.orientation;
  if(orientation !== 'landscape' && orientation !== 'portrait'){
    orientation = await choosePdfOrientation();
    if(!orientation) return; // cancelled
  }

  // PDF: preserve two-tier headers + formatted display text
  const matrix = tableToMatrix(table, 'display', { preserveHeaderRows: true });
  if(!matrix.colCount || (!matrix.headerRows.length && !matrix.bodyRows.length)){
    showToast('Nothing to export.', { type: 'warn' });
    return;
  }
  try{
    const pdfBytes = buildSimpleTablePdf(matrix, meta.title, meta.lines, { orientation: orientation });
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'export.pdf';
    a.click();
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1500);
    showToast('PDF downloaded (' + orientation + ').', { type: 'success' });
  }catch(err){
    console.warn(err);
    showToast('PDF export failed: '+(err.message||err), { type: 'warn' });
  }
}

/**
 * Enhanced PDF writer for tabular data (Helvetica, multi-page).
 * opts.orientation: 'landscape' (default) | 'portrait'
 */
function buildSimpleTablePdf(matrix, title, metaLines, opts){
  opts = opts || {};
  const isPortrait = String(opts.orientation || 'landscape').toLowerCase() === 'portrait';
  // A4 in points (1 pt = 1/72 in). 12mm ≈ 34 pt
  // Landscape: 841.89 × 595.28  |  Portrait: 595.28 × 841.89
  const pageW = isPortrait ? 595.28 : 841.89;
  const pageH = isPortrait ? 841.89 : 595.28;
  const margin = 34;
  const usableW = pageW - margin * 2;
  // Portrait has less width → slightly taller header bar for wrapped meta is fine
  const footerH = 22;
  const headerBarH = isPortrait ? 56 : 48;

  const headerRows = matrix.headerRows || [];
  const bodyRows = matrix.bodyRows || [];
  let colCount = matrix.colCount || 1;
  const headerRowCount = matrix.headerRowCount || headerRows.length || 0;
  const headerSpans = matrix.headerSpans || [];

  metaLines = Array.isArray(metaLines) ? metaLines : [];

  // Helpers (declared early so width logic can use them)
  function cellText(cell){
    if(cell == null) return '';
    if(typeof cell === 'object') return cell.text != null ? String(cell.text) : '';
    return String(cell);
  }
  function cellTone(cell){
    if(cell && typeof cell === 'object') return cell.tone || '';
    return '';
  }
  function isNoData(text){
    const t = String(text || '').trim().toLowerCase();
    return t === 'no data' || t === '—' || t === '-' || t === '–' || t === 'n/a' || t === '';
  }
  function isNumericLooking(text){
    if(isNoData(text)) return false;
    return /^-?\d/.test(String(text).trim());
  }
  function pdfEscape(s){
    return String(s == null ? '' : s)
      .replace(/\\/g, '\\\\')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)')
      .replace(/[^\x20-\x7E]/g, function(ch){
        const map = {
          '–':'-','—':'-','‘':"'",'’':"'",'“':'"','”':'"','…':'...','°':'deg','×':'x','•':'-',
        };
        if(map[ch]) return map[ch];
        try{ return ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '') || '?'; }
        catch(_){ return '?'; }
      });
  }
  // Shared horizontal padding — headers and body values share the same right edge
  const PAD_R = 8;
  const PAD_L = 4;

  /**
   * Approximate Helvetica / Helvetica-Bold advance width.
   * bold=true uses a slightly wider factor so header labels (AVG/MAX) match bold metrics.
   */
  function approxWidth(text, fs, bold){
    const s = String(text || '');
    let w = 0;
    const f = fs || 9;
    const boldMul = bold ? 1.06 : 1.0;
    for(let i = 0; i < s.length; i++){
      const ch = s.charAt(i);
      let cw;
      if(ch >= '0' && ch <= '9') cw = 0.556;
      else if(ch === '.' || ch === ',' || ch === ':') cw = 0.278;
      else if(ch === ' ') cw = 0.278;
      else if(ch === '%' || ch === '-') cw = 0.584;
      else if(ch === '—') cw = 1.0;
      else if(ch >= 'A' && ch <= 'Z') cw = 0.722;
      else if(ch >= 'a' && ch <= 'z') cw = 0.556;
      else cw = 0.55;
      w += cw * boldMul;
    }
    return w * f;
  }
  function truncFit(text, maxW, fs, bold){
    const t = String(text == null ? '' : text);
    if(approxWidth(t, fs, bold) <= maxW) return t;
    let out = t;
    while(out.length > 1 && approxWidth(out + '...', fs, bold) > maxW) out = out.slice(0, -1);
    return out.length ? out + '...' : '';
  }
  /** Split "12.34 ms" / "99.0 %" into { value, unit } for dual styling. */
  function splitValueUnit(text){
    const s = String(text == null ? '' : text).trim();
    if(!s) return { value: '', unit: '' };
    const m = s.match(/^(-?\d+(?:[.,]\d+)?(?:[eE][+-]?\d+)?)\s*(.*)$/);
    if(m){
      return { value: m[1].replace(',', '.'), unit: (m[2] || '').trim() };
    }
    return { value: s, unit: '' };
  }
  /** Format value+unit with consistent spacing: "100.00%" (no space), "2.27 ms" / "63.81 Mbps". */
  function formatValueUnit(valueStr, unitStr){
    if(!unitStr) return valueStr;
    if(unitStr === '%') return valueStr + '%';
    return valueStr + ' ' + unitStr;
  }

  // ---- Drop empty / checkbox-only columns (no header + only "-" / empty body) ----
  (function dropJunkColumns(){
    const keep = [];
    for(let c = 0; c < colCount; c++){
      let headerLabel = '';
      for(let r = 0; r < headerRowCount; r++){
        const t = cellText(headerRows[r] && headerRows[r][c]);
        if(t){ headerLabel = t; break; }
      }
      if(headerLabel){ keep.push(c); continue; }
      // No header — keep only if some body cell has meaningful content
      let hasContent = false;
      for(let r = 0; r < bodyRows.length; r++){
        const t = cellText(bodyRows[r] && bodyRows[r][c]).trim();
        if(t && t !== '—' && t !== '-' && t !== '–'){ hasContent = true; break; }
      }
      if(hasContent) keep.push(c);
    }
    if(keep.length === colCount) return;
    function projectRow(row){
      return keep.map(function(i){ return (row && row[i] != null) ? row[i] : (modeEmpty()); });
    }
    function modeEmpty(){ return { text: '', tone: '' }; }
    for(let r = 0; r < headerRows.length; r++) headerRows[r] = projectRow(headerRows[r]);
    for(let r = 0; r < bodyRows.length; r++) bodyRows[r] = projectRow(bodyRows[r]);
    // Project headerSpans
    for(let r = 0; r < headerRowCount; r++){
      const old = headerSpans[r] || [];
      const next = [];
      keep.forEach(function(oldC, newC){
        const sp = old[oldC];
        if(sp){
          next[newC] = {
            text: sp.text,
            colspan: 1,
            rowspan: sp.rowspan || 1,
            isOrigin: sp.isOrigin !== false
          };
        }
      });
      headerSpans[r] = next;
    }
    colCount = keep.length;
  })();

  // ---- Inject a leading row-number column (#) ----
  const ROW_NUM_W = Math.min(28, usableW * 0.04);
  // Shift existing columns right by 1
  (function injectRowNumCol(){
    const emptyH = { text: '#', tone: '', isHeader: true };
    const emptyB = { text: '', tone: '' };
    for(let r = 0; r < headerRows.length; r++){
      if(!headerRows[r]) headerRows[r] = [];
      headerRows[r] = [emptyH].concat(headerRows[r]);
    }
    // Only show "#" on the first header row (or span both if multi-row)
    if(headerRows.length >= 2){
      headerRows[0][0] = { text: '#', tone: '', isHeader: true };
      headerRows[1][0] = { text: '', tone: '', isHeader: true };
    }
    for(let r = 0; r < bodyRows.length; r++){
      if(!bodyRows[r]) bodyRows[r] = [];
      bodyRows[r] = [{ text: String(r + 1), tone: '' }].concat(bodyRows[r]);
    }
    // Rebuild headerSpans with the new column 0
    const newSpans = [];
    for(let r = 0; r < headerRowCount; r++){
      newSpans[r] = [];
      if(r === 0){
        newSpans[0][0] = {
          text: '#',
          colspan: 1,
          rowspan: Math.max(1, headerRowCount),
          isOrigin: true
        };
        // mark filled cells for rowspan
        for(let rr = 1; rr < headerRowCount; rr++){
          if(!newSpans[rr]) newSpans[rr] = [];
          newSpans[rr][0] = { text: '', colspan: 1, rowspan: 1, isOrigin: false, originR: 0, originC: 0 };
        }
      }
      const old = headerSpans[r] || [];
      for(let c = 0; c < colCount; c++){
        const sp = old[c];
        if(sp){
          newSpans[r][c + 1] = {
            text: sp.text,
            colspan: sp.colspan || 1,
            rowspan: sp.rowspan || 1,
            isOrigin: sp.isOrigin !== false,
            originR: sp.originR != null ? sp.originR : undefined,
            originC: sp.originC != null ? sp.originC + 1 : undefined
          };
        }
      }
    }
    // replace
    for(let r = 0; r < headerRowCount; r++) headerSpans[r] = newSpans[r] || [];
  })();
  colCount = colCount + 1;

  // Header labels per column (after # injection)
  const colHeaders = [];
  for(let c = 0; c < colCount; c++){
    let label = '';
    for(let r = 0; r < headerRowCount; r++){
      const t = cellText(headerRows[r] && headerRows[r][c]);
      if(t){ label = t; break; }
    }
    colHeaders[c] = label;
  }
  function headerKey(c){
    return String(colHeaders[c] || '').toLowerCase().trim();
  }
  function isHostCol(c){ const k = headerKey(c); return k === 'host' || k.indexOf('host') === 0; }
  function isProblemCol(c){ const k = headerKey(c); return k === 'problem' || k === 'name' || k.indexOf('problem') === 0; }
  function isSeverityCol(c){ const k = headerKey(c); return k === 'severity' || k === 'sev'; }
  function isNarrowCol(c){
    const k = headerKey(c);
    return k === 'status' || k === 'ack' || k === 'age' || k === '#' || k === 'since';
  }
  function isWrapCol(c){ return isHostCol(c) || isProblemCol(c); }

  let firstDataHeader = headerKey(1);
  const isHostAt1 = isHostCol(1);

  // Severity colour map (Zabbix-ish)
  const SEV_RGB = {
    disaster: [0.72, 0.12, 0.22],
    high: [0.85, 0.35, 0.10],
    average: [0.80, 0.55, 0.08],
    warning: [0.75, 0.62, 0.12],
    information: [0.25, 0.55, 0.85],
    info: [0.25, 0.55, 0.85],
    'not classified': [0.45, 0.50, 0.55],
  };
  function severityRgb(text){
    const k = String(text || '').toLowerCase().trim();
    if(SEV_RGB[k]) return SEV_RGB[k];
    // short labels
    if(k === 'dis') return SEV_RGB.disaster;
    if(k === 'hig') return SEV_RGB.high;
    return null;
  }

  /** Word-wrap text into lines that fit maxW (approximate). */
  function wrapLines(text, maxW, fs, bold, maxLines){
    const raw = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if(!raw) return [''];
    const limit = maxLines || 6;
    if(approxWidth(raw, fs, bold) <= maxW) return [raw];
    const words = raw.split(' ');
    const lines = [];
    let cur = '';
    words.forEach(function(word){
      const trial = cur ? (cur + ' ' + word) : word;
      if(approxWidth(trial, fs, bold) <= maxW){
        cur = trial;
      } else {
        if(cur) lines.push(cur);
        // hard-break overlong single word
        if(approxWidth(word, fs, bold) > maxW){
          let chunk = '';
          for(let i = 0; i < word.length; i++){
            const t2 = chunk + word.charAt(i);
            if(approxWidth(t2, fs, bold) > maxW && chunk){
              lines.push(chunk);
              chunk = word.charAt(i);
            } else chunk = t2;
          }
          cur = chunk;
        } else {
          cur = word;
        }
      }
    });
    if(cur) lines.push(cur);
    if(lines.length > limit){
      const kept = lines.slice(0, limit);
      let last = kept[limit - 1];
      while(last.length > 1 && approxWidth(last + '...', fs, bold) > maxW) last = last.slice(0, -1);
      kept[limit - 1] = last + '...';
      return kept;
    }
    return lines.length ? lines : [''];
  }

  // ---- Column widths ----
  const colWidths = new Array(colCount).fill(0);
  colWidths[0] = ROW_NUM_W;
  let remainingW = usableW - ROW_NUM_W;

  // Collect groups from top header row (after #)
  const groups = []; // { start, colspan }
  if(headerRowCount >= 1 && headerSpans[0]){
    let c = 1;
    while(c < colCount){
      const sp = headerSpans[0][c];
      if(sp && sp.isOrigin === false){ c++; continue; }
      const cs = (sp && sp.colspan) || 1;
      groups.push({ start: c, colspan: cs, label: (sp && sp.text) || cellText(headerRows[0][c]) });
      c += cs;
    }
  } else {
    for(let c = 1; c < colCount; c++) groups.push({ start: c, colspan: 1, label: '' });
  }

  // Problems / text-heavy layout: proportional weights by role
  const isProblemsLayout = (function(){
    let hasHost = false, hasProb = false;
    for(let c = 1; c < colCount; c++){
      if(isHostCol(c)) hasHost = true;
      if(isProblemCol(c)) hasProb = true;
    }
    return hasHost && hasProb;
  })();

  if(isProblemsLayout){
    const weights = [];
    let weightSum = 0;
    for(let c = 1; c < colCount; c++){
      let w = 1;
      if(isProblemCol(c)) w = 5.0;           // most width for description
      else if(isHostCol(c)) w = 1.6;
      else if(isSeverityCol(c)) w = 1.05;    // dedicated badge column
      else if(headerKey(c) === 'status') w = 0.55;
      else if(headerKey(c) === 'ack') w = 0.55;
      else if(headerKey(c) === 'age' || headerKey(c) === 'since') w = 0.75;
      weights[c] = w;
      weightSum += w;
    }
    for(let c = 1; c < colCount; c++){
      colWidths[c] = remainingW * (weights[c] / weightSum);
    }
  } else {
    // Host column share (metrics tables)
    const hostPct = isHostAt1 ? 0.20 : 0;
    if(isHostAt1 && groups.length){
      colWidths[1] = remainingW * hostPct;
      remainingW -= colWidths[1];
    }
    const metricGroups = groups.filter(function(g){
      return !(isHostAt1 && g.start === 1);
    });
    const metricCols = metricGroups.reduce(function(n, g){ return n + g.colspan; }, 0);
    if(metricCols > 0){
      const perCol = remainingW / metricCols;
      metricGroups.forEach(function(g){
        for(let j = 0; j < g.colspan; j++) colWidths[g.start + j] = perCol;
      });
    } else {
      const n = colCount - 1 - (isHostAt1 ? 1 : 0);
      const start = isHostAt1 ? 2 : 1;
      const per = n > 0 ? remainingW / n : 0;
      for(let c = start; c < colCount; c++) colWidths[c] = per;
    }
  }

  function colX(c){
    let x = margin;
    for(let i = 0; i < c; i++) x += colWidths[i];
    return x;
  }

  // Group boundary set: after #, after Host, after each metric group
  const groupBoundarySet = {};
  groupBoundarySet[0] = true; // after #
  groups.forEach(function(g){
    const endCol = g.start + g.colspan - 1;
    if(endCol < colCount - 1) groupBoundarySet[endCol] = true;
  });
  // Sub-column boundaries (within a group, between AVG/MIN etc.) — not group-level
  const subBoundarySet = {};
  groups.forEach(function(g){
    if(g.colspan <= 1) return;
    for(let j = 0; j < g.colspan - 1; j++){
      subBoundarySet[g.start + j] = true;
    }
  });

  function dividerXAfterCol(c){
    return colX(c) + colWidths[c];
  }

  // Font sizing — prioritise legibility; only shrink when columns get very dense
  const fontSize = colCount > 16 ? 8 : (colCount > 12 ? 8.5 : (colCount > 8 ? 9.5 : (colCount > 5 ? 10.5 : 11.5)));
  const headerFontSize = Math.max(7.5, fontSize - 0.5);
  const unitFontSize = Math.max(7, fontSize * 0.88);
  const lineH = fontSize + 8;
  const headerLineH = headerFontSize + 8;

  // Threshold text colours (darkened for contrast on white / zebra)
  const TONE_RGB = {
    good: [0.08, 0.48, 0.26],
    warn: [0.70, 0.40, 0.05],
    bad:  [0.68, 0.12, 0.22],
  };
  // Body text — pure near-black for maximum visibility
  const BODY_RGB = [0.05, 0.06, 0.09];
  // Header dark background #1e293b
  const HDR_BG = [0.118, 0.161, 0.231];
  // Zebra #f8fafc
  const ZEBRA = [0.973, 0.980, 0.988];
  // Border #e2e8f0
  const BORDER = [0.886, 0.910, 0.941];
  // Muted null / unit — still readable, not washed out
  const MUTED = [0.35, 0.40, 0.48];
  // Meta gray
  const META = [0.30, 0.34, 0.42];

  // ---- Build content streams (one per page) ----
  const contentStreams = [];
  let y = 0;
  let stream = '';
  let inText = false;

  function beginText(fs, r, g, b, fontRef){
    if(inText) endText();
    const f = fontRef || '/F1';
    stream += 'BT ' + f + ' ' + (fs || fontSize) + ' Tf ' +
      (r != null ? r.toFixed(3)+' '+g.toFixed(3)+' '+b.toFixed(3) : '0 0 0') + ' rg\n';
    inText = true;
  }
  function endText(){
    if(inText){ stream += 'ET\n'; inText = false; }
  }
  function setFillRgb(r, g, b){
    endText();
    stream += r.toFixed(3) + ' ' + g.toFixed(3) + ' ' + b.toFixed(3) + ' rg\n';
  }
  function setStrokeRgb(r, g, b){
    endText();
    stream += r.toFixed(3) + ' ' + g.toFixed(3) + ' ' + b.toFixed(3) + ' RG\n';
  }
  function drawRect(x, yy, w, h, fill){
    endText();
    stream += x.toFixed(2) + ' ' + yy.toFixed(2) + ' ' + w.toFixed(2) + ' ' + h.toFixed(2) + ' re ' + (fill ? 'f' : 'S') + '\n';
  }
  function drawLine(x1, y1, x2, y2, lw){
    endText();
    if(lw != null) stream += lw + ' w\n';
    stream += x1.toFixed(2) + ' ' + y1.toFixed(2) + ' m ' + x2.toFixed(2) + ' ' + y2.toFixed(2) + ' l S\n';
  }
  /** textAt(x, y, text, fs, r, g, b [, fontRef]) — fontRef '/F1' Helvetica or '/F2' Courier */
  function textAt(x, yy, text, fs, r, g, b, fontRef){
    beginText(fs, r, g, b, fontRef);
    stream += '1 0 0 1 ' + x.toFixed(2) + ' ' + yy.toFixed(2) + ' Tm (' + pdfEscape(text) + ') Tj\n';
  }

  function drawExecutiveHeader(){
    // Title = view name; subtitle line with export date is already in metaLines
    const titleText = String(title || 'Export').trim() || 'Export';
    textAt(margin, y - 16, truncFit(titleText, usableW * 0.55, 13, true), 13, 0.08, 0.10, 0.14, '/F2');
    // Compact metadata block on the right (includes Exported: …)
    const metaX = margin + usableW * 0.58;
    const metaFs = 7;
    let my = y - 11;
    metaLines.forEach(function(line){
      textAt(metaX, my, truncFit(line, usableW * 0.40, metaFs), metaFs, META[0], META[1], META[2]);
      my -= 10;
    });
    // Rule under header — exact same width as the table (margin → margin+usableW)
    setStrokeRgb(0.85, 0.87, 0.90);
    drawLine(margin, y - headerBarH + 4, margin + usableW, y - headerBarH + 4, 0.6);
    y -= headerBarH;
  }

  /**
   * Vertical rules.
   * inHeader + mode:
   *   'full'  — group boundaries across the entire header block
   *   'sub'   — sub-column dividers only across the sub-header row (does not cut group labels)
   * body: group + sub-column dividers for the row
   */
  function drawColumnDividers(yTop, yBot, mode){
    for(let c = 0; c < colCount - 1; c++){
      const x = dividerXAfterCol(c);
      const isGroup = !!groupBoundarySet[c];
      const isSub = !!subBoundarySet[c];
      if(mode === 'full'){
        // Full-height group boundaries only (between # / Host / Availability / …)
        if(!isGroup) continue;
        setStrokeRgb(0.55, 0.60, 0.68);
        drawLine(x, yTop, x, yBot, 0.9);
      } else if(mode === 'sub'){
        // Sub-header row only: light rules between AVG | MIN | MAX
        if(!isSub) continue;
        setStrokeRgb(0.32, 0.38, 0.46);
        drawLine(x, yTop, x, yBot, 0.5);
      } else {
        // Body rows
        if(isGroup){
          setStrokeRgb(0.80, 0.84, 0.88);
          drawLine(x, yTop, x, yBot, 0.7);
        } else {
          setStrokeRgb(BORDER[0], BORDER[1], BORDER[2]);
          drawLine(x, yTop, x, yBot, 0.45);
        }
      }
    }
  }

  function drawTableHeader(){
    if(!headerRowCount) return;
    const totalHeaderH = headerRowCount * headerLineH;
    const yTop = y;
    // Dark background for the whole header block
    setFillRgb(HDR_BG[0], HDR_BG[1], HDR_BG[2]);
    drawRect(margin, y - totalHeaderH, usableW, totalHeaderH, true);

    // Parent group labels (colspan>1): centered across their child columns
    // Sub-headers AVG/MIN/MAX: right-aligned with PAD_R matching body values
    for(let hr = 0; hr < headerRowCount; hr++){
      const row = headerRows[hr] || [];
      const spans = headerSpans[hr] || [];
      const isSubHeaderRow = (headerRowCount >= 2 && hr === headerRowCount - 1);
      let c = 0;
      while(c < colCount){
        const spanInfo = spans[c];
        if(spanInfo && spanInfo.isOrigin === false){
          c++;
          continue;
        }
        const cs = (spanInfo && spanInfo.colspan) || 1;
        let label = '';
        if(spanInfo && spanInfo.isOrigin){
          label = spanInfo.text || '';
        } else {
          label = cellText(row[c]);
        }
        if(!label && isSubHeaderRow){ c += cs; continue; }

        let w = 0;
        for(let j = 0; j < cs; j++) w += colWidths[c + j] || 0;
        const x = colX(c);
        const textY = y - (hr * headerLineH) - headerFontSize - 2;
        const upper = String(label || '').toUpperCase();
        const display = truncFit(upper, Math.max(4, w - PAD_L - PAD_R), headerFontSize, true);
        const tw = approxWidth(display, headerFontSize, true);
        let tx;

        const isRowNum = (c === 0);
        const isHostCol = (c === 1 && isHostAt1);

        if(isRowNum){
          // Center "#" in the narrow row-number column
          tx = x + Math.max(1, (w - tw) / 2);
        } else if(isHostCol){
          tx = x + PAD_L;
        } else if(cs > 1 && !isSubHeaderRow){
          // Primary group header — center across its sub-columns
          tx = x + Math.max(PAD_L, (w - tw) / 2);
        } else if(!isSubHeaderRow && cs === 1 && !isHostCol && !isRowNum){
          // Single-column top header (no aggregations) — still center label
          tx = x + Math.max(PAD_L, (w - tw) / 2);
        } else {
          // AVG / MIN / MAX — right-align over numbers
          tx = x + w - PAD_R - tw;
          if(tx < x + PAD_L) tx = x + PAD_L;
        }
        textAt(tx, textY, display, headerFontSize, 1, 1, 1, '/F2');
        c += cs;
      }
    }

    // Group boundaries through the full header height
    drawColumnDividers(yTop, y - totalHeaderH, 'full');
    // Sub-column dividers only in the bottom (sub-header) row — do not cut group labels
    if(headerRowCount >= 2){
      const subTop = y - (headerRowCount - 1) * headerLineH;
      const subBot = y - totalHeaderH;
      drawColumnDividers(subTop, subBot, 'sub');
    }

    y -= totalHeaderH;
    setStrokeRgb(0.06, 0.09, 0.15);
    drawLine(margin, y, margin + usableW, y, 1.2);
  }

  function prepareCellDisplay(c, text){
    let t = String(text == null ? '' : text).trim();
    // Shorten verbose ack labels for PDF
    if(headerKey(c) === 'ack'){
      if(/^acknowledged$/i.test(t)) t = "Ack'd";
      else if(/^unacknowledged$/i.test(t)) t = "Unack'd";
    }
    return t;
  }

  function measureRowHeight(row){
    let linesMax = 1;
    for(let c = 0; c < colCount; c++){
      if(c === 0) continue;
      const text = prepareCellDisplay(c, cellText(row[c]));
      if(isWrapCol(c)){
        const lines = wrapLines(text, Math.max(20, colWidths[c] - PAD_L - PAD_R), fontSize, false, isProblemCol(c) ? 5 : 3);
        if(lines.length > linesMax) linesMax = lines.length;
      }
    }
    const rowPad = 5;
    return Math.max(lineH, linesMax * (fontSize + 2) + rowPad);
  }

  // Precompute row heights for pagination
  const rowHeights = bodyRows.map(function(row){ return measureRowHeight(row); });

  function drawBodyRow(row, rowIdx){
    const isEven = rowIdx % 2 === 1;
    const rowH = rowHeights[rowIdx] || lineH;
    const yTop = y;
    const lineStep = fontSize + 2;

    // Severity left-border marker from dedicated severity column only
    let sevColor = null;
    for(let c = 0; c < colCount; c++){
      if(isSeverityCol(c)){
        sevColor = severityRgb(cellText(row[c]));
        break;
      }
    }

    if(isEven){
      setFillRgb(ZEBRA[0], ZEBRA[1], ZEBRA[2]);
      drawRect(margin, y - rowH, usableW, rowH, true);
    }
    if(sevColor){
      setFillRgb(sevColor[0], sevColor[1], sevColor[2]);
      drawRect(margin, y - rowH, 3.2, rowH, true);
    }
    setStrokeRgb(BORDER[0], BORDER[1], BORDER[2]);
    drawLine(margin, y - rowH, margin + usableW, y - rowH, 0.4);

    for(let c = 0; c < colCount; c++){
      const raw = row[c];
      let text = prepareCellDisplay(c, cellText(raw));
      const tone = cellTone(raw);
      const w = colWidths[c];
      const x = colX(c);
      const isRowNum = (c === 0);
      const noData = isNoData(text);
      const rightEdge = x + w - PAD_R;
      const maxW = Math.max(12, w - PAD_L - PAD_R);

      let vr = BODY_RGB[0], vg = BODY_RGB[1], vb = BODY_RGB[2];
      if(tone && TONE_RGB[tone]){
        const rgb = TONE_RGB[tone];
        vr = rgb[0]; vg = rgb[1]; vb = rgb[2];
      }
      if(isSeverityCol(c)){
        const rgb = severityRgb(text);
        if(rgb){ vr = rgb[0]; vg = rgb[1]; vb = rgb[2]; }
      }

      // Vertical middle: offset block of N lines within rowH
      function blockTop(nLines){
        const blockH = nLines * lineStep;
        const pad = Math.max(2, (rowH - blockH) / 2);
        return y - pad - fontSize;
      }

      if(isRowNum){
        const display = truncFit(text || String(rowIdx + 1), w - 2, fontSize, false);
        const tw = approxWidth(display, fontSize, false);
        const tx = x + Math.max(1, (w - tw) / 2);
        textAt(tx, blockTop(1), display, fontSize, MUTED[0], MUTED[1], MUTED[2], '/F1');
        continue;
      }

      if(noData){
        const display = '—';
        const tw = approxWidth(display, fontSize, false);
        let tx = isWrapCol(c) ? (x + PAD_L) : (rightEdge - tw);
        if(tx < x + PAD_L) tx = x + PAD_L;
        textAt(tx, blockTop(1), display, fontSize, MUTED[0], MUTED[1], MUTED[2], '/F1');
        continue;
      }

      // Host / Problem: left-aligned, word-wrapped, vertically centered as a block
      if(isWrapCol(c) || isHostCol(c)){
        const lines = wrapLines(text, maxW, fontSize, false, isProblemCol(c) ? 5 : 3);
        const top = blockTop(lines.length);
        lines.forEach(function(ln, li){
          textAt(x + PAD_L, top - li * lineStep, ln, fontSize, BODY_RGB[0], BODY_RGB[1], BODY_RGB[2], '/F1');
        });
        continue;
      }

      // Severity badge text (bold + colour), Status / Ack / Age — vertically centered
      if(isSeverityCol(c) || isNarrowCol(c) || !/^[-]?\d/.test(text)){
        const display = truncFit(text, maxW, fontSize, isSeverityCol(c));
        const tw = approxWidth(display, fontSize, isSeverityCol(c));
        let tx;
        if(isSeverityCol(c)) tx = x + PAD_L;
        else tx = rightEdge - tw;
        if(tx < x + PAD_L) tx = x + PAD_L;
        textAt(tx, blockTop(1), display, fontSize, vr, vg, vb, isSeverityCol(c) ? '/F2' : '/F1');
        continue;
      }

      // Numeric metric cells (value + unit)
      const parts = splitValueUnit(text);
      let valueStr = parts.value;
      let unitStr = parts.unit;
      const unitPart = unitStr ? (unitStr === '%' ? '%' : ' ' + unitStr) : '';
      let valW = approxWidth(valueStr, fontSize, true);
      let unitW = unitPart ? approxWidth(unitPart, unitFontSize, false) : 0;
      if(valW + unitW > maxW){
        valueStr = truncFit(valueStr, Math.max(4, maxW - unitW), fontSize, true);
        valW = approxWidth(valueStr, fontSize, true);
      }
      let startX = rightEdge - (valW + unitW);
      if(startX < x + PAD_L) startX = x + PAD_L;
      const ty = blockTop(1);
      textAt(startX, ty, valueStr, fontSize, vr, vg, vb, '/F2');
      if(unitStr){
        const ux = unitStr === '%'
          ? startX + valW
          : startX + valW + approxWidth(' ', unitFontSize, false);
        textAt(ux, ty, unitStr, unitFontSize, MUTED[0], MUTED[1], MUTED[2], '/F1');
      }
    }

    drawColumnDividers(yTop, y - rowH, 'body');
    y -= rowH;
  }

  // ---- Pagination: variable row heights ----
  function availableBodyHeight(isFirstPage){
    const top = isFirstPage ? (headerBarH + 4) : 8;
    const headers = headerRowCount * headerLineH + 2;
    return pageH - margin * 2 - footerH - top - headers;
  }

  const pages = []; // each: { bodyStart, bodyEnd, isFirst }
  let start = 0;
  let first = true;
  if(!bodyRows.length){
    pages.push({ bodyStart: 0, bodyEnd: 0, isFirst: true });
  } else {
    while(start < bodyRows.length){
      const avail = availableBodyHeight(first);
      let used = 0;
      let end = start;
      while(end < bodyRows.length){
        const h = rowHeights[end] || lineH;
        if(end > start && used + h > avail) break;
        used += h;
        end++;
        if(end === start + 1 && h > avail) break; // force at least one row
      }
      if(end === start) end = start + 1;
      pages.push({ bodyStart: start, bodyEnd: end, isFirst: first });
      start = end;
      first = false;
    }
  }
  if(!pages.length){
    pages.push({ bodyStart: 0, bodyEnd: 0, isFirst: true });
  }
  const nPages = pages.length;

  // Second pass: emit streams with footers
  pages.forEach(function(pg, pIdx){
    stream = '';
    inText = false;
    y = pageH - margin;

    if(pg.isFirst){
      drawExecutiveHeader();
    } else {
      // Continuation marker
      textAt(margin, y - 10, truncFit(title || 'Export', usableW * 0.7, 9) + '  (continued)', 9, META[0], META[1], META[2]);
      y -= 18;
    }

    drawTableHeader();

    for(let i = pg.bodyStart; i < pg.bodyEnd; i++){
      drawBodyRow(bodyRows[i], i);
    }

    // Footer: confidentiality + Page X of Y
    endText();
    const footerY = margin - 6;
    setStrokeRgb(0.85, 0.87, 0.90);
    drawLine(margin, footerY + 12, margin + usableW, footerY + 12, 0.5);
    textAt(margin, footerY, 'CONFIDENTIAL — For internal use only', 7, META[0], META[1], META[2]);
    const pageLabel = 'Page ' + (pIdx + 1) + ' of ' + nPages;
    const plW = approxWidth(pageLabel, 7);
    textAt(margin + usableW - plW, footerY, pageLabel, 7, META[0], META[1], META[2]);
    endText();

    contentStreams.push(stream);
  });

  // ---- Assemble PDF objects ----
  // Object layout:
  //  1 Catalog
  //  2 Pages
  //  3 Font Helvetica (F1) — body/host/units
  //  4 Font Helvetica-Bold (F2) — values + headers (max visibility)
  //  5+ page / content pairs
  const header = '%PDF-1.4\n';
  const off = [0];
  const out = [];
  function pushObj(str){
    off.push(header.length + out.join('').length);
    out.push(off.length - 1 + ' 0 obj\n' + str + '\nendobj\n');
  }
  const fontHelvId = 3;
  const fontBoldId = 4;
  const firstPageId = 5;
  const kids = [];
  for(let i = 0; i < nPages; i++) kids.push((firstPageId + i * 2) + ' 0 R');

  pushObj('<< /Type /Catalog /Pages 2 0 R >>');
  pushObj('<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + nPages + ' >>');
  pushObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  pushObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  for(let i = 0; i < nPages; i++){
    const pageId = firstPageId + i * 2;
    const contentId = pageId + 1;
    pushObj(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pageW + ' ' + pageH + '] ' +
      '/Resources << /Font << /F1 ' + fontHelvId + ' 0 R /F2 ' + fontBoldId + ' 0 R >> >> ' +
      '/Contents ' + contentId + ' 0 R >>'
    );
    const body = contentStreams[i];
    pushObj('<< /Length ' + body.length + ' >>\nstream\n' + body + 'endstream');
  }
  const bodyStr = out.join('');
  const xrefPos = header.length + bodyStr.length;
  let xref = 'xref\n0 ' + off.length + '\n0000000000 65535 f \n';
  for(let i = 1; i < off.length; i++){
    xref += String(off[i]).padStart(10, '0') + ' 00000 n \n';
  }
  const finalStr = header + bodyStr + xref +
    'trailer\n<< /Size ' + off.length + ' /Root 1 0 R >>\nstartxref\n' + xrefPos + '\n%%EOF\n';
  const bytes = new Uint8Array(finalStr.length);
  for(let i = 0; i < finalStr.length; i++) bytes[i] = finalStr.charCodeAt(i) & 0xff;
  return bytes;
}
