// Auftragsliste + DATEV-Zeitenliste (Eigenorganisation comfort) — the pure,
// DOM-free layer behind the Aufträge dialog and the DATEV-Liste.
//
// DATA MODEL (keep this true):
//   * A block stays { start, end, label }. The Auftrag is NOT a new block field —
//     it is the label's FIRST WORD, matched (case-insensitive) against the
//     Kürzel of the Auftragsliste: "10023-JA-25 Anlagenspiegel abgestimmt" →
//     Auftrag 10023-JA-25, Kommentar "Anlagenspiegel abgestimmt". That way the
//     multi-tab merge, mergeRuns, the Excel round-trip and "Weiter wie eben"
//     keep working unchanged, and a label stays readable on its own.
//   * The Auftragsliste and the per-row "in DATEV erfasst" ticks live under
//     their own localStorage keys (mirroring the heartbeat/skip stores), so
//     they never leak into the Excel export of the time data. Both are re-read
//     on every access — tiny payloads, and a change in one tab shows up in the
//     next render of another.
//
// DATEV mapping (Zeiten und Kosten Erfassung): Wert Std. · Datum · Mandant ·
// Auftragsart · VJ · TA · Aufwandspos. · Mitarbeiter · Abr.bar · Kommentar.

import { blockDurMin } from './time.js';
import { signalChange } from './changed.js';

export const AUFTR_KEY = 'timelog.auftraege.v1';
export const DONE_KEY = 'timelog.datevDone.v1';
const DONE_RETENTION_DAYS = 120;

/** Fields of one Auftrag in DATEV column order (after the Kürzel/Bezeichnung). */
export const AUFTR_FIELDS = ['kz', 'name', 'mandant', 'art', 'vj', 'ta', 'pos', 'abr'];
export const AUFTR_HEAD = ['Kürzel', 'Bezeichnung', 'Mandant', 'Auftragsart', 'VJ', 'TA', 'Aufwandspos.', 'Abr.bar'];

function defaultCfg() { return { list: [], mitarbeiter: '', rounding: 'up' }; }

/* ---------- storage ---------- */
export function loadCfg() {
  try {
    const c = JSON.parse(localStorage.getItem(AUFTR_KEY));
    if (c && Array.isArray(c.list)) return Object.assign(defaultCfg(), c);
  } catch (e) { /* corrupt → fresh */ }
  return defaultCfg();
}
export function saveCfg(cfg) {
  try { localStorage.setItem(AUFTR_KEY, JSON.stringify(cfg)); signalChange(); return true; } catch (e) { return false; }
}
/** The current list, parsed once per stored payload — cheap enough to call
    per rendered block (colorFor). */
let _rawSeen = null, _listSeen = [];
export function auftragList() {
  let raw = null;
  try { raw = localStorage.getItem(AUFTR_KEY); } catch (e) {}
  if (raw !== _rawSeen) { _rawSeen = raw; _listSeen = loadCfg().list; }
  return _listSeen;
}

/* ---------- Kürzel ---------- */
/** Kürzel are one word (no whitespace), compared case-insensitively. */
export function normKz(kz) { return String(kz || '').trim().replace(/\s+/g, '-'); }
export function findAuftrag(list, kz) {
  const k = normKz(kz).toLowerCase();
  return k ? list.find(a => a.kz.toLowerCase() === k) || null : null;
}

/** Split a block label into its Auftrag (or null) and the free Kommentar. */
export function parseLabel(label, list) {
  const s = String(label || '').trim();
  const m = s.match(/^(\S+)(?:\s+(.*))?$/);
  if (!m) return { auftrag: null, kommentar: '' };
  const a = findAuftrag(list, m[1].replace(/[:,;]$/, ''));
  return a ? { auftrag: a, kommentar: (m[2] || '').trim() } : { auftrag: null, kommentar: s };
}

/** Normalise one Auftrag record (from the form or a pasted line). */
export function cleanAuftrag(a) {
  const t = v => String(v ?? '').trim();
  const abr = t(a.abr).toLowerCase();
  return {
    kz: normKz(a.kz), name: t(a.name), mandant: t(a.mandant), art: t(a.art),
    vj: t(a.vj), ta: t(a.ta), pos: t(a.pos),
    abr: !(abr === 'nein' || abr === 'n' || abr === '0' || abr === 'false' || a.abr === false),
    fav: a.fav !== false,
  };
}

/** Insert or replace (by Kürzel) — returns the new list, input untouched. */
export function upsertAuftrag(list, a) {
  const rec = cleanAuftrag(a);
  if (!rec.kz) return list;
  const i = list.findIndex(x => x.kz.toLowerCase() === rec.kz.toLowerCase());
  if (i < 0) return [...list, rec];
  const out = [...list]; out[i] = { ...rec, fav: list[i].fav }; return out;
}

/** Parse a pasted list (Excel copy = tab-separated, or semicolon CSV) in
    AUFTR_HEAD order. A header line (first cell "Kürzel") is skipped. */
export function parseAuftragText(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const cells = raw.split(raw.includes('\t') ? '\t' : ';').map(c => c.trim().replace(/^"(.*)"$/, '$1'));
    if (/^k(ü|ue)rzel$/i.test(cells[0])) continue;
    const rec = {};
    AUFTR_FIELDS.forEach((f, i) => { rec[f] = cells[i] ?? ''; });
    if (normKz(rec.kz)) out.push(cleanAuftrag(rec));
  }
  return out;
}
/* ---------- Import einer DATEV-Auftragsliste (Excel/CSV) ----------
   Workaround until the DATEV Prüfdatei can be read: any table export that has
   one row per Auftrag. The user maps columns once (auto-guessed from the
   header names); the mapping is kept in cfg.importMap for the next import. */

/** Target fields of an import, in the order the mapping dialog shows them. */
export const IMPORT_FIELDS = [
  ['mandant', 'Mandantennummer', true],
  ['mname', 'Mandantenname', false],
  ['art', 'Auftragsart', true],
  ['vj', 'VJ / Jahr', false],
  ['ta', 'Teilauftrag', false],
  ['pos', 'Aufwandsposition', false],
  ['bez', 'Auftragsbezeichnung', false],
];
const GUESS = {
  mandant: [/^mandant(en)?(-?nr|-?nummer|nummer)?\.?$/, /^mdt\.?(-?nr\.?)?$/, /mandant.*n(r|ummer)/],
  mname: [/mandant.*name/, /^name$/, /^mandant(en)?bezeichnung$/, /kurzname/],
  art: [/auftragsart/, /^art$/, /^aa$/],
  vj: [/^vj$/, /veranlagungsjahr/, /^jahr$/, /wirtschaftsjahr/, /^wj$/],
  ta: [/teilauftrag/, /^ta$/],
  pos: [/aufwand/, /leistungsart/, /^pos/],
  bez: [/auftrag.*bez/, /^bezeichnung$/, /^auftrag$/],
};

/** First row that looks like column names: ≥ 3 cells with letters, and the
    row below it is not empty. Title rows above (report name, date) are skipped. */
export function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length - 1, 25); i++) {
    const cells = (rows[i] || []).map(c => String(c ?? '').trim());
    const words = cells.filter(c => /[A-Za-zÄÖÜäöü]/.test(c) && !/^\d/.test(c));
    if (words.length >= 3 && words.length >= cells.filter(Boolean).length * 0.6
        && (rows[i + 1] || []).some(c => String(c ?? '').trim())) return i;
  }
  return 0;
}

/** { field: columnIndex } from header names; each column used at most once. */
export function guessMapping(header) {
  const norm = header.map(h => String(h ?? '').trim().toLowerCase().replace(/[\s_]+/g, ''));
  const map = {}, used = new Set();
  for (const [f] of IMPORT_FIELDS) {
    for (const re of GUESS[f]) {
      const i = norm.findIndex((h, j) => h && !used.has(j) && re.test(h));
      if (i >= 0) { map[f] = i; used.add(i); break; }
    }
  }
  return map;
}

/** Stable identity of a DATEV Auftrag (independent of the Kürzel). */
export function auftragKey(a) {
  return [a.mandant, a.art, a.vj, a.ta].map(v => String(v ?? '').trim().toLowerCase()).join('|');
}
/** Generated Kürzel: Mandant-Art-JJ[-TA], e.g. 10023-JA-25 — numbers only, so
    a block label never carries a Mandantenname. */
export function autoKz(a) {
  const vj = String(a.vj || '').trim();
  return normKz([a.mandant, a.art, vj.length === 4 ? vj.slice(2) : vj, a.ta].filter(Boolean).join('-'));
}

/** Table rows → Auftrag records. Rows without Mandant or Auftragsart are
    skipped; duplicates (same Mandant/Art/VJ/TA) collapse into one. */
export function rowsToAuftraege(rows, headerRow, map, defaults = {}) {
  const get = (r, f) => map[f] === undefined || map[f] === '' ? '' : String(r[map[f]] ?? '').trim();
  const seen = new Map();
  for (const r of rows.slice(headerRow + 1)) {
    const rec = { mandant: get(r, 'mandant'), art: get(r, 'art'), vj: get(r, 'vj'), ta: get(r, 'ta'),
      pos: get(r, 'pos') || defaults.pos || '' };
    if (!rec.mandant || !rec.art) continue;
    rec.name = [get(r, 'mname'), get(r, 'bez')].filter(Boolean).join(' · ');
    rec.kz = autoKz(rec); rec.abr = true; rec.fav = false;
    const k = auftragKey(rec);
    if (!seen.has(k)) seen.set(k, cleanAuftrag(rec));
  }
  return [...seen.values()];
}

/** Merge an import into the list. An Auftrag already present (same
    Mandant/Art/VJ/TA) keeps its Kürzel, favourite flag and Abr.-Haken; its
    DATEV fields are refreshed. With prune, Aufträge missing from the import
    are dropped — except favourites, which stay until removed by hand. */
export function mergeImport(list, recs, { prune = false } = {}) {
  const byKey = new Map(list.map(a => [auftragKey(a), a]));
  const out = [], taken = new Set();
  let added = 0, updated = 0;
  for (const r of recs) {
    const old = byKey.get(auftragKey(r));
    if (old) {
      out.push({ ...r, kz: old.kz, fav: old.fav, abr: old.abr, pos: r.pos || old.pos });
      updated++;
    } else {
      // never let a generated Kürzel collide with a hand-made one
      let kz = r.kz, n = 2;
      while (list.some(a => a.kz.toLowerCase() === kz.toLowerCase() && auftragKey(a) !== auftragKey(r))
             || out.some(a => a.kz.toLowerCase() === kz.toLowerCase())) kz = r.kz + '-' + n++;
      out.push({ ...r, kz }); added++;
    }
    taken.add(auftragKey(r));
  }
  let removed = 0;
  for (const a of list) {
    if (taken.has(auftragKey(a))) continue;
    if (prune && !a.fav) { removed++; continue; }
    out.push(a);
  }
  return { list: out, added, updated, removed };
}

/** The list as tab-separated text (pastes straight into Excel). */
export function auftragText(list) {
  const rows = [AUFTR_HEAD, ...list.map(a => AUFTR_FIELDS.map(f => f === 'abr' ? (a.abr ? 'ja' : 'nein') : a[f]))];
  return rows.map(r => r.join('\t')).join('\r\n');
}

/* ---------- Abrechnungstakt 0,25 h ---------- */
/** Minutes → billable hours in 0,25 steps. 'up' = jede angefangene
    Viertelstunde; 'nearest' = kaufmännisch, aber nie 0 für erfasste Zeit. */
export function roundQuarter(min, mode = 'up') {
  if (!(min > 0)) return 0;
  const q = min / 15;
  const n = mode === 'nearest' ? Math.max(1, Math.round(q - 1e-9)) : Math.ceil(q - 1e-9);
  return n * 0.25;
}
export function fmtStd(h) { return h.toFixed(2).replace('.', ','); }

/* ---------- DATEV-Liste ---------- */
/** Aggregate blocks per (start day, Auftrag). Unassigned labels per day are
    returned separately so the UI can flag them instead of dropping time.
    Blocks are bucketed under their START day (same rule as the Lohn export). */
export function datevRows(blocks, cfg) {
  const rows = new Map(), open = new Map();
  const sorted = [...blocks].sort((a, b) => new Date(a.start) - new Date(b.start));
  for (const b of sorted) {
    const day = localDay(new Date(b.start));
    const { auftrag, kommentar } = parseLabel(b.label, cfg.list);
    const min = blockDurMin(b);
    if (!auftrag) {
      const k = day + '|' + b.label;
      const o = open.get(k) || { day, label: b.label, min: 0 };
      o.min += min; open.set(k, o); continue;
    }
    const k = day + '|' + auftrag.kz;
    const r = rows.get(k) || { key: k, day, auftrag, min: 0, kommentare: [] };
    r.min += min;
    if (kommentar && !r.kommentare.includes(kommentar)) r.kommentare.push(kommentar);
    rows.set(k, r);
  }
  return {
    rows: [...rows.values()].map(r => ({
      ...r, std: roundQuarter(r.min, cfg.rounding), kommentar: r.kommentare.join('; '),
    })),
    unassigned: [...open.values()],
  };
}

/** One row in the exact field order of the DATEV Erfassungszeile. */
export function datevLine(r, cfg) {
  const a = r.auftrag;
  return [fmtStd(r.std), fmtDayDE(r.day), a.mandant, a.art, a.vj, a.ta, a.pos,
    cfg.mitarbeiter, a.abr ? 'ja' : 'nein', r.kommentar];
}
export const DATEV_HEAD = ['Wert Std.', 'Datum', 'Mandant', 'Auftragsart', 'VJ', 'TA',
  'Aufwandspos.', 'Mitarbeiter', 'Abr.bar', 'Kommentar'];

/* ---------- "in DATEV erfasst" ticks ----------
   { "YYYY-MM-DD|KZ": std at the moment of ticking }. Keeping the hours lets
   the list flag a row whose time grew/shrank AFTER it was entered in DATEV. */
export function loadDone() {
  try {
    const o = JSON.parse(localStorage.getItem(DONE_KEY));
    if (o && typeof o === 'object' && !Array.isArray(o)) return o;
  } catch (e) {}
  return {};
}
export function setDone(key, std, now = new Date()) {
  const o = loadDone();
  if (std === null) delete o[key]; else o[key] = std;
  const cutoff = localDay(new Date(now.getTime() - DONE_RETENTION_DAYS * 86400000));
  for (const k of Object.keys(o)) if (k.slice(0, 10) < cutoff) delete o[k];
  try { localStorage.setItem(DONE_KEY, JSON.stringify(o)); signalChange(); } catch (e) {}
}

/* ---------- date helpers (local calendar day, not UTC) ---------- */
export function localDay(d) {
  const z = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate());
}
export function fmtDayDE(day) { const [y, m, d] = day.split('-'); return d + '.' + m + '.' + y; }
