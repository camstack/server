import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  catalogNamespaceOf,
  CatalogRegistry,
  createCoreCatalogRegistry,
  SERVER_NAMESPACE,
} from '../catalog-registry.js'

const dirs: string[] = []
function addonDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-spec-'))
  dirs.push(dir)
  fs.mkdirSync(path.join(dir, 'i18n'))
  for (const [name, body] of Object.entries(files))
    fs.writeFileSync(path.join(dir, 'i18n', name), body)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('CatalogRegistry', () => {
  it('translates for it and falls back to the English text for en, an unknown key and an unknown namespace', () => {
    const reg = new CatalogRegistry()
    reg.set('demo', 'it', { 'a.label': 'Ciao {name}' }, 'test')
    expect(reg.t('it', 'demo', 'a.label', { name: 'Alice' }, 'Hello')).toBe('Ciao Alice')
    expect(reg.t('en', 'demo', 'a.label', undefined, 'Hello')).toBe('Hello')
    expect(reg.t('it', 'demo', 'missing', undefined, 'Hello')).toBe('Hello')
    expect(reg.t('it', 'nope', 'a.label', undefined, 'Hello')).toBe('Hello')
  })

  it('loads an addon directory and ignores a broken file with a warning', () => {
    const warnings: string[] = []
    const reg = new CatalogRegistry((m) => warnings.push(m))
    const dir = addonDir({ 'it.json': '{"k":"valore"}', 'en.json': '{ not json' })
    reg.loadAddonDir('demo', dir)
    expect(reg.lookup('it', 'demo', 'k')).toBe('valore')
    expect(reg.lookup('en', 'demo', 'k')).toBeUndefined()
    expect(warnings).toHaveLength(1)
  })

  it('rejects a file that is not a flat string map', () => {
    const warnings: string[] = []
    const reg = new CatalogRegistry((m) => warnings.push(m))
    expect(reg.set('demo', 'it', { nested: { a: 'b' } }, 'bad.json')).toBe(false)
    expect(reg.lookup('it', 'demo', 'nested')).toBeUndefined()
    expect(warnings[0]).toContain('bad.json')
  })

  it('an addon without an i18n directory is silent', () => {
    const warnings: string[] = []
    const reg = new CatalogRegistry((m) => warnings.push(m))
    reg.loadAddonDir('demo', os.tmpdir() + '/definitely-missing-' + Date.now())
    expect(warnings).toEqual([])
  })

  it('clear forgets a namespace', () => {
    const reg = new CatalogRegistry()
    reg.set('demo', 'it', { k: 'v' }, 't')
    reg.clear('demo')
    expect(reg.lookup('it', 'demo', 'k')).toBeUndefined()
  })
})

describe('catalogNamespaceOf', () => {
  it('names a package by its short name', () => {
    expect(catalogNamespaceOf('@camstack/addon-provider-reolink')).toBe('provider-reolink')
    expect(catalogNamespaceOf('@camstack/system')).toBe('system')
  })
})

describe('core server catalog', () => {
  it('ships the server namespace in Italian', () => {
    const reg = createCoreCatalogRegistry()
    expect(reg.lookup('it', SERVER_NAMESPACE, 'auth.invalid-credentials')).toBe(
      'Credenziali non valide',
    )
  })
})
