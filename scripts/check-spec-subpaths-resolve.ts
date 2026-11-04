#!/usr/bin/env tsx
/**
 * Spec-load guard — a spec that imports a package SUBPATH must be able to
 * resolve it, under the runner's own alias table.
 *
 * ## The failure this catches
 *
 * The root `vitest.config.ts` aliased `@camstack/types` to `dist/index.mjs` as
 * a string. A string alias also matches `@camstack/types/<sub>`, rewriting it to
 * `dist/index.mjs/<sub>`: every spec that (transitively) imports
 * `@camstack/types/node` failed to LOAD with "Cannot find package". A file that
 * fails to load reports no test failure, so 13 specs of addon-export-hap read as
 * "nothing wrong" while none ran.
 *
 * ## What it checks
 *
 *   1. every subpath export of `@camstack/types` (its `package.json` `exports`)
 *      resolves, through the root vitest alias table and with Vite's alias
 *      semantics, to exactly that export's `import` file;
 *   2. every `@camstack/<pkg>/<sub>` specifier written in a spec file names an
 *      export that `<pkg>` declares (`*` patterns honoured).
 *
 * Static: it needs no `dist/`. Usage: npx tsx scripts/check-spec-subpaths-resolve.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { findSpecFiles, workspacePackageDirs } from './check-specs-have-test-script.js'

const ROOT = path.resolve(import.meta.dirname, '..')

export interface AliasEntry {
  readonly find: string | RegExp
  readonly replacement: string
}

/** Vite's `resolve.alias` semantics: first entry that matches wins. */
export function applyAlias(aliases: readonly AliasEntry[], specifier: string): string {
  for (const { find, replacement } of aliases) {
    if (typeof find === 'string') {
      if (specifier === find) return replacement
      if (specifier.startsWith(`${find}/`)) return replacement + specifier.slice(find.length)
    } else if (find.test(specifier)) {
      return specifier.replace(find, replacement)
    }
  }
  return specifier
}

export interface ExportsFacts {
  /** Export keys: `.`, `./node`, `./features/*`. */
  readonly keys: readonly string[]
}

/** True when `subpath` (`node`, `features/x`) is covered by an export key. */
export function isExported(facts: ExportsFacts, subpath: string): boolean {
  const key = `./${subpath}`
  return facts.keys.some((k) => {
    if (k === key) return true
    const star = k.indexOf('*')
    if (star === -1) return false
    return key.startsWith(k.slice(0, star)) && key.endsWith(k.slice(star + 1))
  })
}

/** Only module positions: `from '…'`, `import('…')`, `vi.mock('…')`, `require('…')`. */
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\bmock\s*\(\s*|\brequire\s*\(\s*)['"](@camstack\/[a-z0-9-]+)\/([^'"\s]+)['"]/g

/** `@camstack/<pkg>/<sub>` specifiers named in a source text. */
export function subpathSpecifiers(
  source: string,
): readonly { readonly pkg: string; readonly sub: string }[] {
  const out: { pkg: string; sub: string }[] = []
  for (const m of source.matchAll(SPECIFIER)) {
    const pkg = m[1]
    const sub = m[2]
    if (pkg !== undefined && sub !== undefined) out.push({ pkg, sub })
  }
  return out
}

interface PackageManifest {
  readonly name?: unknown
  readonly exports?: unknown
}

function readManifest(file: string): PackageManifest {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'))
  return typeof parsed === 'object' && parsed !== null ? parsed : {}
}

function exportKeys(manifest: PackageManifest): readonly string[] | undefined {
  const exp = manifest.exports
  return typeof exp === 'object' && exp !== null ? Object.keys(exp) : undefined
}

async function typesAliasFailures(): Promise<readonly string[]> {
  const mod: { default: { resolve?: { alias?: unknown } } } = await import('../vitest.config.js')
  const alias = mod.default.resolve?.alias
  const aliases: readonly AliasEntry[] = Array.isArray(alias) ? alias : []
  const pkgDir = path.join(ROOT, 'packages/types')
  const manifest = readManifest(path.join(pkgDir, 'package.json'))
  const exp = manifest.exports
  const failures: string[] = []
  if (typeof exp !== 'object' || exp === null) return ['packages/types has no `exports`']
  for (const [key, target] of Object.entries(exp)) {
    const importFile: unknown =
      typeof target === 'object' && target !== null ? Reflect.get(target, 'import') : undefined
    if (typeof importFile !== 'string') continue
    const specifier = key === '.' ? '@camstack/types' : `@camstack/types/${key.slice(2)}`
    const got = applyAlias(aliases, specifier)
    const want = path.join(pkgDir, importFile)
    if (got !== want) {
      failures.push(`vitest alias: \`${specifier}\` resolves to ${got}, expected ${want}`)
    }
  }
  return failures
}

function specSubpathFailures(): readonly string[] {
  const keysByPackage = new Map<string, readonly string[] | undefined>()
  const dirs = workspacePackageDirs(ROOT)
  for (const dir of dirs) {
    const manifest = readManifest(path.join(ROOT, dir, 'package.json'))
    if (typeof manifest.name === 'string') keysByPackage.set(manifest.name, exportKeys(manifest))
  }
  const failures: string[] = []
  for (const dir of dirs) {
    for (const spec of findSpecFiles(path.join(ROOT, dir))) {
      const text = fs.readFileSync(path.join(ROOT, dir, spec), 'utf-8')
      for (const { pkg, sub } of subpathSpecifiers(text)) {
        if (!keysByPackage.has(pkg)) continue
        const keys = keysByPackage.get(pkg)
        if (keys === undefined) continue
        if (!isExported({ keys }, sub)) {
          failures.push(`${dir}/${spec}: \`${pkg}/${sub}\` is not an export of ${pkg}`)
        }
      }
    }
  }
  return failures
}

async function main(): Promise<void> {
  const failures = [...(await typesAliasFailures()), ...specSubpathFailures()]
  if (failures.length > 0) {
    console.error('✘ spec subpath imports that cannot resolve (the spec fails to LOAD, silently):')
    for (const f of failures) console.error(`    ${f}`)
    process.exit(1)
  }
  console.log(
    '✔ every @camstack/types subpath resolves under the vitest alias; spec subpaths are exported',
  )
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  void main()
}
