"""Zeigt den AUFBAU von DATEV-Exporten (.exp, .csv, .xlsx, ZIP), ohne Inhalte.

Gedacht für die Prüfdateien aus „Zeiten und Kosten Erfassung“ und für
Auftragslisten. Ausgegeben werden nur Struktur-Merkmale:
  * Dateityp (Text / INI / ZIP / Excel / binär), Kodierung, Trennzeichen
  * Spaltenüberschriften bzw. INI-Abschnitte und Schlüssel
  * je Feld: Anzahl befüllter / verschiedener Werte und die "Form" von Nummern
    und kurzen Codes (Ziffer -> 9, Großbuchstabe -> A, Kleinbuchstabe -> a)
  * alles andere nur als "Text, Länge x-y" — Namen erscheinen nie.
Bitte die Ausgabe trotzdem lesen, bevor du sie weitergibst.

Aufruf:  python scripts/datev-struktur.py                  (Dateiauswahl, mehrere möglich)
         python scripts/datev-struktur.py DATEI [DATEI …]   (auch ein Ordner)
Nur Python-Standardbibliothek, keine Installation nötig.
"""
import collections, csv, io, os, re, sys, zipfile
import xml.etree.ElementTree as ET

NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
SHORT = 10   # values up to this length may be shown as their shape


def is_code(v):
    """Only number-like values and short codes (<= 4 chars, e.g. 'JA', 'ESt')
    are shown as a shape. Anything else counts as text — so a short name like
    'Max Muster' never shows up, not even as a letter pattern."""
    return len(v) <= SHORT and (bool(re.search(r'\d', v)) or len(v) <= 4)


def shape(v):
    return re.sub(r'[a-zäöüß]', 'a', re.sub(r'[A-ZÄÖÜ]', 'A', re.sub(r'\d', '9', v)))


def describe(vals):
    """One line about a list of values — shapes for codes, length for text."""
    vals = [v.strip() for v in vals if v is not None and v.strip()]
    if not vals:
        return '(leer)'
    if all(is_code(v) for v in vals):
        shapes = sorted({shape(v) for v in vals})
        more = f' (+{len(shapes) - 5} weitere)' if len(shapes) > 5 else ''
        desc = 'Form: ' + ', '.join(shapes[:5]) + more
    else:
        lens = [len(v) for v in vals]
        desc = f'Text, Länge {min(lens)}-{max(lens)}'
    return f'{len(vals):>5} befüllt, {len(set(vals)):>5} verschieden  |  {desc}'


def label(h):
    """A header cell is printed only if it looks like a column NAME (letters,
    no digits-only, not too long) — otherwise just its shape."""
    h = (h or '').strip()
    if h and re.search(r'[A-Za-zÄÖÜäöü]', h) and len(h) <= 40:
        return h
    return f'<{describe([h]).split("|")[-1].strip()}>' if h else '<ohne Überschrift>'


# ---------- readers ----------
def decode(raw):
    for enc in ('utf-8-sig', 'cp1252'):
        try:
            return raw.decode(enc), enc
        except UnicodeDecodeError:
            continue
    return raw.decode('latin-1'), 'latin-1'


def looks_binary(raw):
    sample = raw[:4096]
    if not sample:
        return False
    ctrl = sum(b < 9 or 13 < b < 32 for b in sample)
    return ctrl / len(sample) > 0.05


def xlsx_rows(data):
    z = zipfile.ZipFile(io.BytesIO(data))
    shared = []
    if 'xl/sharedStrings.xml' in z.namelist():
        for si in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('m:si', NS):
            shared.append(''.join(t.text or '' for t in si.iter('{%s}t' % NS['m'])))
    sheet = sorted(n for n in z.namelist() if re.match(r'xl/worksheets/sheet\d+\.xml$', n))[0]
    rows = []
    for r in ET.fromstring(z.read(sheet)).iter('{%s}row' % NS['m']):
        cells = {}
        for c in r.findall('m:c', NS):
            idx = 0
            for ch in re.match(r'[A-Z]+', c.get('r')).group():
                idx = idx * 26 + ord(ch) - 64
            v, t = c.find('m:v', NS), c.find('m:is/m:t', NS)
            val = (t.text if t is not None else v.text if v is not None else '') or ''
            if c.get('t') == 's' and val:
                val = shared[int(val)]
            cells[idx - 1] = val
        rows.append([cells.get(i, '') for i in range(max(cells) + 1)] if cells else [])
    return rows


# ---------- analysers ----------
def analyse_table(rows, out):
    rows = [r for r in rows if any(str(c).strip() for c in r)]
    if not rows:
        out('  Keine Daten.'); return
    # DATEV-Format: first line is a metadata header ("EXTF"/"DTVF"), the real
    # column names follow in line 2. Never print the metadata values.
    if rows[0] and str(rows[0][0]).strip().strip('"') in ('EXTF', 'DTVF'):
        out(f'  Zeile 1: DATEV-Metadaten ({rows[0][0]}), {len(rows[0])} Felder — Inhalt nicht angezeigt')
        rows = rows[1:]
    counts = collections.Counter(len(r) for r in rows)
    width = counts.most_common(1)[0][0]
    head, data = rows[0], rows[1:]
    # Row 1 counts as column names only if it is clearly NOT a data row: some
    # column must hold a word in row 1 but (almost) only numbers below it —
    # e.g. "Mandant" over 10023, 10044, … A data row put first would carry a
    # number there too, and is then never printed as a header.
    def numeric(v): return bool(re.fullmatch(r'\s*[\d.,/-]+\s*', str(v)))
    has_head = bool(data) and any(
        i < len(head) and re.search(r'[A-Za-zÄÖÜäöü]', str(head[i]))
        and sum(numeric(r[i]) for r in data if i < len(r) and str(r[i]).strip()) >= 0.8 * max(1, sum(1 for r in data if i < len(r) and str(r[i]).strip()))
        for i in range(width))
    if not has_head:
        head, data = [''] * width, rows
    out(f'  {len(data)} Datenzeilen, {width} Felder je Zeile'
        + ('' if len(counts) == 1 else f' (Zeilen mit abweichender Feldzahl: {sum(c for n, c in counts.items() if n != width)})')
        + ('' if has_head else ' — keine Kopfzeile erkannt'))
    for i in range(max(width, len(head))):
        h = head[i] if i < len(head) else ''
        vals = [str(r[i]) for r in data if i < len(r)]
        out(f'  {i + 1:>3}. {label(h):<32} {describe(vals)}')


def analyse_ini(text, out):
    """Sections are grouped by the set of keys they hold (e.g. one section per
    Auftrag → one group). Section names are only shown as a masked pattern:
    digits as 9, every letter run of 3+ characters as "…"."""
    def mask(n):
        return re.sub(r'[A-Za-zÄÖÜäöüß]{3,}', '…', shape(n) if re.search(r'\d', n) else n)
    sections, cur = [], None
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith((';', '#')):
            continue
        m = re.fullmatch(r'\[(.*)\]', s)
        if m:
            cur = (mask(m.group(1)), collections.OrderedDict()); sections.append(cur)
        elif '=' in s:
            if cur is None:
                cur = ('(ohne Abschnitt)', collections.OrderedDict()); sections.append(cur)
            k, v = s.split('=', 1)
            cur[1].setdefault(k.strip(), []).append(v)
    groups = collections.OrderedDict()
    for name, keys in sections:
        g = groups.setdefault(tuple(keys), {'names': [], 'vals': collections.defaultdict(list)})
        g['names'].append(name)
        for k, vals in keys.items():
            g['vals'][k] += vals
    out(f'  INI-Format, {len(sections)} Abschnitte in {len(groups)} Arten')
    for keys, g in groups.items():
        names = sorted(set(g['names']))
        out(f'  Abschnitt [{names[0]}]' + (f' u. ä. ({len(names)} Namensformen)' if len(names) > 1 else '')
            + f'  ×{len(g["names"])}')
        for k in keys:
            out(f'      {label(k):<30} {describe(g["vals"][k])}')


def analyse_fixed(lines, out):
    lens = collections.Counter(len(l) for l in lines)
    out(f'  Kein Trennzeichen erkannt — vermutlich feste Spaltenbreiten. {len(lines)} Zeilen, '
        f'Zeilenlängen: ' + ', '.join(f'{n} (×{c})' for n, c in lens.most_common(4)))
    for l in lines[:3]:
        masked = re.sub(r'[A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß .\-&]{3,}', lambda m: '·' * len(m.group()), l)
        out('    ' + shape(masked))


def analyse_text(raw, out):
    text, enc = decode(raw)
    lines = [l for l in text.splitlines() if l.strip()]
    out(f'  Text, Kodierung {enc}, {len(lines)} Zeilen')
    if not lines:
        return
    if sum(bool(re.fullmatch(r'\s*\[.*\]\s*', l)) for l in lines) >= 1 and sum('=' in l for l in lines) >= len(lines) / 3:
        return analyse_ini(text, out)
    best, best_score = None, 0
    for d in (';', '\t', '|', ','):
        counts = collections.Counter(l.count(d) for l in lines[:200])
        n, c = counts.most_common(1)[0]
        if n and c / min(len(lines), 200) > best_score:
            best, best_score = d, c / min(len(lines), 200)
    if not best or best_score < 0.6:
        return analyse_fixed(lines, out)
    out(f'  Trennzeichen: {"TAB" if best == chr(9) else best}')
    analyse_table(list(csv.reader(io.StringIO(text), delimiter=best)), out)


def analyse_bytes(name, raw, out, depth=0):
    if raw[:2] == b'PK':
        z = zipfile.ZipFile(io.BytesIO(raw))
        names = z.namelist()
        if any(n.startswith('xl/') for n in names):
            out('  Excel-Datei (.xlsx)')
            return analyse_table(xlsx_rows(raw), out)
        enc = any(i.flag_bits & 0x1 for i in z.infolist())
        out(f'  ZIP-Archiv mit {len(names)} Dateien' + (' — passwortgeschützt, Inhalt nicht lesbar' if enc else ''))
        for info in z.infolist():
            out(f'  ├ {os.path.basename(info.filename) or info.filename}  ({info.file_size} Bytes)')
            if not enc and not info.is_dir() and depth < 2:
                analyse_bytes(info.filename, z.read(info), lambda s: out('  │' + s), depth + 1)
        return
    if looks_binary(raw):
        out(f'  Binärdatei, {len(raw)} Bytes, Kennung (erste Bytes): {raw[:8].hex(" ")}')
        return
    analyse_text(raw, out)


def analyse_path(path):
    print(f'\n=== {os.path.basename(path)}  ({os.path.getsize(path)} Bytes)')
    try:
        analyse_bytes(path, open(path, 'rb').read(), print)
    except Exception as e:   # one odd file must not stop the others
        print(f'  Konnte nicht ausgewertet werden: {type(e).__name__}')


def pick_files():
    from tkinter import Tk, filedialog
    root = Tk(); root.withdraw(); root.attributes('-topmost', True)
    paths = filedialog.askopenfilenames(title='DATEV-Dateien auswählen (mehrere möglich)',
        filetypes=[('DATEV / Excel / CSV', '*.exp *.xlsx *.xlsm *.csv *.txt *.zip'), ('Alle Dateien', '*.*')])
    root.destroy()
    return list(paths)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    paths = sys.argv[1:] or pick_files()
    if not paths:
        print('Keine Datei ausgewählt.'); sys.exit(1)
    files = []
    for p in paths:
        if os.path.isdir(p):
            files += sorted(os.path.join(p, f) for f in os.listdir(p) if os.path.isfile(os.path.join(p, f)))
        elif os.path.isfile(p):
            files.append(p)
        else:
            print(f'Datei nicht gefunden: {p}')
    for f in files:
        analyse_path(f)
