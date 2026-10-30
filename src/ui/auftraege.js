// Aufträge dialog, DATEV-Liste dialog and the Auftrag chips the ping / edit
// dialogs show. DOM layer over the pure src/auftraege.js.
//
// SHARING CONTRACT:
//   * Imports data/helpers from ../auftraege.js, block state from ../state.js,
//     `$` from ./dom.js, `toast` from ./notify.js and `render` from
//     ./calendar.js. It never imports dialogs.js — main.js hands in
//     openScrim/close once via initAuftraege (same DI idea as initCalendar),
//     so dialogs.js can import auftragChips from here without a cycle.

import {
  loadCfg, saveCfg, auftragList, upsertAuftrag, parseAuftragText, auftragText,
  parseLabel, datevRows, datevLine, DATEV_HEAD, AUFTR_HEAD, loadDone, setDone,
  fmtStd, fmtDayDE, localDay, normKz,
  IMPORT_FIELDS, findHeaderRow, guessMapping, rowsToAuftraege, mergeImport,
} from '../auftraege.js';
import { state } from '../state.js';
import { $ } from './dom.js';
import { toast } from './notify.js';
import { render } from './calendar.js';

let openScrim = null, close = null;
export function initAuftraege(deps) { ({ openScrim, close } = deps); }

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/* ============================================================
   AUFTRAG CHIPS + AUTOCOMPLETE (ping / catch-up / edit)
   ============================================================ */
/** One shared <datalist> of all Kürzel, refreshed on every dialog open. */
export function attachAuftragList(inp) {
  let dl = $('auftrDatalist');
  if (!dl) { dl = el('datalist'); dl.id = 'auftrDatalist'; document.body.appendChild(dl); }
  dl.innerHTML = '';
  for (const a of auftragList()) {
    const o = el('option'); o.value = a.kz + ' '; o.label = a.name || a.mandant; dl.appendChild(o);
  }
  inp.setAttribute('list', 'auftrDatalist');
}

/** Swap the Auftrag in an input's value, keeping the comment the user typed. */
export function applyKz(inp, kz) {
  const { kommentar } = parseLabel(inp.value, auftragList());
  inp.value = kz + ' ' + kommentar;
  inp.focus();
  inp.setSelectionRange(inp.value.length, inp.value.length);
}

/** Favoriten-Chips; `target()` returns the input a click writes into. Returns
    null when no favourites exist, so callers can skip the row entirely. */
export function auftragChips(target) {
  const favs = auftragList().filter(a => a.fav);
  if (!favs.length) return null;
  const wrap = el('div', 'chips auftr-chips');
  const lbl = el('span', 'auftr-chips-lbl', 'Auftrag:');
  wrap.appendChild(lbl);
  for (const a of favs) {
    const b = el('button', 'chip-b auftr', a.kz);
    if (a.name) b.appendChild(el('span', 'auftr-chip-name', a.name.split(' · ')[0].slice(0, 22)));
    b.type = 'button';
    b.title = [a.name, a.mandant && 'Mdt. ' + a.mandant, a.art, a.vj].filter(Boolean).join(' · ');
    b.onclick = () => { const t = target(); if (t && !t.disabled) applyKz(t, a.kz); };
    wrap.appendChild(b);
  }
  return wrap;
}

/* ============================================================
   AUFTRÄGE DIALOG
   ============================================================ */
const COLS = [
  ['kz', 'Kürzel'], ['name', 'Bezeichnung'], ['mandant', 'Mandant'], ['art', 'Auftragsart'],
  ['vj', 'VJ'], ['ta', 'TA'], ['pos', 'Aufwandspos.'],
];

export function openAuftraege() {
  const cfg = loadCfg();
  $('auftrMa').value = cfg.mitarbeiter || '';
  $('auftrRound').value = cfg.rounding || 'up';
  $('auftrPaste').value = '';
  $('auftrFilter').value = '';
  if (!imp) $('auftrMap').hidden = true;
  renderAuftrTable();
  openScrim('auftrScrim');
  setTimeout(() => $(cfg.list.length ? 'auftrFilter' : 'auftrMa').focus(), 60);
}

const TABLE_CAP = 200;   // rows rendered at once; the search narrows the rest

function renderAuftrTable() {
  const cfg = loadCfg();
  const q = $('auftrFilter').value.trim().toLowerCase();
  const hit = a => !q || [a.kz, a.name, a.mandant, a.art, a.vj, a.ta, a.pos].join(' ').toLowerCase().includes(q);
  const rows = cfg.list.filter(hit).sort((a, b) => (b.fav - a.fav) || a.kz.localeCompare(b.kz, 'de', { numeric: true }));
  const favs = cfg.list.filter(a => a.fav).length;
  $('auftrCount').textContent = !cfg.list.length
    ? 'Noch keine Aufträge — oben eine DATEV-Liste einlesen.'
    : cfg.list.length + (cfg.list.length === 1 ? ' Auftrag' : ' Aufträge') + ' · ' + favs + ' Favoriten'
      + (q ? ' · ' + rows.length + ' Treffer' : '') + (rows.length > TABLE_CAP ? ' · erste ' + TABLE_CAP + ' angezeigt' : '');
  const tb = $('auftrBody'); tb.innerHTML = '';
  const change = (kz, fn) => { const c = loadCfg(); const a = c.list.find(x => x.kz === kz); if (a) { fn(a); saveCfg(c); } };
  rows.slice(0, TABLE_CAP).forEach(a => {
    const tr = el('tr');
    const fav = el('button', 'icon-btn fav' + (a.fav ? ' on' : ''), a.fav ? '★' : '☆');
    fav.type = 'button'; fav.title = a.fav ? 'Favorit — erscheint im Ping' : 'Als Favorit in den Ping holen';
    fav.setAttribute('aria-pressed', a.fav ? 'true' : 'false');
    fav.onclick = () => { change(a.kz, x => { x.fav = !x.fav; }); renderAuftrTable(); };
    const td0 = el('td'); td0.appendChild(fav); tr.appendChild(td0);
    COLS.forEach(([f]) => tr.appendChild(el('td', f === 'kz' ? 'mono kz' : f === 'name' ? 'nm' : '', a[f])));
    const abr = el('input'); abr.type = 'checkbox'; abr.checked = a.abr; abr.title = 'abrechenbar';
    abr.onchange = () => change(a.kz, x => { x.abr = abr.checked; });
    const tdA = el('td'); tdA.appendChild(abr); tr.appendChild(tdA);
    const del = el('button', 'icon-btn', '✕'); del.type = 'button'; del.title = 'Auftrag ' + a.kz + ' löschen';
    del.onclick = () => {
      const c = loadCfg(); c.list = c.list.filter(x => x.kz !== a.kz); saveCfg(c); renderAuftrTable(); render();
      toast('Gelöscht: ' + a.kz + ' — Blöcke behalten ihren Text');
    };
    const tdD = el('td'); tdD.appendChild(del); tr.appendChild(tdD);
    tb.appendChild(tr);
  });
}

/* ---------- DATEV-Liste einlesen (Excel/CSV) ---------- */
let imp = null;   // { name, rows } of the file being mapped

function readImportFile(file) {
  if (typeof XLSX === 'undefined') { toast('Excel-Funktion gerade nicht verfügbar'); return; }
  const fr = new FileReader();
  fr.onload = ev => {
    try {
      // codepage 1252: DATEV CSV exports are usually Windows-1252, not UTF-8
      const wb = XLSX.read(ev.target.result, { type: 'array', codepage: 1252 });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
      if (rows.length < 2) { toast('Die Datei enthält keine Tabelle'); return; }
      imp = { name: file.name, rows };
      openMapping();
    } catch (e) { toast('Datei konnte nicht gelesen werden'); }
  };
  fr.readAsArrayBuffer(file);
}

function openMapping(headRow) {
  const cfg = loadCfg();
  const h = headRow ?? findHeaderRow(imp.rows);
  const header = imp.rows[h] || [];
  const map = guessMapping(header);
  // a saved mapping wins where its header name is still present
  for (const [f] of IMPORT_FIELDS) {
    const i = (cfg.importMap || {})[f] ? header.findIndex(x => String(x).trim() === cfg.importMap[f]) : -1;
    if (i >= 0) map[f] = i;
  }
  $('auftrMapFile').textContent = imp.name;
  const hs = $('auftrMapHead'); hs.innerHTML = '';
  imp.rows.slice(0, 25).forEach((r, i) => {
    const o = el('option', '', 'Zeile ' + (i + 1)); o.value = i; hs.appendChild(o);
  });
  hs.value = h;
  const width = Math.max(...imp.rows.slice(h, h + 50).map(r => r.length));
  const grid = $('auftrMapGrid'); grid.innerHTML = '';
  for (const [f, lbl, req] of IMPORT_FIELDS) {
    const wrap = el('div');
    const l = el('label', 'fl', lbl + (req ? ' *' : '')); l.htmlFor = 'auftrMap_' + f;
    const sel = el('select', 'txt'); sel.id = 'auftrMap_' + f;
    sel.appendChild(Object.assign(el('option', '', '— keine Spalte —'), { value: '' }));
    for (let i = 0; i < width; i++) {
      const name = String(header[i] ?? '').trim() || 'Spalte ' + (i + 1);
      sel.appendChild(Object.assign(el('option', '', name), { value: String(i) }));
    }
    sel.value = map[f] === undefined ? '' : String(map[f]);
    sel.onchange = previewMapping;
    wrap.append(l, sel); grid.appendChild(wrap);
  }
  $('auftrMapPos').value = cfg.importPos || '';
  $('auftrMap').hidden = false;
  previewMapping();
  $('auftrMap').scrollIntoView({ block: 'nearest' });
}

function currentMapping() {
  const map = {};
  for (const [f] of IMPORT_FIELDS) { const v = $('auftrMap_' + f).value; if (v !== '') map[f] = +v; }
  return map;
}

function previewMapping() {
  const map = currentMapping(), h = +$('auftrMapHead').value;
  const missing = IMPORT_FIELDS.filter(([f, , req]) => req && map[f] === undefined).map(([, l]) => l);
  const info = $('auftrMapInfo');
  if (missing.length) { info.textContent = 'Bitte zuordnen: ' + missing.join(', '); $('auftrMapGo').disabled = true; return; }
  const recs = rowsToAuftraege(imp.rows, h, map, { pos: $('auftrMapPos').value.trim() });
  const { added, updated } = mergeImport(loadCfg().list, recs);
  info.textContent = recs.length + ' Aufträge erkannt — ' + added + ' neu, ' + updated + ' schon vorhanden.'
    + (recs[0] ? ' Beispiel-Kürzel: ' + recs[0].kz : '');
  $('auftrMapGo').disabled = !recs.length;
}

function runImport() {
  const map = currentMapping(), h = +$('auftrMapHead').value;
  const recs = rowsToAuftraege(imp.rows, h, map, { pos: $('auftrMapPos').value.trim() });
  const c = loadCfg();
  const res = mergeImport(c.list, recs, { prune: $('auftrMapPrune').checked });
  c.list = res.list;
  // remember the mapping by header NAME, so a re-export with shifted columns still fits
  const header = imp.rows[h] || [];
  c.importMap = Object.fromEntries(Object.entries(map)
    .map(([f, i]) => [f, String(header[i] ?? '').trim()]).filter(([, n]) => n));
  c.importPos = $('auftrMapPos').value.trim();
  if (!saveCfg(c)) { toast('Speichern fehlgeschlagen — Browser-Speicher voll?'); return; }
  closeMapping(); renderAuftrTable(); render();
  toast(res.added + ' neu, ' + res.updated + ' aktualisiert' + (res.removed ? ', ' + res.removed + ' entfernt' : ''));
}

/** Open the mapping step for rows read elsewhere (the OneDrive layer's
    central list when its columns are not mapped yet). */
export function importRows(name, rows) {
  imp = { name, rows };
  openAuftraege();
  openMapping();
}

function closeMapping() { $('auftrMap').hidden = true; $('auftrFile').value = ''; imp = null; }

function addFromForm() {
  const rec = {};
  for (const [f] of COLS) rec[f] = $('auftrNew_' + f).value;
  rec.abr = $('auftrNew_abr').checked;
  if (!normKz(rec.kz)) { toast('Kürzel fehlt — ein Wort, z. B. 10023-JA-25'); $('auftrNew_kz').focus(); return; }
  if (!rec.mandant.trim()) { toast('Mandantennummer fehlt'); $('auftrNew_mandant').focus(); return; }
  const c = loadCfg(); c.list = upsertAuftrag(c.list, rec); saveCfg(c);
  for (const [f] of COLS) $('auftrNew_' + f).value = '';
  $('auftrNew_abr').checked = true;
  renderAuftrTable(); render();
  toast('Gespeichert: ' + normKz(rec.kz));
  $('auftrNew_kz').focus();
}

function importPaste() {
  const recs = parseAuftragText($('auftrPaste').value);
  if (!recs.length) { toast('Nichts erkannt — Spalten: ' + AUFTR_HEAD.join(', ')); return; }
  const c = loadCfg();
  for (const r of recs) c.list = upsertAuftrag(c.list, r);
  saveCfg(c); $('auftrPaste').value = '';
  renderAuftrTable(); render();
  toast(recs.length + (recs.length === 1 ? ' Auftrag übernommen' : ' Aufträge übernommen'));
}

async function copyList() {
  const txt = auftragText(loadCfg().list);
  try { await navigator.clipboard.writeText(txt); toast('Liste kopiert — in Excel einfügen'); }
  catch (e) { $('auftrPaste').value = txt; $('auftrPaste').select(); toast('Kopieren blockiert — Text ist markiert (Strg+C)'); }
}

function saveSettings() {
  const c = loadCfg();
  c.mitarbeiter = $('auftrMa').value.trim();
  c.rounding = $('auftrRound').value;
  saveCfg(c);
}

/* ============================================================
   DATEV-LISTE
   ============================================================ */
let dvDay = null;   // 'YYYY-MM-DD' shown in the list

export function openDatevListe(day) {
  dvDay = day || dvDay || localDay(new Date());
  renderDatev();
  openScrim('datevScrim');
}

function shiftDay(n) {
  const d = new Date(dvDay + 'T12:00:00'); d.setDate(d.getDate() + n);
  dvDay = localDay(d); renderDatev();
}

function dayBlocks(day) {
  return state.blocks.filter(b => localDay(new Date(b.start)) === day);
}

async function copyCell(text, what) {
  try { await navigator.clipboard.writeText(text); toast(what + ' kopiert: ' + (text || '—')); }
  catch (e) { toast('Kopieren nicht möglich — bitte abtippen'); }
}

function renderDatev() {
  const cfg = loadCfg();
  $('dvDate').value = dvDay;
  const d = new Date(dvDay + 'T12:00:00');
  $('dvTitle').textContent = d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const { rows, unassigned } = datevRows(dayBlocks(dvDay), cfg);
  const done = loadDone();
  const tb = $('dvBody'); tb.innerHTML = '';
  let sumStd = 0, sumMin = 0, doneStd = 0;
  for (const r of rows) {
    sumStd += r.std; sumMin += r.min;
    const isDone = r.key in done, changed = isDone && done[r.key] !== r.std;
    if (isDone && !changed) doneStd += r.std;
    const tr = el('tr', changed ? 'changed' : isDone ? 'done' : '');
    const chk = el('input'); chk.type = 'checkbox'; chk.checked = isDone;
    chk.title = 'In DATEV erfasst'; chk.setAttribute('aria-label', 'In DATEV erfasst: ' + r.auftrag.kz);
    chk.onchange = () => { setDone(r.key, chk.checked && !changed ? r.std : null); renderDatev(); };
    if (changed) chk.title = 'Seit dem Abhaken geändert — in DATEV korrigieren, dann neu abhaken';
    const td0 = el('td'); td0.appendChild(chk); tr.appendChild(td0);
    const line = datevLine(r, cfg);
    line.forEach((v, i) => {
      const td = el('td', i === 9 ? 'kom' : 'mono');
      const b = el('button', 'cell', v || '—'); b.type = 'button';
      b.title = DATEV_HEAD[i] + ' kopieren';
      b.onclick = () => copyCell(v, DATEV_HEAD[i]);
      td.appendChild(b);
      if (i === 0) td.appendChild(el('small', 'raw', changed
        ? 'in DATEV: ' + fmtStd(done[r.key]) : r.min + ' min'));
      tr.appendChild(td);
    });
    tr.appendChild(el('td', 'mono kz', r.auftrag.kz));
    tb.appendChild(tr);
  }
  $('dvEmpty').hidden = rows.length > 0 || unassigned.length > 0;
  $('dvTable').hidden = rows.length === 0;

  const warn = $('dvOpen'); warn.innerHTML = '';
  if (unassigned.length) {
    warn.appendChild(el('p', 'dv-warn-h', 'Ohne Auftrag (' + unassigned.length + ') — Kürzel an den Anfang des Blocks schreiben:'));
    const ul = el('ul');
    for (const u of unassigned) ul.appendChild(el('li', '', '„' + u.label + '“ · ' + u.min + ' min'));
    warn.appendChild(ul);
  }
  warn.hidden = !unassigned.length;
  const openMin = unassigned.reduce((s, u) => s + u.min, 0);
  $('dvSum').innerHTML = rows.length || openMin
    ? 'Summe <b>' + fmtStd(sumStd) + ' Std.</b> (erfasst ' + (sumMin / 60).toFixed(2).replace('.', ',') + ' h)'
      + ' · in DATEV abgehakt ' + fmtStd(doneStd) + ' Std.'
      + (openMin ? ' · <span class="warn">' + openMin + ' min ohne Auftrag</span>' : '')
      + (cfg.mitarbeiter ? '' : ' · <span class="warn">Mitarbeiternr. fehlt (Aufträge)</span>')
    : '';
}

function exportDatevXlsx() {
  if (typeof XLSX === 'undefined') { toast('Excel-Funktion gerade nicht verfügbar'); return; }
  const from = $('dvFrom').value || dvDay, to = $('dvTo').value || dvDay;
  if (from > to) { toast('„Von“ liegt nach „Bis“ — bitte Zeitraum prüfen.'); return; }
  const cfg = loadCfg();
  const blocks = state.blocks.filter(b => { const k = localDay(new Date(b.start)); return k >= from && k <= to; });
  const { rows, unassigned } = datevRows(blocks, cfg);
  if (!rows.length) { toast('Keine Zeiten mit Auftrag im Zeitraum'); return; }
  const data = [[...DATEV_HEAD, 'Kürzel', 'Minuten']];
  rows.sort((a, b) => a.day.localeCompare(b.day) || a.auftrag.kz.localeCompare(b.auftrag.kz))
    // Wert Std. as a number so Excel can sum it; the rest exactly as in DATEV.
    .forEach(r => data.push([r.std, ...datevLine(r, cfg).slice(1), r.auftrag.kz, r.min]));
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [{ wch: 9 }, { wch: 11 }, { wch: 9 }, { wch: 12 }, { wch: 6 }, { wch: 5 }, { wch: 13 },
    { wch: 11 }, { wch: 8 }, { wch: 50 }, { wch: 12 }, { wch: 8 }];
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'DATEV-Zeiten');
  if (unassigned.length) {
    const ow = XLSX.utils.aoa_to_sheet([['Datum', 'Tätigkeit', 'Minuten'],
      ...unassigned.map(u => [fmtDayDE(u.day), u.label, u.min])]);
    XLSX.utils.book_append_sheet(wb, ow, 'Ohne Auftrag');
  }
  XLSX.writeFile(wb, 'datev_zeiten_' + from + '_bis_' + to + '.xlsx');
  toast('Exportiert: ' + rows.length + ' Zeilen' + (unassigned.length ? ' · ' + unassigned.length + ' ohne Auftrag' : ''));
}

/* ---------- Mitarbeiternummer im Menü ----------
   Same value as the field in the Aufträge dialog (cfg.mitarbeiter) — shown
   permanently at the top of the menu so it is set once and always visible. */
function refreshMenuMa() {
  const ma = loadCfg().mitarbeiter || '';
  if (document.activeElement !== $('menuMa')) $('menuMa').value = ma;
  $('menuMa').classList.toggle('missing', !ma);
  $('menuMaHint').classList.toggle('missing', !ma);
  $('menuMaHint').textContent = ma ? '↳ steht in jeder Zeile der DATEV-Liste' : '↳ bitte eintragen — fehlt sonst in der DATEV-Liste';
}
function saveMenuMa() {
  const v = $('menuMa').value.trim();
  const c = loadCfg();
  if (v === (c.mitarbeiter || '')) return;
  c.mitarbeiter = v; saveCfg(c); refreshMenuMa();
  toast(v ? 'Mitarbeiternr. ' + v + ' gespeichert' : 'Mitarbeiternr. entfernt');
}

/* ---------- wiring (once, from main.js) ---------- */
export function wireAuftraege() {
  $('menuBtn').addEventListener('click', refreshMenuMa);
  $('menuMa').addEventListener('change', saveMenuMa);
  $('menuMa').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('menuMa').blur(); } });
  window.addEventListener('viertel:changed', refreshMenuMa);   // e.g. set in the Aufträge dialog
  refreshMenuMa();
  $('auftrBtn').onclick = openAuftraege;
  $('auftrClose').onclick = () => { saveSettings(); close('auftrScrim'); render(); };
  $('auftrAdd').onclick = addFromForm;
  COLS.forEach(([f]) => $('auftrNew_' + f).addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addFromForm(); }
  }));
  $('auftrImport').onclick = importPaste;
  $('auftrFileBtn').onclick = () => $('auftrFile').click();
  $('auftrFile').onchange = e => { const f = e.target.files[0]; if (f) readImportFile(f); };
  $('auftrMapHead').onchange = () => openMapping(+$('auftrMapHead').value);
  $('auftrMapPos').addEventListener('input', previewMapping);
  $('auftrMapGo').onclick = runImport;
  $('auftrMapCancel').onclick = closeMapping;
  $('auftrFilter').addEventListener('input', renderAuftrTable);
  $('auftrCopy').onclick = copyList;
  $('auftrMa').addEventListener('change', saveSettings);
  $('auftrRound').addEventListener('change', saveSettings);

  $('datevListBtn').onclick = () => openDatevListe(localDay(new Date()));
  $('datevListMenu').onclick = () => openDatevListe(localDay(new Date()));
  $('dvPrev').onclick = () => shiftDay(-1);
  $('dvNext').onclick = () => shiftDay(1);
  $('dvToday').onclick = () => { dvDay = localDay(new Date()); renderDatev(); };
  $('dvDate').addEventListener('change', () => { if ($('dvDate').value) { dvDay = $('dvDate').value; renderDatev(); } });
  $('dvClose').onclick = () => close('datevScrim');
  $('dvXlsx').onclick = exportDatevXlsx;
  $('dvToAuftr').onclick = () => { close('datevScrim'); openAuftraege(); };
}
