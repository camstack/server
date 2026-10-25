/**
 * Every i18n key the admin UI source passes to `t('literal.key', ...)` must exist in
 * BOTH `en.json` and `it.json`.
 *
 * Why: `t(key, 'Default')` falls back to the inline default, so a key that was
 * never added to a catalogue is invisible in English and silently stays English
 * in Italian. This spec turns that silence into a failure.
 *
 * `i18n-legacy-missing.json` used to pin the keys that predate this spec. It is
 * empty now and must stay empty: a key used in code and absent from a catalogue
 * fails, with no list to hide it in.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import en from '../i18n/en.json'
import it_ from '../i18n/it.json'
import legacy from './i18n-legacy-missing.json'

type Catalogue = { readonly [k: string]: Catalogue | string }

const SRC = path.resolve(__dirname, '..')
/** The shared composites resolve their words through the host: their keys live in these catalogues too. */
const UI_LIBRARY_SRC = path.resolve(__dirname, '../../../ui-library/src')
const SKIP = /(\.spec\.|\.test\.|\.stories\.|__tests__|node_modules)/
const KEY_CALL = /(?<![A-Za-z0-9_$])t\(\s*['"`]([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)['"`]/g
/** `<Trans i18nKey="a.b">`, `<UiTrans uiKey="a.b">` and data tables that store a key (`labelKey: 'a.b'`). */
const KEY_PROP =
  /\b(?:i18nKey|uiKey|[a-z][A-Za-z]*Key)\s*[:=]\s*\{?\s*['"`]([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)['"`]/g

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (SKIP.test(full)) return []
    if (entry.isDirectory()) return sourceFiles(full)
    return /\.tsx?$/.test(entry.name) ? [full] : []
  })
}

function hasLeaf(catalogue: Catalogue, key: string): boolean {
  let cur: Catalogue | string = catalogue
  for (const seg of key.split('.')) {
    if (typeof cur === 'string' || !(seg in cur)) return false
    cur = cur[seg] as Catalogue | string
  }
  return typeof cur === 'string'
}

/** A plural key is looked up as `key_one` / `key_other`. */
const present = (catalogue: Catalogue, key: string): boolean =>
  hasLeaf(catalogue, key) || hasLeaf(catalogue, `${key}_one`) || hasLeaf(catalogue, `${key}_other`)

function usedKeys(): readonly string[] {
  const keys = new Set<string>()
  for (const file of [...sourceFiles(SRC), ...sourceFiles(UI_LIBRARY_SRC)]) {
    const text = fs.readFileSync(file, 'utf8')
    for (const m of text.matchAll(KEY_CALL)) keys.add(m[1] as string)
    for (const m of text.matchAll(KEY_PROP)) keys.add(m[1] as string)
  }
  return [...keys].sort()
}

describe('admin-ui i18n key parity', () => {
  const used = usedKeys()
  const known = new Set<string>(legacy.missing)

  it('finds the keys used in code (guards the extraction itself)', () => {
    expect(used.length).toBeGreaterThan(100)
  })

  it('every key used in code is in en.json AND it.json (beyond the pinned legacy list)', () => {
    const missing = used.filter(
      (key) =>
        !known.has(key) && !(present(en as Catalogue, key) && present(it_ as Catalogue, key)),
    )
    expect(missing).toEqual([])
  })

  it('no key used in code names a branch of the catalogue (it would render an object)', () => {
    const isBranch = (catalogue: Catalogue, key: string): boolean => {
      let cur: Catalogue | string = catalogue
      for (const seg of key.split('.')) {
        if (typeof cur === 'string' || !(seg in cur)) return false
        cur = cur[seg] as Catalogue | string
      }
      return typeof cur === 'object' && !Object.keys(cur).some((k) => /_(one|other)$/.test(k))
    }
    expect(
      used.filter((key) => isBranch(en as Catalogue, key) || isBranch(it_ as Catalogue, key)),
    ).toEqual([])
  })

  it('the legacy list only holds keys that are still missing somewhere', () => {
    const fixed = legacy.missing.filter(
      (key) => present(en as Catalogue, key) && present(it_ as Catalogue, key),
    )
    expect(fixed).toEqual([])
  })
})
