#!/usr/bin/env tsx
/**
 * Page-remote shared-library guard — a page remote never compiles ui-library,
 * ui or types into its own bundle (planning #332).
 *
 * ## The failure this catches
 *
 * Every page remote shares `@camstack/ui-library` with the host (`import: false`).
 * A `resolve.alias` of `@camstack/ui-library` (or `@camstack/ui`, `@camstack/types`)
 * to a `src` path rewrites the specifier BEFORE module-federation's sharing layer
 * sees it, so the whole library is bundled into the remote. The remote then
 * changes whenever the library does, and every page addon is republished for a
 * library edit. Nothing fails: the page still renders from its own copy.
 *
 * ## What it checks
 *
 * For every package that declares an addon page, in each of its federation
 * configs (`vite.config.ts` / `vite.page.config.ts` containing `federation(`):
 *
 * 1. no alias entry for `@camstack/ui-library`, `@camstack/ui` or `@camstack/types`;
 * 2. the `@camstack/ui-library` share states `requiredVersion` as a `>=` range —
 *    that declaration is what the host's `AddonPageLoader` compares against.
 *
 * `addon-agent-ui` is a standalone app, declares no page, and keeps bundling.
 *
 * Usage: tsx scripts/check-page-remote-no-ui-library-alias.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pagePackages } from './check-addon-page-css.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const PACKAGES = path.join(ROOT, 'packages')
const CONFIGS = ['vite.config.ts', 'vite.page.config.ts'] as const

const ALIAS_OF_SHARED = /['"]@camstack\/(ui-library|ui|types)['"]\s*:\s*(?:path\.|\.|['"`])/

/** The share entry for ui-library: from its key to the closing brace of its object. */
const UI_LIBRARY_SHARE = /['"]@camstack\/ui-library['"]\s*:\s*\{[^}]*\}/g

/** Why a federation config would bundle the shared libraries, or fail to declare its minimum (empty = fine). */
export function pageRemoteConfigProblems(source: string): readonly string[] {
  if (!source.includes('federation(')) return []
  const problems: string[] = []
  const code = source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
  const hit = ALIAS_OF_SHARED.exec(code)
  if (hit !== null) problems.push(`resolve.alias of @camstack/${hit[1]} bundles it into the remote`)
  const shares = [...code.matchAll(UI_LIBRARY_SHARE)].map((m) => m[0])
  const declared = shares.some((share) => /requiredVersion\s*:\s*`>=/.test(share))
  if (!declared)
    problems.push('the @camstack/ui-library share has no requiredVersion: `>=<version>`')
  return problems
}

function main(): void {
  const problems: string[] = []
  const packages = pagePackages()
  for (const name of packages) {
    for (const config of CONFIGS) {
      const file = path.join(PACKAGES, name, config)
      if (!fs.existsSync(file)) continue
      for (const problem of pageRemoteConfigProblems(fs.readFileSync(file, 'utf8'))) {
        problems.push(`${path.relative(ROOT, file)}: ${problem}`)
      }
    }
  }
  if (problems.length > 0) {
    console.error(
      'check-page-remote-no-ui-library-alias: a page remote would bundle the shared libraries',
    )
    for (const p of problems) console.error(`  - ${p}`)
    console.error(
      'Fix: delete the alias; the host provides the library. Docs: docs/architecture/ui.md',
    )
    process.exit(1)
  }
  console.log(
    `check-page-remote-no-ui-library-alias: ${packages.length} page package(s) share the libraries`,
  )
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()
