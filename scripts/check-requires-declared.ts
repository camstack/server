#!/usr/bin/env tsx
/**
 * Every package a node installs separately from the server declares the
 * server it needs (D988).
 *
 *  - a published ADDON package (`camstack.addons`, not private) carries
 *    `camstack.requires.server`;
 *  - a WRAPPER (`packages/desktop`, `packages/node-root`) carries
 *    `camstack.requires.server`, the range of servers it can host.
 *
 * Without the declaration the resolver cannot refuse an addon that needs a
 * newer server than the node runs, and the update then installs something the
 * node cannot start. The publish workflow re-stamps the addons' value from the
 * version it ships (`scripts/ci/stamp-requires.mjs`); this guard keeps the
 * committed baseline from ever being empty.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PackageRequiresSchema } from '../packages/types/src/addon/package-requires.ts'

const ROOT = path.resolve(import.meta.dirname, '..')

export const WRAPPER_DIRS: readonly string[] = ['packages/desktop', 'packages/node-root']

export interface PackageFacts {
  readonly dir: string
  readonly name: string
  readonly private: boolean
  readonly camstack: Record<string, unknown> | null
}

export function missingDeclarations(packages: readonly PackageFacts[]): readonly string[] {
  const problems: string[] = []
  for (const pkg of packages) {
    const isWrapper = WRAPPER_DIRS.includes(pkg.dir)
    const isAddon =
      !pkg.private &&
      pkg.dir !== 'server/backend' &&
      pkg.camstack !== null &&
      'addons' in pkg.camstack
    if (!isWrapper && !isAddon) continue
    const parsed = PackageRequiresSchema.safeParse(pkg.camstack?.['requires'])
    if (!parsed.success || parsed.data.server === undefined) {
      problems.push(`${pkg.dir} (${pkg.name}) declares no camstack.requires.server`)
    }
  }
  return problems
}

function readPackages(): readonly PackageFacts[] {
  const out: PackageFacts[] = []
  for (const root of ['packages', 'server']) {
    if (!existsSync(path.join(ROOT, root))) continue
    for (const entry of readdirSync(path.join(ROOT, root), { withFileTypes: true })) {
      const file = path.join(ROOT, root, entry.name, 'package.json')
      if (!entry.isDirectory() || !existsSync(file)) continue
      const raw: unknown = JSON.parse(readFileSync(file, 'utf-8'))
      if (typeof raw !== 'object' || raw === null) continue
      const rec = raw as Record<string, unknown>
      const camstack = rec['camstack']
      out.push({
        dir: `${root}/${entry.name}`,
        name: typeof rec['name'] === 'string' ? rec['name'] : entry.name,
        private: rec['private'] === true,
        camstack:
          typeof camstack === 'object' && camstack !== null
            ? (camstack as Record<string, unknown>)
            : null,
      })
    }
  }
  return out
}

function main(): void {
  const packages = readPackages()
  const problems = missingDeclarations(packages)
  if (problems.length === 0) {
    console.log(
      `check-requires-declared: ${packages.length} packages, every addon and wrapper declares its server`,
    )
    return
  }
  console.error('check-requires-declared: FAILED (D988)')
  for (const p of problems) console.error(`  ${p}`)
  console.error(
    '  Declare camstack.requires.server in the package.json (addons are re-stamped at publish).',
  )
  process.exit(1)
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main()
}
