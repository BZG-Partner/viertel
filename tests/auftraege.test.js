// Unit assertions for the Auftrag/DATEV layer (src/auftraege.js): Kürzel
// parsing, 0,25-h rounding and the per-day aggregation behind the DATEV-Liste.
// Pure ESM — run with `node --test tests/auftraege.test.js`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { iso } from '../src/time.js';
import {
  parseLabel, roundQuarter, fmtStd, datevRows, datevLine, parseAuftragText,
  upsertAuftrag, auftragText, cleanAuftrag,
} from '../src/auftraege.js';
import * as I from '../src/auftraege.js';

const LIST = [
  cleanAuftrag({ kz: 'MUE-JA25', name: 'Jahresabschluss', mandant: '10023', art: 'JA', vj: '2025', ta: '', pos: '100', abr: 'ja' }),
  cleanAuftrag({ kz: 'INTERN', name: 'Kanzlei intern', mandant: '99999', art: 'INT', vj: '2026', ta: '', pos: '900', abr: 'nein' }),
];
const cfg = { list: LIST, mitarbeiter: '100', rounding: 'up' };
const at = (h, m = 0, d = 29) => new Date(2026, 9, d, h, m, 0);
const blk = (s, e, label) => ({ start: iso(s), end: iso(e), label });

test('parseLabel: first word is the Kürzel, case-insensitive, rest is the comment', () => {
  const r = parseLabel('mue-ja25 Anlagenspiegel abgestimmt', LIST);
  assert.equal(r.auftrag.kz, 'MUE-JA25');
  assert.equal(r.kommentar, 'Anlagenspiegel abgestimmt');
  assert.equal(parseLabel('MUE-JA25: Telefonat', LIST).kommentar, 'Telefonat');
  assert.equal(parseLabel('INTERN', LIST).kommentar, '');
});

test('parseLabel: unknown first word → no Auftrag, whole label is the comment', () => {
  const r = parseLabel('Telefonat mit MUE-JA25', LIST);
  assert.equal(r.auftrag, null);
  assert.equal(r.kommentar, 'Telefonat mit MUE-JA25');
});

test('roundQuarter: up = jede angefangene Viertelstunde', () => {
  assert.equal(roundQuarter(0), 0);
  assert.equal(roundQuarter(6), 0.25);
  assert.equal(roundQuarter(15), 0.25);
  assert.equal(roundQuarter(16), 0.5);
  assert.equal(roundQuarter(60), 1);
  assert.equal(roundQuarter(66), 1.25);
});

test('roundQuarter: nearest = kaufmännisch, never 0 for logged time', () => {
  assert.equal(roundQuarter(6, 'nearest'), 0.25);
  assert.equal(roundQuarter(20, 'nearest'), 0.25);
  assert.equal(roundQuarter(23, 'nearest'), 0.5);
  assert.equal(roundQuarter(66, 'nearest'), 1);
});

test('fmtStd: German decimal comma, two places', () => {
  assert.equal(fmtStd(1.25), '1,25');
  assert.equal(fmtStd(0.5), '0,50');
});

test('datevRows: sums per day + Auftrag, rounds the SUM, joins distinct comments', () => {
  const blocks = [
    blk(at(9), at(9, 10), 'MUE-JA25 Belege'),
    blk(at(9, 10), at(9, 20), 'MUE-JA25 Belege'),
    blk(at(11), at(11, 10), 'MUE-JA25 Telefonat'),
    blk(at(12), at(12, 30), 'INTERN Teamrunde'),
    blk(at(13), at(13, 15), 'Mittag'),
    blk(at(9, 0, 30), at(10, 0, 30), 'MUE-JA25 Belege'),   // next day
  ];
  const { rows, unassigned } = datevRows(blocks, cfg);
  const mue = rows.find(r => r.day === '2026-10-29' && r.auftrag.kz === 'MUE-JA25');
  assert.equal(mue.min, 30);
  assert.equal(mue.std, 0.5);                       // 30 min → 0,50 (not 3 × 0,25)
  assert.equal(mue.kommentar, 'Belege; Telefonat');
  assert.equal(rows.filter(r => r.auftrag.kz === 'MUE-JA25').length, 2);
  assert.deepEqual(unassigned.map(u => [u.label, u.min]), [['Mittag', 15]]);
});

test('datevLine: exact DATEV field order', () => {
  const { rows } = datevRows([blk(at(12), at(12, 30), 'INTERN Teamrunde')], cfg);
  assert.deepEqual(datevLine(rows[0], cfg),
    ['0,50', '29.10.2026', '99999', 'INT', '2026', '', '900', '100', 'nein', 'Teamrunde']);
});

test('parseAuftragText: Excel paste (tabs) with header, and semicolon CSV', () => {
  const tsv = 'Kürzel\tBezeichnung\tMandant\tAuftragsart\tVJ\tTA\tAufwandspos.\tAbr.bar\n'
    + 'ABC-LST\tLohn\t10044\tLST\t2026\t\t200\tja\n\n';
  const r = parseAuftragText(tsv);
  assert.equal(r.length, 1);
  assert.equal(r[0].kz, 'ABC-LST');
  assert.equal(r[0].abr, true);
  const csv = parseAuftragText('X Y;Name;1;A;2026;;1;nein');
  assert.equal(csv[0].kz, 'X-Y');                    // Kürzel collapse to one word
  assert.equal(csv[0].abr, false);
});

test('upsertAuftrag replaces by Kürzel (case-insensitive) and keeps the favourite flag', () => {
  const l1 = [{ ...LIST[0], fav: false }];
  const l2 = upsertAuftrag(l1, { kz: 'mue-ja25', mandant: '1', art: 'JA' });
  assert.equal(l2.length, 1);
  assert.equal(l2[0].mandant, '1');
  assert.equal(l2[0].fav, false);
  assert.equal(upsertAuftrag(l1, { kz: '' }), l1);
});

test('auftragText round-trips through parseAuftragText', () => {
  const back = parseAuftragText(auftragText(LIST));
  assert.deepEqual(back.map(a => [a.kz, a.mandant, a.pos, a.abr]), LIST.map(a => [a.kz, a.mandant, a.pos, a.abr]));
});

/* ---------- Import einer DATEV-Auftragsliste ---------- */
const EXPORT = [
  ['Auftragsübersicht', '', '', '', ''],          // title row
  ['Stand 29.10.2026', '', '', '', ''],
  ['Mandanten-Nr.', 'Mandantenname', 'Auftragsart', 'VJ', 'Teilauftrag'],
  ['10023', 'Testmandant A', 'JA', '2025', ''],
  ['10023', 'Testmandant A', 'JA', '2025', ''],     // duplicate → one Auftrag
  ['10044', 'Testmandant B', 'ESt', '2025', '2'],
  ['', 'Summe', '', '', ''],                         // no Mandant → skipped
];

test('findHeaderRow skips title rows above the column names', () => {
  assert.equal(I.findHeaderRow(EXPORT), 2);
});

test('guessMapping recognises typical DATEV header names', () => {
  assert.deepEqual(I.guessMapping(EXPORT[2]), { mandant: 0, mname: 1, art: 2, vj: 3, ta: 4 });
});

test('rowsToAuftraege builds numeric Kürzel, dedupes, skips rows without Mandant', () => {
  const recs = I.rowsToAuftraege(EXPORT, 2, I.guessMapping(EXPORT[2]), { pos: '100' });
  assert.deepEqual(recs.map(r => r.kz), ['10023-JA-25', '10044-ESt-25-2']);
  assert.equal(recs[0].pos, '100');
  assert.equal(recs[0].fav, false);                  // imports never flood the ping with favourites
  assert.equal(recs[1].name, 'Testmandant B');
});

test('mergeImport keeps Kürzel, favourite and Abr. of known Aufträge; prune spares favourites', () => {
  const list = [
    { ...cleanAuftrag({ kz: 'A-JA25', mandant: '10023', art: 'JA', vj: '2025', pos: '100' }), fav: true, abr: false },
    { ...cleanAuftrag({ kz: 'ALT', mandant: '1', art: 'X', vj: '2020' }), fav: false },
    { ...cleanAuftrag({ kz: 'FAV-ALT', mandant: '2', art: 'X', vj: '2020' }), fav: true },
  ];
  const recs = I.rowsToAuftraege(EXPORT, 2, I.guessMapping(EXPORT[2]));
  const res = I.mergeImport(list, recs, { prune: true });
  const a = res.list.find(x => x.mandant === '10023');
  assert.equal(a.kz, 'A-JA25');
  assert.equal(a.fav, true);
  assert.equal(a.abr, false);
  assert.equal(a.pos, '100');                        // no pos in the import → old one stays
  assert.deepEqual([res.added, res.updated, res.removed], [1, 1, 1]);
  assert.ok(res.list.some(x => x.kz === 'FAV-ALT'));
  assert.ok(!res.list.some(x => x.kz === 'ALT'));
});

test('mergeImport never reuses a hand-made Kürzel for a different Auftrag', () => {
  const list = [cleanAuftrag({ kz: '10023-JA-25', mandant: '99', art: 'Y', vj: '' })];
  const recs = I.rowsToAuftraege(EXPORT, 2, I.guessMapping(EXPORT[2]));
  const res = I.mergeImport(list, recs);
  assert.ok(res.list.some(x => x.kz === '10023-JA-25-2' && x.mandant === '10023'));
});
