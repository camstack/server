#!/usr/bin/env tsx
/**
 * Addon install-link guard (D860) — **every "install an addon for X" offer
 * must name a capability a published addon package actually declares.**
 *
 * ## The failure this catches
 *
 * An "Add destination" button on the Logging page linked to the addon catalog
 * filtered by `log-destination`, a capability every provider of which is built
 * into `@camstack/system`: the button could never lead to anything. The Training
 * page hand-typed the catalog URL. A dead install button reads as "no addon
 * exists" and nothing fails.
 *
 * ## What it checks
 *
 *  1. Every `install: { capability }` and every `addonCatalogHref(...)`
 *     argument that is a literal (or a same-file `const`) names a capability at
 *     least one `packages/addon-*` package declares in
 *     `camstack.addons[].capabilities`. Computed arguments are skipped.
 *  2. The `/system/addons?capability=` literal appears only in the builders
 *     (`ui-library/src/lib/addon-catalog-href.ts`).
 *
 * Specs are exempt.
 *
 * Usage: tsx scripts/check-addon-install-links.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  findCatalogLiterals,
  findInstallReferences,
  judgeInstallLinks,
  loadInstallableCapabilities,
  type CatalogLiteral,
  type InstallReference,
} from './lib/addon-install-links.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const BUILDERS: ReadonlySet<string> = new Set([
  'packages/types/src/capabilities/addon-catalog-href.ts',
])
const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  '__tests__',
  'generated',
])

const rel = (file: string): string => path.relative(ROOT, file).split(path.sep).join('/')

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) walk(full, out)
    } else if (/\.tsx?$/.test(entry.name) && !/\.(spec|test)\./.test(entry.name)) {
      out.push(full)
    }
  }
}

function sourceRoots(): readonly string[] {
  const roots = [path.join(ROOT, 'server/backend/src')]
  for (const entry of fs.readdirSync(path.join(ROOT, 'packages'), { withFileTypes: true })) {
    const src = path.join(ROOT, 'packages', entry.name, 'src')
    if (entry.isDirectory() && fs.existsSync(src)) roots.push(src)
  }
  return roots
}

function main(): void {
  const files: string[] = []
  for (const root of sourceRoots()) walk(root, files)

  const references: InstallReference[] = []
  const literals: CatalogLiteral[] = []
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf-8')
    references.push(...findInstallReferences(rel(file), source))
    literals.push(...findCatalogLiterals(rel(file), source))
  }

  const problems = judgeInstallLinks({
    references,
    literals,
    installable: loadInstallableCapabilities(ROOT),
    allowedLiteralFiles: BUILDERS,
  })
  if (problems.length > 0) {
    console.error(`check-addon-install-links: ${problems.length} problem(s)`)
    for (const p of problems) console.error(`  ${p}`)
    process.exit(1)
  }
  console.log(
    `check-addon-install-links: OK (${references.length} install offers, ${files.length} files)`,
  )
}

main()
