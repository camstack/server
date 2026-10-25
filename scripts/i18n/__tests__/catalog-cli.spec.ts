/**
 * `i18n:set` / `i18n:get` / `i18n:keys` — edit a nested catalog by dotted key
 * without loading it into an agent context. Key order is the file's order;
 * the bytes are `JSON.stringify(_, null, 2) + "\n"`.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CatalogCliError,
  formatCatalog,
  listKeys,
  resolveCatalogDir,
  setKey,
  splitKey,
} from '../catalog.ts'
import { runCatalog } from '../cli.ts'

interface JsonObject {
  readonly [key: string]: unknown
}

function readJson(file: string): unknown {
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
  return value
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function objectAt(node: JsonObject, key: string): JsonObject {
  const value = node[key]
  if (!isJsonObject(value)) throw new Error(`expected object at ${key}`)
  return value
}

describe('catalog key edits', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
  })

  function tmp(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-catalog-'))
    dirs.push(dir)
    return dir
  }

  it('appends a new nested key and leaves existing key order untouched', () => {
    const en = { z: 'zed', nav: { metrics: 'Metrics', integrations: 'Integrations' } }
    const it = { z: 'zeta', nav: { metrics: 'Metriche', integrations: 'Integrazioni' } }
    const next = setKey({ en, it }, 'nav.events', 'Library', 'Libreria', false)
    expect(en.nav).toEqual({ metrics: 'Metrics', integrations: 'Integrations' })
    expect(Object.keys(next.en)).toEqual(['z', 'nav'])
    expect(Object.keys(objectAt(next.en, 'nav'))).toEqual(['metrics', 'integrations', 'events'])
    expect(objectAt(next.en, 'nav').events).toBe('Library')
    expect(objectAt(next.it, 'nav').events).toBe('Libreria')
    expect(formatCatalog(next.en)).toBe(`${JSON.stringify(next.en, null, 2)}\n`)
  })

  it('refuses an existing key unless force, and force keeps the key where it was', () => {
    const pair = {
      en: { nav: { metrics: 'Metrics', events: 'Library' } },
      it: { nav: { metrics: 'Metriche', events: 'Libreria' } },
    }
    expect(() => setKey(pair, 'nav.events', 'Archive', 'Archivio', false)).toThrow(CatalogCliError)
    const forced = setKey(pair, 'nav.events', 'Archive', 'Archivio', true)
    expect(Object.keys(objectAt(forced.en, 'nav'))).toEqual(['metrics', 'events'])
    expect(objectAt(forced.en, 'nav').events).toBe('Archive')
    expect(objectAt(forced.it, 'nav').events).toBe('Archivio')
  })

  it('refuses to replace an object, to cross a string, and to mismatch placeholders', () => {
    const pair = { en: { nav: { events: 'Library' } }, it: { nav: { events: 'Libreria' } } }
    expect(() => setKey(pair, 'nav', 'x', 'y', true)).toThrow(/object/)
    expect(() => setKey(pair, 'nav.events.child', 'x', 'y', false)).toThrow(/string/)
    expect(() => setKey(pair, 'nav.hello', 'Hello {name}', 'Ciao', false)).toThrow(/placeholder/)
    expect(() => setKey(pair, 'nav.hello', 'Hello {name}', 'Ciao {name}', false)).not.toThrow()
    expect(() => splitKey('a..b')).toThrow(CatalogCliError)
    expect(() => splitKey('')).toThrow(CatalogCliError)
  })

  it('lists leaves under a prefix in catalog order', () => {
    const node = { z: 'z', nav: { metrics: 'M', events: 'E' } }
    expect(listKeys(node, 'nav')).toEqual(['nav.metrics', 'nav.events'])
    expect(listKeys(node, 'nav.events')).toEqual(['nav.events'])
    expect(listKeys(node, 'missing')).toEqual([])
  })

  it('resolves admin-ui to src/i18n and refuses a package with two catalogs', () => {
    const root = tmp()
    const admin = path.join(root, 'packages', 'addon-admin-ui', 'src', 'i18n')
    fs.mkdirSync(admin, { recursive: true })
    fs.writeFileSync(path.join(admin, 'en.json'), '{}\n')
    fs.writeFileSync(path.join(admin, 'it.json'), '{}\n')
    expect(resolveCatalogDir(root, undefined)).toBe(admin)
    expect(resolveCatalogDir(root, 'admin-ui')).toBe(admin)
    const both = path.join(root, 'packages', 'addon-pipeline')
    for (const dir of [path.join(both, 'i18n'), path.join(both, 'src', 'i18n')]) {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'en.json'), '{}\n')
      fs.writeFileSync(path.join(dir, 'it.json'), '{}\n')
    }
    expect(() => resolveCatalogDir(root, 'pipeline')).toThrow(/more than one/)
    expect(resolveCatalogDir(root, path.join(both, 'src', 'i18n'))).toBe(
      path.join(both, 'src', 'i18n'),
    )
  })
})

describe('i18n cli', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
  })

  function fixture(): { readonly root: string; readonly dir: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-cli-'))
    dirs.push(root)
    const dir = path.join(root, 'packages', 'addon-admin-ui', 'src', 'i18n')
    fs.mkdirSync(dir, { recursive: true })
    const en = { z: 'keep', nav: { metrics: 'Metrics' } }
    const it = { z: 'tieni', nav: { metrics: 'Metriche' } }
    fs.writeFileSync(path.join(dir, 'en.json'), `${JSON.stringify(en, null, 2)}\n`)
    fs.writeFileSync(path.join(dir, 'it.json'), `${JSON.stringify(it, null, 2)}\n`)
    return { root, dir }
  }

  it('sets, gets and lists, and refuses a second set until --force', () => {
    const { root, dir } = fixture()
    expect(runCatalog(['set', 'nav.events', 'Library', 'Libreria'], root)).toContain('nav.events')
    const got = runCatalog(['get', 'nav.events'], root)
    expect(got).toContain('Library')
    expect(got).toContain('Libreria')
    expect(runCatalog(['keys', 'nav'], root).trim().split('\n')).toEqual([
      'nav.metrics',
      'nav.events',
    ])
    const before = fs.readFileSync(path.join(dir, 'en.json'), 'utf8')
    expect(() => runCatalog(['set', 'nav.events', 'Archive', 'Archivio'], root)).toThrow(
      /already exists/,
    )
    expect(fs.readFileSync(path.join(dir, 'en.json'), 'utf8')).toBe(before)
    runCatalog(['set', '--force', 'nav.events', 'Archive', 'Archivio'], root)
    const en = readJson(path.join(dir, 'en.json'))
    const it = readJson(path.join(dir, 'it.json'))
    expect(en).toEqual({ z: 'keep', nav: { metrics: 'Metrics', events: 'Archive' } })
    expect(it).toEqual({ z: 'tieni', nav: { metrics: 'Metriche', events: 'Archivio' } })
    expect(fs.readFileSync(path.join(dir, 'en.json'), 'utf8')).toBe(
      `${JSON.stringify(en, null, 2)}\n`,
    )
  })
})
