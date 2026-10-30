// Unit assertions for the OneDrive layer's pure half (src/onedrive.js): the
// file bundle and the start-up decision between browser copy and file copy.
// Run with `node --test tests/onedrive.test.js`.
//
// onedrive.js → state.js touches localStorage/window at module init, so the
// same minimal stubs as in blocks.test.js go in first (dynamic import below).

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

function makeLocalStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
  };
}
globalThis.localStorage = makeLocalStorage();
globalThis.window = { matchMedia: () => ({ matches: false }) };

let O;
before(async () => { O = await import('../src/onedrive.js'); });

const blk = (h, label) => ({ start: `2026-10-29T${h}:00:00`, end: `2026-10-29T${h}:15:00`, label });
const data = (blocks, extra = {}) => ({
  'timelog.v1': { blocks, recentLabels: [], settings: { intervalMin: 15 }, savedAt: 1 },
  'timelog.auftraege.v1': { list: [], mitarbeiter: '100', rounding: 'up' },
  'timelog.datevDone.v1': {},
  ...extra,
});

test('bundle/unbundle round-trip; foreign files are rejected', () => {
  const d = data([blk('09', 'A x')]);
  assert.deepEqual(O.unbundle(JSON.stringify(O.bundle(d))), d);
  assert.equal(O.unbundle('{"foo":1}'), null);
  assert.equal(O.unbundle('kein json'), null);
});

test('fingerprint ignores savedAt and key order', () => {
  const a = data([blk('09', 'A x')]);
  const b = JSON.parse(JSON.stringify(a)); b['timelog.v1'].savedAt = 999;
  const c = { 'timelog.datevDone.v1': {}, 'timelog.auftraege.v1': { rounding: 'up', mitarbeiter: '100', list: [] }, 'timelog.v1': a['timelog.v1'] };
  assert.equal(O.fingerprint(a), O.fingerprint(b));
  assert.equal(O.fingerprint(a), O.fingerprint(c));
  assert.notEqual(O.fingerprint(a), O.fingerprint(data([blk('10', 'A x')])));
});

test('planSync: empty file → write; empty browser (wiped profile) → load', () => {
  const d = data([blk('09', 'A x')]);
  assert.equal(O.planSync(d, null, null).action, 'write');
  assert.equal(O.planSync({}, d, null).action, 'load');
  assert.equal(O.planSync({}, null, null).action, 'none');
});

test('planSync: whoever changed since the last sync wins', () => {
  const base = data([blk('09', 'A x')]);
  const moved = data([blk('09', 'A x'), blk('10', 'B y')]);
  const last = O.fingerprint(base);
  assert.equal(O.planSync(base, moved, last).action, 'load');    // file moved on (other device)
  assert.equal(O.planSync(moved, base, last).action, 'write');   // browser moved on
  assert.equal(O.planSync(moved, moved, last).action, 'none');
});

test('planSync: both changed → merge keeps every block, ticks and Aufträge', () => {
  const base = data([blk('09', 'A x')]);
  const local = data([blk('09', 'A x'), blk('10', 'B y')], {
    'timelog.auftraege.v1': { list: [{ kz: 'A' }], mitarbeiter: '100' },
    'timelog.datevDone.v1': { '2026-10-29|A': 0.25 },
  });
  const file = data([blk('09', 'A x'), blk('11', 'C z')], {
    'timelog.auftraege.v1': { list: [{ kz: 'a' }, { kz: 'C' }], mitarbeiter: '100' },
    'timelog.datevDone.v1': { '2026-10-28|C': 1 },
  });
  const plan = O.planSync(local, file, O.fingerprint(base));
  assert.equal(plan.action, 'merge');
  assert.deepEqual(plan.data['timelog.v1'].blocks.map(b => b.label), ['A x', 'B y', 'C z']);
  assert.deepEqual(plan.data['timelog.auftraege.v1'].list.map(a => a.kz), ['A', 'C']);
  assert.deepEqual(Object.keys(plan.data['timelog.datevDone.v1']).sort(), ['2026-10-28|C', '2026-10-29|A']);
});

test('readLocal/writeLocal round-trip through storage', () => {
  const store = makeLocalStorage();
  const d = data([blk('09', 'A x')]);
  O.writeLocal(d, store);
  assert.deepEqual(O.readLocal(store), d);
  O.writeLocal({ ...d, 'timelog.datevDone.v1': null }, store);
  assert.equal(store.getItem('timelog.datevDone.v1'), null);
});
