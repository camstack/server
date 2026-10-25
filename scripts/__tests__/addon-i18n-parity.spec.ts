/**
 * Every addon that ships admin pages/widgets keeps its strings in
 * `packages/<addon>/src/i18n/{en,it}.json` (see ui-library `createAddonI18n`).
 * This spec holds the three promises the type system cannot:
 *  - en and it carry the same keys, placeholders and inline tags;
 *  - a plural base has its `_other` form;
 *  - every key a component spells out as a literal exists in en.
 * A dynamic key (`t(\`status.${s}\`)`) is checked by the compiler against the
 * typed key union instead.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const PACKAGES = path.join(ROOT, 'packages')

interface Tree {
  readonly [key: string]: string | Tree
}

function isTree(value: unknown): value is Tree {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>()
  for (const [key, value] of Object.entries(tree)) {
    const full = prefix === '' ? key : `${prefix}.${key}`
    if (typeof value === 'string') out.set(full, value)
    else for (const [k, v] of flatten(value, full)) out.set(k, v)
  }
  return out
}

function readTree(file: string): Tree {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!isTree(parsed)) throw new Error(`${file} is not a JSON object`)
  return parsed
}

function tokens(message: string, pattern: RegExp): string[] {
  return [...message.matchAll(pattern)].map((m) => m[0]).sort()
}

const PLACEHOLDERS = /\{\{\s*[\w.]+\s*\}\}/g
const TAGS = /<\/?[A-Za-z][\w-]*\s*\/?>/g
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/

function addonDirs(): string[] {
  return fs
    .readdirSync(PACKAGES, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('addon-') && e.name !== 'addon-admin-ui')
    .map((e) => path.join(PACKAGES, e.name))
    .filter((dir) => fs.existsSync(path.join(dir, 'src', 'i18n', 'en.json')))
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist' && entry.name !== '__tests__') {
        sourceFiles(full, out)
      }
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(spec|test)\./.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

/** Literal keys passed to `t('…')` / `i18nKey="…"` in files that import the addon's i18n. */
const LITERAL_KEY = /(?:\bt\(\s*|i18nKey=\{?\s*)(['"`])([A-Za-z][\w.]*)\1/g

describe('addon i18n bundles', () => {
  const dirs = addonDirs()

  it('finds the addons that ship bundles', () => {
    expect(dirs.length).toBeGreaterThan(0)
  })

  for (const dir of dirs) {
    const name = path.basename(dir)
    const i18nDir = path.join(dir, 'src', 'i18n')

    describe(name, () => {
      const en = flatten(readTree(path.join(i18nDir, 'en.json')))

      it('has an it.json with the same keys', () => {
        const itFile = path.join(i18nDir, 'it.json')
        expect(fs.existsSync(itFile)).toBe(true)
        const it_ = flatten(readTree(itFile))
        expect([...it_.keys()].sort()).toEqual([...en.keys()].sort())
      })

      it('keeps placeholders and inline tags identical across languages', () => {
        const it_ = flatten(readTree(path.join(i18nDir, 'it.json')))
        const drift: string[] = []
        for (const [key, message] of en) {
          const other = it_.get(key) ?? ''
          if (tokens(message, PLACEHOLDERS).join() !== tokens(other, PLACEHOLDERS).join()) {
            drift.push(`${key}: placeholders`)
          }
          if (tokens(message, TAGS).join() !== tokens(other, TAGS).join()) {
            drift.push(`${key}: tags`)
          }
          if (other.trim() === '' || message.trim() === '') drift.push(`${key}: empty`)
        }
        expect(drift).toEqual([])
      })

      it('gives every plural base its _other form', () => {
        const bases = new Set<string>()
        for (const key of en.keys()) {
          if (PLURAL_SUFFIX.test(key)) bases.add(key.replace(PLURAL_SUFFIX, ''))
        }
        const missing = [...bases].filter((base) => !en.has(`${base}_other`))
        expect(missing).toEqual([])
      })

      it('defines every key the components spell out', () => {
        const known = new Set<string>()
        for (const key of en.keys()) known.add(key.replace(PLURAL_SUFFIX, ''))
        const unknown: string[] = []
        for (const file of sourceFiles(path.join(dir, 'src'))) {
          const text = fs.readFileSync(file, 'utf8')
          if (!/from ['"][./]+(?:[\w-]+\/)*i18n(?:\/index)?['"]/.test(text)) continue
          for (const match of text.matchAll(LITERAL_KEY)) {
            const key = match[2] ?? ''
            if (!known.has(key)) unknown.push(`${path.relative(dir, file)}: ${key}`)
          }
        }
        expect(unknown).toEqual([])
      })
    })
  }
})
