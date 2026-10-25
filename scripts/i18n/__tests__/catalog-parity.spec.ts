/**
 * Key parity per namespace (D863). Every `i18n/en.json` has an `it.json` with the
 * SAME keys and the SAME `{placeholders}`; every `ns:key` a source file points at
 * exists in its namespace's `en.json`; every `userError('code', ...)` code exists
 * in the core `server` catalog. A bulk migration that forgets a half fails here.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { addLabelKeys } from '../add-label-keys.ts'

const CATALOG = z.record(z.string(), z.string())
const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

interface Namespace {
  readonly ns: string
  readonly dir: string
  readonly srcDir: string
}

function namespaces(): readonly Namespace[] {
  const out: Namespace[] = [
    {
      ns: 'server',
      dir: path.join(ROOT, 'packages/system/src/i18n'),
      srcDir: path.join(ROOT, 'packages/system/src'),
    },
  ]
  for (const pkg of fs.readdirSync(path.join(ROOT, 'packages'))) {
    const dir = path.join(ROOT, 'packages', pkg, 'i18n')
    if (fs.existsSync(path.join(dir, 'en.json'))) {
      out.push({
        ns: pkg.replace(/^addon-/, ''),
        dir,
        srcDir: path.join(ROOT, 'packages', pkg, 'src'),
      })
    }
  }
  return out
}

function readCatalog(file: string): Record<string, string> {
  return CATALOG.parse(JSON.parse(fs.readFileSync(file, 'utf8')))
}

const placeholders = (s: string): string[] =>
  [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort()

function* tsFiles(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name !== 'dist') yield* tsFiles(path.join(dir, e.name))
    } else if (e.name.endsWith('.ts') && !/\.(spec|test|d)\.ts$/.test(e.name)) {
      yield path.join(dir, e.name)
    }
  }
}

let corpus: readonly { readonly file: string; readonly text: string }[] | null = null
/** Every non-test source file of the packages and the backend, read once. */
function sources(): readonly { readonly file: string; readonly text: string }[] {
  if (corpus !== null) return corpus
  const dirs = [
    ...fs
      .readdirSync(path.join(ROOT, 'packages'))
      .map((p) => path.join(ROOT, 'packages', p, 'src')),
    path.join(ROOT, 'server/backend/src'),
  ].filter((d) => fs.existsSync(d))
  corpus = dirs.flatMap((d) =>
    [...tsFiles(d)].map((file) => ({ file, text: fs.readFileSync(file, 'utf8') })),
  )
  return corpus
}

describe('i18n catalogs', { timeout: 60_000 }, () => {
  const all = namespaces()

  it('finds the core catalog and the migrated addons', () => {
    expect(all.map((n) => n.ns)).toEqual(
      expect.arrayContaining([
        'server',
        'provider-reolink',
        'notifiers',
        'pipeline',
        'remote-storage',
      ]),
    )
  })

  for (const { ns, dir } of all) {
    it(`${ns}: en.json and it.json have the same keys and placeholders`, () => {
      const en = readCatalog(path.join(dir, 'en.json'))
      const it_ = readCatalog(path.join(dir, 'it.json'))
      expect(Object.keys(it_).sort()).toEqual(Object.keys(en).sort())
      for (const key of Object.keys(en)) {
        expect(placeholders(it_[key] ?? ''), key).toEqual(placeholders(en[key] ?? ''))
      }
    })
  }

  it('every ns:key reference in source resolves in its en.json', () => {
    const missing: string[] = []
    for (const { file, text } of sources()) {
      for (const m of text.matchAll(
        /\b(?:labelKey|descriptionKey|titleKey):\s*'([^':]+):([^']+)'/g,
      )) {
        const target = all.find((n) => n.ns === m[1])
        const catalog = target === undefined ? {} : readCatalog(path.join(target.dir, 'en.json'))
        if (catalog[m[2] ?? ''] === undefined)
          missing.push(`${path.relative(ROOT, file)} -> ${m[1]}:${m[2]}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('every userError code in the repo exists in the server catalog', () => {
    const server = readCatalog(path.join(ROOT, 'packages/system/src/i18n/en.json'))
    const missing: string[] = []
    const call =
      /\b(?:userError|trpcUserError)\(\s*(?:'[A-Z_]+',\s*)?'([a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+)'/g
    for (const { file, text } of sources()) {
      for (const m of text.matchAll(call)) {
        if (server[m[1] ?? ''] === undefined)
          missing.push(`${path.relative(ROOT, file)} -> ${m[1]}`)
      }
    }
    expect(missing).toEqual([])
  })
})

describe('label codemod', () => {
  it('adds keys next to literal labels, is idempotent, and leaves dynamic labels alone', () => {
    const src = `export function buildDemoSchema() {
  return { sections: [{ id: 'main', title: 'Main', fields: [
    { type: 'text', key: 'host', label: 'Host', description: 'Server' + ' name' },
    { type: 'text', key: 'dyn', label: \`Dyn \${x}\` },
  ] }] }
}
`
    const first = addLabelKeys('demo.ts', src, 'demo')
    expect(first.added).toEqual({
      'demo.s_main.title': 'Main',
      'demo.s_main.host.label': 'Host',
      'demo.s_main.host.description': 'Server name',
    })
    expect(first.source).toContain("labelKey: 'demo:demo.s_main.host.label'")
    expect(first.dynamic).toHaveLength(1)
    expect(addLabelKeys('demo.ts', first.source, 'demo').source).toBe(first.source)
  })
})
