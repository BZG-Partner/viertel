// OneDrive/SharePoint-Ablage — the pure, DOM-free half: what goes into the
// synced file, and what to do when the file and the browser disagree.
//
// MODEL (keep this true):
//   * The browser's localStorage stays the working copy (fast, offline, the
//     multi-tab merge in state.js keeps working). The file in a OneDrive /
//     SharePoint-synced folder is the durable copy: written after every
//     change, read on start. A wiped browser profile (e.g. a rebuilt
//     remote-desktop session) is therefore restored from the file.
//   * Only the user's own data is bundled: time blocks, Auftragsliste incl.
//     favourites/settings, and the "in DATEV erfasst" ticks.
//   * Conflict rule: whoever changed since the last sync wins; if BOTH changed
//     (two devices), the time blocks are merged as a union — a block is never
//     lost, at worst a deleted one comes back.

import { mergeStates } from './state.js';

export const SYNC_KEYS = ['timelog.v1', 'timelog.auftraege.v1', 'timelog.datevDone.v1'];
export const LAST_SYNC_KEY = 'timelog.onedriveSync.v1';
export const FILE_APP = 'viertel';

/** Parsed localStorage values for SYNC_KEYS (missing keys → null). */
export function readLocal(storage = localStorage) {
  const data = {};
  for (const k of SYNC_KEYS) {
    try { data[k] = JSON.parse(storage.getItem(k)); } catch (e) { data[k] = null; }
  }
  return data;
}

/** JSON with sorted object keys — two equal payloads always give the same
    string, whatever order their keys were written in. */
function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined)
      .map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  }
  return JSON.stringify(v ?? null);
}

/** Content fingerprint: ignores the per-save timestamp so an unchanged
    payload hashes the same after every save. FNV-1a, 32 bit. */
export function fingerprint(data) {
  const clean = { ...data };
  if (clean['timelog.v1']) { const { savedAt, ...rest } = clean['timelog.v1']; clean['timelog.v1'] = rest; }
  const s = stable(clean);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}

export function isEmpty(data) {
  return !data || SYNC_KEYS.every(k => data[k] == null);
}

/** The file payload. */
export function bundle(data, now = new Date()) {
  return { app: FILE_APP, version: 1, savedAt: now.toISOString(), data };
}
/** File text → data, or null if it is not a Viertel file. */
export function unbundle(text) {
  try {
    const b = JSON.parse(text);
    return b && b.app === FILE_APP && b.data ? b.data : null;
  } catch (e) { return null; }
}

/** Decide what to do on start.
    → { action: 'none' | 'write' | 'load' | 'merge', data? } */
export function planSync(local, file, lastSync) {
  if (isEmpty(file)) return { action: isEmpty(local) ? 'none' : 'write' };
  if (isEmpty(local)) return { action: 'load', data: file };
  const lf = fingerprint(local), ff = fingerprint(file);
  if (lf === ff) return { action: 'none' };
  if (lf === lastSync) return { action: 'load', data: file };      // only the file moved on
  if (ff === lastSync) return { action: 'write' };                  // only this browser moved on
  return { action: 'merge', data: mergeData(local, file) };
}

/** Both sides changed: union of blocks (local wins a slot conflict),
    Auftragsliste = local entries + file-only entries, ticks = union. */
export function mergeData(local, file) {
  const out = { ...local };
  const L = local['timelog.v1'], F = file['timelog.v1'];
  if (L && F) {
    const empty = { blocks: [], recentLabels: [], settings: {} };
    const m = mergeStates(empty, L, F, false);
    out['timelog.v1'] = { ...m, savedAt: Math.max(L.savedAt || 0, F.savedAt || 0) };
  } else out['timelog.v1'] = L || F;
  const LA = local['timelog.auftraege.v1'], FA = file['timelog.auftraege.v1'];
  if (LA && FA) {
    const have = new Set(LA.list.map(a => a.kz.toLowerCase()));
    out['timelog.auftraege.v1'] = { ...FA, ...LA, list: [...LA.list, ...FA.list.filter(a => !have.has(a.kz.toLowerCase()))] };
  } else out['timelog.auftraege.v1'] = LA || FA;
  out['timelog.datevDone.v1'] = { ...(file['timelog.datevDone.v1'] || {}), ...(local['timelog.datevDone.v1'] || {}) };
  return out;
}

/** Write data back into localStorage (all SYNC_KEYS; null removes). */
export function writeLocal(data, storage = localStorage) {
  for (const k of SYNC_KEYS) {
    if (data[k] == null) storage.removeItem(k);
    else storage.setItem(k, JSON.stringify(data[k]));
  }
}
