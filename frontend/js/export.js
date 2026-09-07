/* export.js — CSV / PDF table export (no external deps) */
function downloadText(filename, text, mime){
  const blob = new Blob([text], { type: mime || 'text/csv;charset=utf-8' });
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
 * Cell value for export.
 * mode 'number'  → number only, 2 decimals (CSV) — works for graph/bar/number cells
 * mode 'display' → { text, tone } for PDF (formatted value + threshold colour)
 */
function cellExportValue(td, mode){
  if(!td) return mode === 'display' ? { text: '', tone: '' } : '';
  const tone = (td.dataset && td.dataset.exportTone) || (
    td.classList && td.classList.contains('metric-bad') ? 'bad' :
    td.classList && td.classList.contains('metric-warn') ? 'warn' :
    td.classList && td.classList.contains('metric-good') ? 'good' : ''
  );
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
    if(text === '—' || text === '-' || text === '') return '';
    const m = text.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    return m ? toExportDecimals(m[0]) : '';
  }
  return { text: text, tone: tone };
}

/**
 * Expand a <table> (including rowspan/colspan) into a rectangular matrix.
 * Multi-row headers from <thead> are merged into a single row, e.g.
 *   "CPU %" + "avg" → "CPU % avg"
 * mode 'number'  → string cells (CSV numbers, 2 decimals)
 * mode 'display' → { text, tone } cells (PDF with threshold colours)
 */
function tableToMatrix(table, mode){
  mode = mode === 'number' ? 'number' : 'display';
  if(!table) return [];
  const trs = Array.from(table.querySelectorAll('tr'));
  if(!trs.length) return [];

  const occupied = {};
  const grid = [];
  const theadRows = table.tHead ? table.tHead.rows.length : 0;

  trs.forEach(function(tr, r){
    if(!grid[r]) grid[r] = [];
    const inHead = r < theadRows;
    let c = 0;
    Array.from(tr.querySelectorAll('th,td')).forEach(function(td){
      while(occupied[r + ',' + c]) c++;
      const rs = parseInt(td.getAttribute('rowspan') || td.rowSpan || 1, 10) || 1;
      const cs = parseInt(td.getAttribute('colspan') || td.colSpan || 1, 10) || 1;
      let cellVal;
      if(inHead){
        const t = (td.innerText || '').replace(/\s+/g, ' ').trim();
        cellVal = mode === 'display' ? { text: t, tone: '' } : t;
      } else {
        cellVal = cellExportValue(td, mode);
      }
      for(let i = 0; i < rs; i++){
        for(let j = 0; j < cs; j++){
          const rr = r + i, cc = c + j;
          if(!grid[rr]) grid[rr] = [];
          grid[rr][cc] = cellVal;
          occupied[rr + ',' + cc] = true;
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
  // CSV: numeric values only, always 2 decimal places
  const matrix = tableToMatrix(table, 'number');
  return matrix.map(function(row){
    return row.map(function(v){
      let s = String(v == null ? '' : v);
      if(/[",\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
      return s;
    }).join(',');
  }).join('\n');
}

/**
 * Build human-readable filter lines for export headers.
 * opts: { title, dateFrom, dateTo, day_time_from, day_time_to, comparePrev, extra[] }
 * dateFrom/dateTo may be epoch seconds or datetime-local strings.
 */
function buildExportMeta(opts){
  opts = opts || {};
  const lines = [];
  const title = opts.title || 'Export';
  function fmtRangePart(v){
    if(v == null || v === '') return '';
    if(typeof v === 'number') return fmtTime(v);
    return String(v).replace('T', ' ');
  }
  if(opts.dateFrom != null || opts.dateTo != null){
    lines.push('Date range: ' + fmtRangePart(opts.dateFrom) + ' → ' + fmtRangePart(opts.dateTo) +
      (typeof tzLabel === 'function' ? ' (' + tzLabel() + ')' : ''));
  }
  const hf = opts.day_time_from, ht = opts.day_time_to;
  if(hf && ht){
    lines.push('Hours: ' + hf + ' – ' + ht + ' (local)');
  } else {
    lines.push('Hours: 24h (full day)');
  }
  if(opts.comparePrev) lines.push('Compare previous period: yes');
  if(Array.isArray(opts.extra)){
    opts.extra.forEach(function(x){ if(x) lines.push(String(x)); });
  }
  lines.push('Exported: ' + new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC');
  return { title: title, lines: lines };
}

function exportVisibleTable(rootSel, filename, metaOpts){
  const root = typeof rootSel === 'string' ? document.querySelector(rootSel) : rootSel;
  const table = root && root.querySelector('table');
  if(!table){ showToast('Nothing to export.', { type: 'warn' }); return; }
  const meta = buildExportMeta(metaOpts);
  const body = tableToCsv(table);
  // Metadata as comment lines above the CSV table
  const header = ['# ' + meta.title].concat(meta.lines.map(function(l){ return '# ' + l; })).join('\n') + '\n';
  downloadText(filename || 'export.csv', header + body);
}

/** Export the visible table as a downloadable PDF (simple multi-page table layout). */
function exportVisibleTablePdf(rootSel, filename, metaOpts){
  const root = typeof rootSel === 'string' ? document.querySelector(rootSel) : rootSel;
  const table = root && root.querySelector('table');
  if(!table){ showToast('Nothing to export.', { type: 'warn' }); return; }
  const meta = buildExportMeta(typeof metaOpts === 'string' ? { title: metaOpts } : metaOpts);
  // PDF: formatted display text (value + unit), same as on-screen primary value
  const rows = tableToMatrix(table, 'display');
  if(!rows.length){ showToast('Nothing to export.', { type: 'warn' }); return; }
  try{
    const pdfBytes = buildSimpleTablePdf(rows, meta.title, meta.lines);
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'export.pdf';
    a.click();
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1500);
    showToast('PDF downloaded.', { type: 'success' });
  }catch(err){
    console.warn(err);
    showToast('PDF export failed: '+(err.message||err), { type: 'warn' });
  }
}

/**
 * Minimal PDF writer for tabular data (Helvetica, landscape A4, multi-page).
 * No external deps — good enough for metric/problem/dashboard exports.
 */
function buildSimpleTablePdf(rows, title, metaLines){
  const pageW = 841.89, pageH = 595.28; // landscape A4
  const margin = 36;
  const usableW = pageW - margin * 2;
  const colCount = rows.reduce(function(m, r){ return Math.max(m, r.length); }, 0) || 1;
  const fontSize = colCount > 10 ? 7 : (colCount > 6 ? 8 : 9);
  const lineH = fontSize + 5;
  const colW = usableW / colCount;
  metaLines = Array.isArray(metaLines) ? metaLines : [];

  // Threshold text colours only (no background highlight)
  const TONE_RGB = {
    good: [0.247, 0.749, 0.435],   // #3FBF6F
    warn: [0.910, 0.639, 0.239],   // #E8A33D
    bad:  [0.898, 0.337, 0.427],   // #E5566D
  };

  function cellText(cell){
    if(cell == null) return '';
    if(typeof cell === 'object') return cell.text != null ? String(cell.text) : '';
    return String(cell);
  }
  function cellTone(cell){
    if(cell && typeof cell === 'object') return cell.tone || '';
    return '';
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
  function truncFit(text, maxW){
    const maxChars = Math.max(3, Math.floor(maxW / (fontSize * 0.5)));
    const t = String(text == null ? '' : text);
    return t.length <= maxChars ? t : t.slice(0, Math.max(1, maxChars - 1)) + '...';
  }

  const contentStreams = [];
  let y = 0;
  let stream = '';
  let inText = false;

  function beginText(){
    if(!inText){ stream += 'BT /F1 ' + fontSize + ' Tf 0 0 0 rg\n'; inText = true; }
  }
  function endText(){
    if(inText){ stream += 'ET\n'; inText = false; }
  }
  function startPage(){
    if(stream){ endText(); contentStreams.push(stream); }
    stream = '';
    inText = false;
    y = pageH - margin;
  }
  function ensureSpace(need){
    if(y - need < margin) startPage();
  }
  function setFillRgb(r, g, b){
    stream += r.toFixed(3) + ' ' + g.toFixed(3) + ' ' + b.toFixed(3) + ' rg\n';
  }

  startPage();
  // Title + filter metadata
  stream += 'BT /F1 14 Tf 0 0 0 rg\n';
  stream += '1 0 0 1 ' + margin + ' ' + (y - 14) + ' Tm (' + pdfEscape(title || 'Export') + ') Tj\n';
  stream += 'ET\n';
  y -= 22;
  metaLines.forEach(function(line){
    stream += 'BT /F1 8 Tf 0.35 0.35 0.35 rg\n';
    stream += '1 0 0 1 ' + margin + ' ' + (y - 8) + ' Tm (' + pdfEscape(line) + ') Tj\n';
    stream += 'ET\n';
    y -= 12;
  });
  y -= 8;

  rows.forEach(function(row, rowIdx){
    ensureSpace(lineH + 2);
    endText();
    if(rowIdx === 0){
      setFillRgb(0.92, 0.93, 0.95);
      stream += margin + ' ' + (y - lineH + 2).toFixed(2) + ' ' +
        usableW.toFixed(2) + ' ' + lineH + ' re f\n';
    }
    beginText();
    for(let c = 0; c < colCount; c++){
      const raw = row[c];
      const text = truncFit(cellText(raw), colW - 4);
      const tone = cellTone(raw);
      const x = margin + c * colW + 2;
      if(tone && TONE_RGB[tone] && rowIdx > 0){
        const rgb = TONE_RGB[tone];
        stream += rgb[0].toFixed(3) + ' ' + rgb[1].toFixed(3) + ' ' + rgb[2].toFixed(3) + ' rg\n';
      } else {
        stream += '0 0 0 rg\n';
      }
      stream += '1 0 0 1 ' + x.toFixed(2) + ' ' + (y - fontSize).toFixed(2) + ' Tm (' + pdfEscape(text) + ') Tj\n';
    }
    y -= lineH;
  });
  endText();
  contentStreams.push(stream);

  // Build PDF objects
  const out = [];
  const off = [0];
  function pushObj(str){
    off.push(out.join('').length);
    out.push(off.length - 1 + ' 0 obj\n' + str + '\nendobj\n');
  }
  const nPages = contentStreams.length;
  const fontId = 3;
  const firstPageId = 4;
  pushObj('<< /Type /Catalog /Pages 2 0 R >>');
  const kids = [];
  for(let i = 0; i < nPages; i++) kids.push((firstPageId + i * 2) + ' 0 R');
  pushObj('<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + nPages + ' >>');
  pushObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for(let i = 0; i < nPages; i++){
    const pageId = firstPageId + i * 2;
    const contentId = pageId + 1;
    pushObj(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pageW + ' ' + pageH + '] ' +
      '/Resources << /Font << /F1 ' + fontId + ' 0 R >> >> ' +
      '/Contents ' + contentId + ' 0 R >>'
    );
    const body = contentStreams[i];
    pushObj('<< /Length ' + body.length + ' >>\nstream\n' + body + 'endstream');
  }

  const bodyStr = out.join('');
  const xrefStart = bodyStr.length;
  let xref = 'xref\n0 ' + off.length + '\n0000000000 65535 f \n';
  for(let i = 1; i < off.length; i++){
    xref += String(off[i]).padStart(10, '0') + ' 00000 n \n';
  }
  const pdfStr = '%PDF-1.4\n' + bodyStr + xref +
    'trailer\n<< /Size ' + off.length + ' /Root 1 0 R >>\nstartxref\n' +
    (xrefStart + 9) + '\n%%EOF\n'; // +9 for "%PDF-1.4\n"
  // Fix offsets: they were relative to body without header
  // Rebuild offsets including header prefix
  const header = '%PDF-1.4\n';
  const off2 = [0];
  const out2 = [];
  function pushObj2(str){
    off2.push(header.length + out2.join('').length);
    out2.push(off2.length - 1 + ' 0 obj\n' + str + '\nendobj\n');
  }
  pushObj2('<< /Type /Catalog /Pages 2 0 R >>');
  pushObj2('<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + nPages + ' >>');
  pushObj2('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for(let i = 0; i < nPages; i++){
    const pageId = firstPageId + i * 2;
    const contentId = pageId + 1;
    pushObj2(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pageW + ' ' + pageH + '] ' +
      '/Resources << /Font << /F1 ' + fontId + ' 0 R >> >> ' +
      '/Contents ' + contentId + ' 0 R >>'
    );
    const body = contentStreams[i];
    pushObj2('<< /Length ' + body.length + ' >>\nstream\n' + body + 'endstream');
  }
  const body2 = out2.join('');
  const xrefPos = header.length + body2.length;
  let xref2 = 'xref\n0 ' + off2.length + '\n0000000000 65535 f \n';
  for(let i = 1; i < off2.length; i++){
    xref2 += String(off2[i]).padStart(10, '0') + ' 00000 n \n';
  }
  const finalStr = header + body2 + xref2 +
    'trailer\n<< /Size ' + off2.length + ' /Root 1 0 R >>\nstartxref\n' + xrefPos + '\n%%EOF\n';
  const bytes = new Uint8Array(finalStr.length);
  for(let i = 0; i < finalStr.length; i++) bytes[i] = finalStr.charCodeAt(i) & 0xff;
  return bytes;
}

