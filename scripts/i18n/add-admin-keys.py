#!/usr/bin/env python3
"""Merge flat `{ "section.key": ["English", "Italiano"] }` fragments into the
admin-ui en.json / it.json catalogues (nested by dots, order preserved).

  python3 scripts/i18n/add-admin-keys.py fragment.json [more.json ...]

Refuses to overwrite an existing key with a different value, except for a
fragment whose name ends in `keep.json`, where the catalogue's value wins.
"""
import json
import pathlib
import sys

DIR = pathlib.Path(__file__).resolve().parents[2] / 'packages/addon-admin-ui/src/i18n'


CONFLICTS = []
KEEP_EXISTING = False


def put(tree, dotted, value):
    segs = dotted.split('.')
    cur = tree
    for s in segs[:-1]:
        nxt = cur.setdefault(s, {})
        if not isinstance(nxt, dict):
            CONFLICTS.append(f'{dotted}: {s} is a leaf, not a branch')
            return
        cur = nxt
    last = segs[-1]
    if last in cur and cur[last] != value and KEEP_EXISTING:
        return
    if last in cur and cur[last] != value:
        CONFLICTS.append(f'{dotted}: already set to {cur[last]!r}, refusing {value!r}')
        return
    cur[last] = value


def main():
    cats = {l: json.loads((DIR / f'{l}.json').read_text('utf8')) for l in ('en', 'it')}
    n = 0
    global KEEP_EXISTING
    for frag in sys.argv[1:]:
        KEEP_EXISTING = frag.endswith('keep.json')
        for key, pair in json.loads(pathlib.Path(frag).read_text('utf8')).items():
            if not (isinstance(pair, list) and len(pair) == 2):
                raise SystemExit(f'{key}: need [en, it]')
            put(cats['en'], key, pair[0])
            put(cats['it'], key, pair[1])
            n += 1
    if CONFLICTS:
        raise SystemExit('\n'.join(CONFLICTS))
    for l, tree in cats.items():
        (DIR / f'{l}.json').write_text(json.dumps(tree, indent=2, ensure_ascii=False) + '\n', 'utf8')
    print(f'merged {n} keys')


main()
