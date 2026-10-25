#!/usr/bin/env tsx
/**
 * Dynamic-import guard — **a spec that loads another workspace package at
 * runtime must declare it, or `nx affected` never runs that spec.**
 *
 * ## The failure this catches
 *
 * `addon-pages-wiring.spec.ts` in `server/backend` reaches the benchmark addon
 * through `await import('@camstack/addon-benchmark')`. nx builds its project
 * graph from `package.json` dependencies and STATIC imports; a dynamic import
 * inside a spec is not an edge. So when changed the addon's
 * `onInitialize`, `nx show projects --affected` answered
 * `["@camstack/addon-benchmark"]` — the package that OWNS the spec was not in
 * the list, the spec did not run on push, and it sat red on main for weeks
 * (see the private session log, 2026-09).
 *
 * ## What it checks
 *
 * For every workspace package, every `import('@camstack/<name>')` found in a
 * `*.spec.ts` / `*.spec.tsx` / `*.test.ts(x)` under `src/` names a package that
 * is either the package itself, a dependency of any kind (`dependencies`,
 * `devDependencies`, `optionalDependencies`, `peerDependencies`), or
 * listed in that package's `nx.implicitDependencies`. Anything else is
 * reported with the file and the line.
 *
 * The fix is one of: add the package to `nx.implicitDependencies` (an edge for
 * the graph only, no runtime coupling), make it a real devDependency, or move
 * the spec next to the code it exercises.
 *
 * Usage: tsx scripts/check-spec-dynamic-imports-declared.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

interface Manifest {
  readonly name?: string
  readonly dependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
  readonly optionalDependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly nx?: { readonly implicitDependencies?: readonly string[] }
}

interface Violation {
  readonly pkg: string
  readonly file: string
  readonly line: number
  readonly imported: string
}

const SPEC_FILE = /\.(spec|test)\.tsx?$/
const DYNAMIC_IMPORT = /import\(\s*['"](@camstack\/[a-z0-9-]+)['"]\s*\)/g

function listPackageDirs(): readonly string[] {
  const dirs: string[] = []
  for (const parent of ['packages', 'server']) {
    const base = path.join(ROOT, parent)
    if (!fs.existsSync(base)) continue
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = path.join(base, entry.name)
      if (fs.existsSync(path.join(dir, 'package.json'))) dirs.push(dir)
    }
  }
  return dirs
}

function walkSpecs(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkSpecs(full, out)
    else if (SPEC_FILE.test(entry.name)) out.push(full)
  }
}

function readManifest(dir: string): Manifest {
  return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as Manifest
}

function declaredPackages(manifest: Manifest): ReadonlySet<string> {
  return new Set<string>([
    ...(manifest.name !== undefined ? [manifest.name] : []),
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...(manifest.nx?.implicitDependencies ?? []),
  ])
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length
}

function findViolations(): readonly Violation[] {
  const violations: Violation[] = []
  for (const dir of listPackageDirs()) {
    const manifest = readManifest(dir)
    const declared = declaredPackages(manifest)
    const srcDir = path.join(dir, 'src')
    if (!fs.existsSync(srcDir)) continue
    const specs: string[] = []
    walkSpecs(srcDir, specs)
    for (const file of specs) {
      const text = fs.readFileSync(file, 'utf8')
      for (const match of text.matchAll(DYNAMIC_IMPORT)) {
        const imported = match[1]
        if (imported === undefined || declared.has(imported)) continue
        violations.push({
          pkg: manifest.name ?? path.relative(ROOT, dir),
          file: path.relative(ROOT, file),
          line: lineOf(text, match.index ?? 0),
          imported,
        })
      }
    }
  }
  return violations
}

const violations = findViolations()
if (violations.length > 0) {
  console.error(
    '✖ spec dynamic imports without a declared graph edge (nx affected will skip them):',
  )
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} — ${v.pkg} imports ${v.imported} at runtime`)
  }
  console.error(
    '  Fix: add the package to `nx.implicitDependencies` in that package.json (graph edge only), or make it a devDependency.',
  )
  process.exit(1)
}
console.log('✔ every spec dynamic import of a workspace package is a declared graph edge')
