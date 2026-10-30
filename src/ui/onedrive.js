// OneDrive/SharePoint-Ablage — DOM + File System Access layer over the pure
// src/onedrive.js.
//
// HOW IT WORKS:
//   * "Meine Zeiten": the user picks a folder in their OneDrive (synced by the
//     OneDrive client). Viertel creates viertel-zeiten[-<MA-Nr>].json there,
//     writes it ~1 s after every change and reconciles it on start.
//   * "Zentrale Auftragsliste": the user picks the DATEV export one person
//     keeps in a SharePoint library. On every start Viertel re-reads it when
//     it changed and merges it with the saved column mapping.
//   * File handles live in IndexedDB. Chromium may ask again for access after
//     a restart — then a nudge bar offers the one-click confirmation (a
//     permission request needs a user gesture).
//   * Edge/Chrome only (File System Access API). Elsewhere the dialog says so
//     and Viertel keeps working browser-only.

import {
  readLocal, writeLocal, fingerprint, bundle, unbundle, planSync, mergeData, isEmpty, LAST_SYNC_KEY,
} from '../onedrive.js';
import {
  loadCfg, saveCfg, findHeaderRow, guessMapping, rowsToAuftraege, mergeImport, IMPORT_FIELDS,
} from '../auftraege.js';
import { syncFromStorage } from '../state.js';
import { $ } from './dom.js';
import { toast } from './notify.js';
import { render } from './calendar.js';
import { importRows } from './auftraege.js';

let openScrim = null;
export function initOneDrive(deps) { ({ openScrim } = deps); }

export const supported = () => typeof window.showDirectoryPicker === 'function';
const RELOAD_GUARD = 'viertel.syncReload';
const LAST_EXPORT_KEY = 'timelog.lastExport.v1';   // shared with main.js' export reminder

/* ---------- IndexedDB: remember the picked handles ---------- */
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('viertel', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('handles');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idbGet(k) {
  const db = await idb();
  return new Promise(res => { const q = db.transaction('handles').objectStore('handles').get(k); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); });
}
async function idbSet(k, v) {
  const db = await idb();
  return new Promise(res => { const t = db.transaction('handles', 'readwrite'); v == null ? t.objectStore('handles').delete(k) : t.objectStore('handles').put(v, k); t.oncomplete = () => res(); t.onerror = () => res(); });
}

let zeiten = null, liste = null;   // FileSystemFileHandle | null
let lastWrite = null, writeTimer = null, writing = false, lastError = '';

/* ---------- Meine Zeiten ---------- */
async function writeFile() {
  if (!zeiten || writing) return;
  writing = true;
  try {
    // another device may have written meanwhile — merge instead of overwriting
    const fileData = unbundle(await (await zeiten.getFile()).text());
    let local = readLocal();
    const last = localStorage.getItem(LAST_SYNC_KEY);
    if (!isEmpty(fileData) && fingerprint(fileData) !== last && fingerprint(fileData) !== fingerprint(local)) {
      local = mergeData(local, fileData);
      writeLocal(local);
      if (syncFromStorage()) render();
    }
    const w = await zeiten.createWritable();
    await w.write(JSON.stringify(bundle(local)));
    await w.close();
    localStorage.setItem(LAST_SYNC_KEY, fingerprint(local));
    localStorage.setItem(LAST_EXPORT_KEY, new Date().toISOString());   // a synced copy counts as a backup
    lastWrite = new Date(); lastError = '';
  } catch (e) {
    lastError = e && e.name === 'NotAllowedError' ? 'Zugriff nicht erlaubt' : 'Speichern fehlgeschlagen';
  } finally {
    writing = false; renderStatus();
  }
}
function scheduleWrite() {
  if (!zeiten) return;
  clearTimeout(writeTimer);
  writeTimer = setTimeout(writeFile, 1200);
}

/** Reconcile file and browser on start (or right after connecting). */
async function syncZeiten() {
  const text = await (await zeiten.getFile()).text();
  const fileData = text.trim() ? unbundle(text) : null;
  if (text.trim() && !fileData) { lastError = 'Die Datei ist keine Viertel-Datei'; renderStatus(); return; }
  const local = readLocal();
  const plan = planSync(local, fileData, localStorage.getItem(LAST_SYNC_KEY));
  if (plan.action === 'none') { localStorage.setItem(LAST_SYNC_KEY, fingerprint(local)); lastWrite = new Date((await zeiten.getFile()).lastModified); renderStatus(); return; }
  if (plan.action === 'write') { await writeFile(); return; }
  // load / merge: put the data into the browser, then restart cleanly once
  writeLocal(plan.data);
  localStorage.setItem(LAST_SYNC_KEY, fingerprint(plan.data));
  if (plan.action === 'merge') await writeFile();
  const t = +sessionStorage.getItem(RELOAD_GUARD) || 0;
  if (Date.now() - t > 15000) { sessionStorage.setItem(RELOAD_GUARD, String(Date.now())); location.reload(); }
  else if (syncFromStorage()) render();
}

async function connectZeiten() {
  try {
    const dir = await window.showDirectoryPicker({ id: 'viertel-zeiten', mode: 'readwrite', startIn: 'documents' });
    const ma = (loadCfg().mitarbeiter || '').replace(/[^\w-]/g, '');
    zeiten = await dir.getFileHandle(ma ? `viertel-zeiten-${ma}.json` : 'viertel-zeiten.json', { create: true });
    await idbSet('zeiten', zeiten);
    localStorage.removeItem(LAST_SYNC_KEY);   // a new file: compare content, not history
    await syncZeiten();
    toast('Verbunden: ' + zeiten.name);
  } catch (e) {
    if (e && e.name !== 'AbortError') toast('Ordner konnte nicht verbunden werden');
  }
  renderStatus();
}

/* ---------- Zentrale Auftragsliste ---------- */
async function refreshListe(force) {
  if (!liste) return;
  try {
    const file = await liste.getFile();
    const cfg = loadCfg();
    if (!force && cfg.centralSeen === file.lastModified) return;
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', codepage: 1252 });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
    const h = findHeaderRow(rows), header = rows[h] || [];
    const map = guessMapping(header);
    for (const [f] of IMPORT_FIELDS) {
      const i = (cfg.importMap || {})[f] ? header.findIndex(x => String(x).trim() === cfg.importMap[f]) : -1;
      if (i >= 0) map[f] = i;
    }
    if (IMPORT_FIELDS.some(([f, , req]) => req && map[f] === undefined)) {
      toast('Zentrale Auftragsliste: bitte Spalten einmal zuordnen');
      importRows(file.name, rows);
      return;
    }
    const res = mergeImport(cfg.list, rowsToAuftraege(rows, h, map, { pos: cfg.importPos || '' }), { prune: !!cfg.importPrune });
    cfg.list = res.list; cfg.centralSeen = file.lastModified; cfg.centralName = file.name;
    saveCfg(cfg); render();
    if (force || res.added || res.removed) toast('Auftragsliste aktualisiert: ' + res.added + ' neu' + (res.removed ? ', ' + res.removed + ' entfernt' : ''));
  } catch (e) {
    toast('Zentrale Auftragsliste konnte nicht gelesen werden');
  }
  renderStatus();
}

async function connectListe() {
  try {
    const [fh] = await window.showOpenFilePicker({
      id: 'viertel-liste', multiple: false,
      types: [{ description: 'DATEV-Auftragsliste (Excel/CSV)', accept: {
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
        'application/vnd.ms-excel': ['.xls'], 'text/csv': ['.csv'] } }],
    });
    liste = fh; await idbSet('liste', liste);
    await refreshListe(true);
  } catch (e) {
    if (e && e.name !== 'AbortError') toast('Datei konnte nicht verbunden werden');
  }
  renderStatus();
}

/* ---------- dialog + nudge ---------- */
const fmt = d => d ? d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

function renderStatus() {
  if (!$('syncScrim')) return;
  $('syncUnsupported').hidden = supported();
  $('syncBody').hidden = !supported();
  $('syncZStatus').textContent = zeiten
    ? zeiten.name + (lastError ? ' · ' + lastError : ' · zuletzt gespeichert ' + fmt(lastWrite))
    : 'Nicht verbunden — Zeiten liegen nur in diesem Browser.';
  $('syncZStatus').classList.toggle('warn', !!lastError);
  $('syncZDisconnect').hidden = !zeiten;
  const cfg = loadCfg();
  $('syncLStatus').textContent = liste
    ? liste.name + (cfg.centralSeen ? ' · Stand ' + fmt(new Date(cfg.centralSeen)) : '')
    : 'Nicht verbunden.';
  $('syncLRefresh').hidden = !liste;
  $('syncLDisconnect').hidden = !liste;
  $('syncPrune').checked = !!cfg.importPrune;
  $('syncBtn').textContent = '☁ OneDrive-Ablage' + (zeiten ? ' · verbunden' : '');
}

async function needsPermission(h) {
  return h && (await h.queryPermission({ mode: h === zeiten ? 'readwrite' : 'read' })) !== 'granted';
}

async function confirmAccess() {
  try {
    if (zeiten && (await zeiten.requestPermission({ mode: 'readwrite' })) === 'granted') await syncZeiten();
    if (liste && (await liste.requestPermission({ mode: 'read' })) === 'granted') await refreshListe(false);
  } catch (e) { /* user declined */ }
  $('syncNudge').hidden = !((await needsPermission(zeiten)) || (await needsPermission(liste)));
  renderStatus();
}

export async function startOneDrive() {
  $('syncBtn').onclick = () => { renderStatus(); openScrim('syncScrim'); };
  $('syncZConnect').onclick = connectZeiten;
  $('syncZDisconnect').onclick = async () => { zeiten = null; await idbSet('zeiten', null); localStorage.removeItem(LAST_SYNC_KEY); renderStatus(); toast('Getrennt — die Datei in OneDrive bleibt erhalten'); };
  $('syncLConnect').onclick = connectListe;
  $('syncLRefresh').onclick = () => refreshListe(true);
  $('syncLDisconnect').onclick = async () => { liste = null; await idbSet('liste', null); renderStatus(); };
  $('syncPrune').onchange = () => { const c = loadCfg(); c.importPrune = $('syncPrune').checked; saveCfg(c); };
  $('syncNudgeGo').onclick = confirmAccess;
  window.addEventListener('viertel:changed', scheduleWrite);
  // write pending changes before the tab goes away
  document.addEventListener('visibilitychange', () => { if (document.hidden && writeTimer) { clearTimeout(writeTimer); writeFile(); } });
  if (!supported()) { renderStatus(); return; }
  try {
    zeiten = await idbGet('zeiten'); liste = await idbGet('liste');
  } catch (e) { zeiten = liste = null; }
  const ask = (await needsPermission(zeiten)) || (await needsPermission(liste));
  $('syncNudge').hidden = !ask;
  if (zeiten && !(await needsPermission(zeiten))) await syncZeiten();
  if (liste && !(await needsPermission(liste))) await refreshListe(false);
  renderStatus();
}
